import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  FilePartInput,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session,
  TextPartInput,
} from '@opencode-ai/sdk/v2';
import type { AppConfig } from '../config.js';
import type { TelegramMessagingPort, InlineKeyboard } from '../channels/telegram/telegram_messaging_port.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { AppLocale, ChatSessionSettings } from '../types.js';
import {
  TELEGRAM_VOICE_MAX_BYTES,
  TELEGRAM_VOICE_SUPPORTED_EXTENSIONS,
  telegramVoiceContentType,
} from '../voice/files.js';
import { synthesizeTelegramVoice } from '../voice/tts.js';
import { parseCommand } from '../controller/commands.js';
import { normalizeLocale } from '../i18n.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../telegram/addressing.js';
import type { TelegramCallbackEvent, TelegramGateway, TelegramTextEvent } from '../telegram/gateway.js';
import {
  buildAttachmentPrompt,
  isNativeImageAttachment,
  planAttachmentStoragePath,
  TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
  type StagedTelegramAttachment,
  type TelegramInboundAttachment,
} from '../telegram/media.js';
import { chunkTelegramMessage, chunkTelegramStreamMessage } from '../telegram/text.js';
import type { OpencodeAppClient } from './client.js';
import { formatSdkError } from './client.js';
import type { OpencodeBridgeEvent, OpencodeTextEvent, OpencodeToolEvent } from './events.js';

const STREAM_THROTTLE_MS = 700;
const TOOL_THROTTLE_MS = 600;
const THREAD_LIST_LIMIT = 10;
const SETUP_CALLBACK_PREFIX = 'oc:s:';
const PERMISSION_CALLBACK_PREFIX = 'oc:p:';
const QUESTION_CALLBACK_PREFIX = 'oc:q:';

interface ActiveTurn {
  sessionId: string;
  cwd: string;
  parts: Map<string, string>;
  messageIds: number[];
  renderedChunks: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<void>;
  lastFlush: number;
  toolMessageId: number | null;
  toolLines: Map<string, string>;
  toolTimer: ReturnType<typeof setTimeout> | null;
  toolPromise: Promise<void>;
}

interface WatchState {
  sessionId: string;
  cwd: string;
  parts: Map<string, string>;
  messageIds: number[];
  renderedChunks: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<void>;
  lastFlush: number;
}

interface QueuedPrompt {
  event: TelegramTextEvent;
  text: string;
  locale: AppLocale;
}

interface PendingPermissionUi {
  key: string;
  scopeId: string;
  cwd: string;
  request: PermissionRequest;
  messageId: number;
}

interface PendingQuestionUi {
  key: string;
  scopeId: string;
  cwd: string;
  request: QuestionRequest;
  messageIds: number[];
  answers: string[][];
}

interface SetupAction {
  scopeId: string;
  kind: 'setup' | 'models' | 'provider' | 'model' | 'variant' | 'access' | 'mode' | 'agent' | 'active' | 'notice' | 'open' | 'watch';
  value: string;
  origin?: 'models' | 'setup';
}

interface ModelChoice {
  providerId: string;
  modelId: string;
  name: string;
  variants: string[];
}

interface ProviderChoice {
  providerId: string;
  name: string;
  defaultModelId: string | null;
  models: ModelChoice[];
}

interface OpencodePrefs {
  agent: string | null;
  variant: string | null;
}

const UNSUPPORTED_COMMANDS = new Set([
  'account', 'auth_reload', 'codex_restart',
  'goal', 'goal_clear', 'goal_done', 'goal_pause', 'goal_resume', 'login',
  'login_cancel', 'login_device', 'logout', 'plugin', 'plugin_skill', 'quota',
  'remote', 'requirements', 'service_tier', 'update',
]);

/** Telegram-facing OpenCode runtime. It shares FoxClaw's gateway/store/rendering primitives. */
export class OpencodeBridgeCore {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly watchers = new Map<string, WatchState>();
  private readonly queuedPrompts = new Map<string, QueuedPrompt[]>();
  private readonly permissions = new Map<string, PendingPermissionUi>();
  private readonly questions = new Map<string, PendingQuestionUi>();
  private readonly setupActions = new Map<string, SetupAction>();
  private readonly latestVoiceText = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly finishingSessions = new Map<string, Promise<void>>();
  private readonly handlingPermissionIds = new Set<string>();
  private readonly handlingQuestionIds = new Set<string>();
  private disconnectCleanup: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: BridgeStore,
    private readonly logger: Logger,
    private readonly bot: TelegramGateway,
    private readonly app: OpencodeAppClient,
    private readonly messaging: TelegramMessagingPort,
  ) {}

  registerInboundHandlers(): void {
    this.bot.on('text', (event: TelegramTextEvent) => {
      void this.withLock(event.scopeId, () => this.handleText(event)).catch((error) => this.reportError(event.scopeId, error));
    });
    this.bot.on('callback', (event: TelegramCallbackEvent) => {
      void this.withLock(event.scopeId, () => this.handleCallback(event)).catch((error) => this.reportError(event.scopeId, error));
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.app.on('event', (event) => {
      void this.handleAppEvent(event).catch((error) => this.reportError(null, error));
    });
    this.app.on('disconnected', (detail) => {
      this.logger.warn('opencode.disconnected', detail);
      this.disconnectCleanup = this.cleanupAfterDisconnect();
    });
    this.app.on('connected', () => {
      const cleanup = this.disconnectCleanup;
      if (!cleanup) return;
      this.disconnectCleanup = null;
      void this.recoverAfterReconnect(cleanup).catch((error) => this.reportError(null, error));
    });
    try {
      await this.app.start();
      await this.app.recoverPendingRequests(this.store.listBindings()
        .filter((binding) => this.isOwnScope(binding.chatId))
        .flatMap((binding) => binding.cwd ? [binding.cwd] : []));
      await this.bot.start();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.bot.stop();
    for (const turn of this.activeTurns.values()) this.clearTurnTimers(turn);
    for (const watch of this.watchers.values()) {
      if (watch.flushTimer) clearTimeout(watch.flushTimer);
    }
    this.activeTurns.clear();
    this.watchers.clear();
    this.queuedPrompts.clear();
    this.setupActions.clear();
    this.latestVoiceText.clear();
    this.finishingSessions.clear();
    this.handlingPermissionIds.clear();
    this.handlingQuestionIds.clear();
    this.disconnectCleanup = null;
    await this.app.stop({ terminateServer: true });
    this.started = false;
  }

  get isRunning(): boolean {
    return this.started;
  }

  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  getRuntimeStatus(): {
    connected: boolean;
    activeTurns: number;
    botUsername: string | null;
    server: ReturnType<OpencodeAppClient['getServerStatus']>;
  } {
    return {
      connected: this.app.isConnected(),
      activeTurns: this.activeTurns.size,
      botUsername: this.bot.username,
      server: this.app.getServerStatus(),
    };
  }

  private withLock<T>(scopeId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(scopeId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(scopeId, next.then(() => undefined, () => undefined));
    return next;
  }

  private async reportError(scopeId: string | null, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error('opencode.bridge_error', { scopeId, error: message });
    if (scopeId) await this.send(scopeId, `⚠️ ${message}`).catch(() => {});
  }

  private unsupportedCommandMessage(name: string, locale: AppLocale): string {
    if (name === 'update') return localize(locale,
      '/update 当前只由 Codex runtime 的升级协调器执行，避免双 Bot 同时重启服务。请在 Codex Bot 使用 /update，或在终端运行 foxclaw update。',
      '/update is currently owned by the Codex runtime update coordinator to prevent both bots restarting the service. Use /update in the Codex bot or run foxclaw update in a terminal.');
    if (['account', 'quota', 'login', 'login_cancel', 'login_device', 'logout', 'auth_reload', 'codex_restart'].includes(name)) {
      return localize(locale,
        `/${name} 依赖 Codex 账户、配额或设备登录协议；OpenCode serve 没有对应 API。Provider 状态可用 /auth 查看，登录与切换请在终端运行 opencode auth。`,
        `/${name} depends on Codex account, quota, or device-login protocols, which OpenCode serve does not expose. Use /auth for provider status and opencode auth in a terminal to sign in or switch.`);
    }
    if (name.startsWith('goal')) return localize(locale,
      `/${name} 依赖 Codex 的持久 Goal 原语；OpenCode session 没有等价状态机。`,
      `/${name} depends on Codex's persistent Goal primitive; OpenCode sessions have no equivalent state machine.`);
    if (name === 'remote') return localize(locale,
      '/remote 是 Codex Remote 会话协议，OpenCode serve 没有等价端点。',
      '/remote is a Codex Remote session protocol; OpenCode serve has no equivalent endpoint.');
    return localize(locale,
      `/${name} 在 OpenCode serve 上没有可保持语义的等价 API。`,
      `/${name} has no semantics-preserving equivalent in OpenCode serve.`);
  }

  private localeForScope(scopeId: string, languageCode?: string): AppLocale {
    const detected = normalizeLocale(languageCode);
    const current = this.store.getChatSettings(scopeId)?.locale;
    if (languageCode && current !== detected) this.store.setChatLocale(scopeId, detected);
    return languageCode ? detected : current ?? 'zh';
  }

  private async handleText(event: TelegramTextEvent): Promise<void> {
    const command = event.attachments.length === 0 ? parseCommand(event.text) : null;
    const decision = resolveTelegramAddressing({
      text: event.text,
      attachmentsCount: event.attachments.length,
      entities: event.entities,
      command,
      botUsername: this.bot.username,
      isDefaultTopic: isDefaultTelegramScope({
        chatType: event.chatType,
        allowedChatId: this.config.tgAllowedChatId,
        allowedTopicId: this.config.tgAllowedTopicId,
        topicId: event.topicId,
        requireExplicitGroupAddressing: this.config.tgRequireExplicitGroupAddressing,
      }),
      replyToBot: event.replyToBot,
    });
    if (decision.kind === 'ignore') return;
    const locale = this.localeForScope(event.scopeId, event.languageCode);
    if (decision.kind === 'command') {
      await this.handleCommand(event, decision.command.name, decision.command.args, locale);
      return;
    }
    await this.dispatchPrompt(event, decision.text, locale);
  }

  private async handleCommand(event: TelegramTextEvent, name: string, args: string[], locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    if (UNSUPPORTED_COMMANDS.has(name)) {
      await this.send(scopeId, this.unsupportedCommandMessage(name, locale));
      return;
    }
    switch (name) {
      case 'start':
      case 'help': await this.showHelp(scopeId, locale); return;
      case 'new': await this.createAndBind(scopeId, args.join(' ').trim() || null, locale); return;
      case 'threads': await this.showThreads(scopeId, args.join(' ').trim(), locale); return;
      case 'open': await this.openSession(scopeId, args[0] ?? '', locale); return;
      case 'watch': await this.watchSession(scopeId, args[0] ?? '', locale); return;
      case 'unwatch': await this.unwatchSession(scopeId, locale); return;
      case 'status': await this.showStatus(scopeId, locale); return;
      case 'setup': await this.showSetup(scopeId, locale); return;
      case 'models': await this.showModels(scopeId, args.join(' ').trim(), locale); return;
      case 'model': await this.setModel(scopeId, args.join(' ').trim(), locale); return;
      case 'effort': await this.setVariant(scopeId, args.join(' ').trim(), locale); return;
      case 'mode': await this.setMode(scopeId, args[0] ?? '', locale); return;
      case 'plan': await this.setMode(scopeId, 'plan', locale); return;
      case 'agent': await this.setAgent(scopeId, args.join(' ').trim(), locale); return;
      case 'permissions':
      case 'access': await this.setAccess(scopeId, args.join(' ').trim(), locale); return;
      case 'active': await this.setActiveMode(scopeId, args[0] ?? '', locale); return;
      case 'steer': await this.sendWithBehavior(event, args.join(' ').trim(), locale, 'steer'); return;
      case 'queue': await this.sendWithBehavior(event, args.join(' ').trim(), locale, 'queue'); return;
      case 'takeover': await this.takeOver(event, args.join(' ').trim(), locale); return;
      case 'history': await this.showHistory(scopeId, args[0] ?? '', locale); return;
      case 'rename': await this.renameSession(scopeId, args.join(' ').trim(), locale); return;
      case 'fork': await this.forkSession(scopeId, args.join(' ').trim(), locale); return;
      case 'undo':
      case 'rollback': await this.undoSession(scopeId, args[0] ?? '', locale); return;
      case 'redo': await this.redoSession(scopeId, locale); return;
      case 'diff': await this.showDiff(scopeId, locale); return;
      case 'where': await this.showWhere(scopeId, locale); return;
      case 'reveal': await this.showWhere(scopeId, locale); return;
      case 'files': await this.findFiles(scopeId, args.join(' ').trim(), locale); return;
      case 'compact': await this.compactSession(scopeId, locale); return;
      case 'loaded': await this.showLoaded(scopeId, locale); return;
      case 'skills': await this.showSkills(scopeId, locale); return;
      case 'mcp': await this.showMcp(scopeId, locale); return;
      case 'apps': await this.showMcp(scopeId, locale, true); return;
      case 'provider': await this.showProviders(scopeId, locale); return;
      case 'auth': await this.showAuth(scopeId, locale); return;
      case 'plugins': await this.showPlugins(scopeId, locale, false); return;
      case 'hooks': await this.showPlugins(scopeId, locale, true); return;
      case 'features': await this.showFeatures(scopeId, locale); return;
      case 'config': await this.showConfig(scopeId, locale); return;
      case 'archive': await this.archiveBoundSession(scopeId, locale); return;
      case 'unarchive':
      case 'thread_unarchive': await this.unarchiveSession(scopeId, args[0] ?? '', locale); return;
      case 'thread_archive': await this.archiveCachedSession(scopeId, args[0] ?? '', locale); return;
      case 'review': await this.runReview(event, args.join(' ').trim(), locale); return;
      case 'rich': await this.showRichDemo(scopeId, locale); return;
      case 'voice': await this.handleVoiceCommand(scopeId, args, locale); return;
      case 'fast': await this.showFastUnsupported(scopeId, locale); return;
      case 'approve': await this.approveFromCommand(scopeId, args, locale); return;
      case 'answer': await this.answerFromCommand(scopeId, args, locale); return;
      case 'abort':
      case 'interrupt':
      case 'stop': await this.abort(scopeId, locale); return;
      default:
        await this.send(scopeId, localize(locale, `未知命令：/${name}。发送 /help 查看列表。`, `Unknown command: /${name}. Send /help.`));
    }
  }

  private async showHelp(scopeId: string, locale: AppLocale): Promise<void> {
    const zh = [
      '⚡ OpenCode 桥接命令', '',
      '/new [目录] · 新建会话', '/threads [关键词|archived] · 最近或归档会话', '/open <编号|ID> · 打开会话',
      '/watch [编号|ID] · 观察会话', '/unwatch · 停止观察', '/setup · 设置面板',
      '/models [provider] · Provider → Model 两层选择', '/model <provider/model|default> · 选择模型', '/effort <variant|default> · 推理档位',
      '/fast · 说明 OpenCode 与 Codex Fast 的能力差异', '/mode <default|plan> · 模式', '/plan · 下一轮 Plan', '/agent [名称] · Agent',
      '/permissions <read-only|default|full-access> · 权限', '/active <steer|queue> · 运行中新消息',
      '/steer <消息> · 引导当前回复', '/queue <消息> · 排队下一轮', '/takeover <消息> · 中断并接管',
      '/history [数量] · 历史', '/rename <名称> · 重命名', '/fork [名称] · 分叉', '/undo [数量] · 原生回退', '/redo · 原生重做',
      '/review [commit|branch|pr] · 原生代码审查', '/archive · 归档当前会话', '/unarchive <编号> · 恢复归档会话', '/diff · 变更',
      '/where · 当前目录', '/files <关键词> · 文件搜索', '/compact · 压缩上下文', '/loaded · 活跃会话',
      '/skills · Skills', '/mcp · MCP 状态', '/apps · MCP 应用', '/provider · Provider', '/auth · Provider 认证状态',
      '/plugins · Plugins', '/hooks · Plugin hooks', '/features · 实验能力', '/config · 配置摘要',
      '/approve · 待审批', '/answer · 待回答', '/rich · 富文本测试', '/voice <文本|last|file> · 语音', '/interrupt · 中断', '/status · 状态', '',
      '直接发送文本、图片或文件会继续当前会话；没有绑定时会自动新建。',
      'Codex 账户、配额、Goal、Remote 没有 OpenCode serve 等价 API；Provider 登录请在终端运行 opencode auth。',
    ].join('\n');
    const en = [
      '⚡ OpenCode bridge commands', '',
      '/new [dir] · new session', '/threads [query|archived] · recent or archived sessions', '/open <number|ID> · bind session',
      '/watch [number|ID] · watch session', '/unwatch · stop watching', '/setup · settings panel',
      '/models [provider] · Provider → Model selector', '/model <provider/model|default> · select model', '/effort <variant|default> · reasoning variant',
      '/fast · explain the OpenCode/Codex Fast capability difference', '/mode <default|plan> · mode', '/plan · Plan next turn', '/agent [name] · agent',
      '/permissions <read-only|default|full-access> · access', '/active <steer|queue> · messages during a turn',
      '/steer <message> · steer active turn', '/queue <message> · queue next turn', '/takeover <message> · interrupt and take over',
      '/history [n] · history', '/rename <name> · rename', '/fork [name] · fork', '/undo [n] · native undo', '/redo · native redo',
      '/review [commit|branch|pr] · native review', '/archive · archive current session', '/unarchive <number> · restore archive', '/diff · changes',
      '/where · directory', '/files <query> · find files', '/compact · compact context', '/loaded · active sessions',
      '/skills · skills', '/mcp · MCP status', '/apps · MCP apps', '/provider · providers', '/auth · provider auth status',
      '/plugins · plugins', '/hooks · plugin hooks', '/features · experimental capabilities', '/config · config summary',
      '/approve · approvals', '/answer · questions', '/rich · rich-text test', '/voice <text|last|file> · voice', '/interrupt · abort', '/status · status', '',
      'Plain text, images, and files continue the bound session, creating one when needed.',
      'Codex account, quota, Goal, and Remote have no OpenCode serve API equivalents; run opencode auth in a terminal for provider login.',
    ].join('\n');
    await this.send(scopeId, localize(locale, zh, en));
  }

  private async createAndBind(scopeId: string, requestedCwd: string | null, locale: AppLocale): Promise<Session> {
    const cwd = requestedCwd ? path.resolve(requestedCwd) : this.config.defaultCwd;
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(localize(locale, `目录不存在：${cwd}`, `Directory does not exist: ${cwd}`));
    const settings = this.store.getChatSettings(scopeId);
    const model = settings?.model ? parseStoredModel(settings.model) : null;
    const prefs = readPrefs(settings);
    const agent = prefs.agent;
    const response = await this.app.getClient().session.create({
      directory: cwd,
      ...(model ? { model: { id: model.modelId, providerID: model.providerId, ...(prefs.variant ? { variant: prefs.variant } : {}) } } : {}),
      ...(agent ? { agent } : {}),
      permission: permissionRules(settings?.accessPreset ?? 'default'),
    });
    const session = unwrap(response, 'session.create');
    this.store.setBinding(scopeId, session.id, session.directory || cwd);
    await this.send(scopeId, localize(locale,
      `✅ 已新建 OpenCode 会话\n${session.title}\n\`${session.id}\`\n目录：\`${session.directory || cwd}\``,
      `✅ OpenCode session created\n${session.title}\n\`${session.id}\`\nDirectory: \`${session.directory || cwd}\``));
    return session;
  }

  private async showThreads(scopeId: string, search: string, locale: AppLocale): Promise<void> {
    const archived = /^archived(?:\s|$)/i.test(search);
    const query = archived ? search.replace(/^archived\s*/i, '').trim() : search;
    const response = await this.app.getClient().experimental.session.list({
      ...(query ? { search: query } : {}),
      ...(archived ? { archived: true } : {}),
      limit: Math.max(THREAD_LIST_LIMIT, this.config.threadListLimit),
    });
    const sessions = unwrap(response, 'session.list').filter((session) => archived ? Boolean(session.time.archived) : !session.time.archived);
    if (sessions.length === 0) {
      await this.send(scopeId, localize(locale, '没有匹配的 OpenCode 会话。', 'No matching OpenCode sessions.'));
      return;
    }
    const statuses = await this.statusesForSessions(sessions);
    this.store.cacheThreadList(scopeId, sessions.map((session) => ({
      threadId: session.id,
      name: session.title || null,
      preview: session.title || session.slug,
      cwd: session.directory,
      modelProvider: session.model ? `${session.model.providerID}/${session.model.id}` : null,
      status: statuses[session.id]?.type === 'busy' ? 'active' : 'idle',
      archived,
      updatedAt: session.time.updated,
    })));
    const bound = this.store.getBinding(scopeId)?.threadId;
    const lines = [archived ? localize(locale, 'OpenCode 已归档会话：', 'Archived OpenCode sessions:') : localize(locale, 'OpenCode 会话：', 'OpenCode sessions:'), ''];
    sessions.forEach((session, index) => {
      const marker = session.id === bound ? '●' : statuses[session.id]?.type === 'busy' ? '◐' : '○';
      lines.push(`${marker} ${index + 1}. ${session.title || session.slug}`);
      lines.push(`   \`${shortId(session.id)}\` · \`${session.directory}\` · ${formatAge(session.time.updated, locale)}`);
    });
    lines.push('', archived
      ? localize(locale, '使用 /unarchive <编号> 恢复。', 'Use /unarchive <number> to restore.')
      : localize(locale, '使用 /open <编号> 打开；/threads archived 查看归档。', 'Use /open <number> to bind; /threads archived lists archives.'));
    const keyboard = archived ? undefined : this.setupKeyboard(sessions.slice(0, 10).map((session, index) => [
      { label: `${index + 1}. ${clip(session.title || session.slug, 30)}`, action: { scopeId, kind: 'open' as const, value: session.id } },
      { label: '👁', action: { scopeId, kind: 'watch' as const, value: session.id } },
    ]));
    await this.messaging.sendPlain(scopeId, lines.join('\n'), keyboard);
  }

  private async resolveSessionTarget(scopeId: string, raw: string): Promise<Session | null> {
    const value = raw.trim();
    if (!value) {
      const binding = this.store.getBinding(scopeId);
      if (!binding) return null;
      const response = await this.app.getClient().session.get({
        sessionID: binding.threadId,
        ...(binding.cwd ? { directory: binding.cwd } : {}),
      });
      return response.error ? null : response.data ?? null;
    }
    const index = Number.parseInt(value, 10);
    if (/^\d+$/.test(value) && index > 0) {
      const cached = this.store.getCachedThread(scopeId, index);
      if (!cached) return null;
      const response = await this.app.getClient().session.get({
        sessionID: cached.threadId,
        ...(cached.cwd ? { directory: cached.cwd } : {}),
      });
      return response.error ? null : response.data ?? null;
    }
    const listed = await this.app.getClient().experimental.session.list({ limit: 100 });
    if (listed.error) return null;
    const candidates = (listed.data ?? []).filter((session) => session.id === value || session.id.startsWith(value));
    return candidates.length === 1 ? candidates[0]! : null;
  }

  private async openSession(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    if (!raw) {
      await this.send(scopeId, localize(locale, '用法：/open <编号|会话ID>', 'Usage: /open <number|session-id>'));
      return;
    }
    const session = await this.resolveSessionTarget(scopeId, raw);
    if (!session) throw new Error(localize(locale, `找不到唯一会话：${raw}`, `Could not resolve one session: ${raw}`));
    if (session.time.archived) throw new Error(localize(locale,
      '该会话已归档。先用 /threads archived，再用 /unarchive <编号>。',
      'That session is archived. Use /threads archived, then /unarchive <number>.'));
    const access = this.store.getChatSettings(scopeId)?.accessPreset ?? 'default';
    unwrap(await this.app.getClient().session.update({
      sessionID: session.id,
      directory: session.directory,
      permission: permissionRules(access),
    }), 'session.update');
    this.store.setBinding(scopeId, session.id, session.directory);
    await this.send(scopeId, localize(locale,
      `✅ 已打开：${session.title}\n\`${session.id}\`\n目录：\`${session.directory}\``,
      `✅ Bound: ${session.title}\n\`${session.id}\`\nDirectory: \`${session.directory}\``));
  }

  private async watchSession(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    const session = await this.resolveSessionTarget(scopeId, raw);
    if (!session) {
      await this.send(scopeId, localize(locale, '没有可观察的会话。先用 /threads。', 'No session to watch. Use /threads first.'));
      return;
    }
    const current = this.watchers.get(scopeId);
    if (current?.flushTimer) clearTimeout(current.flushTimer);
    this.watchers.set(scopeId, {
      sessionId: session.id,
      cwd: session.directory,
      parts: new Map(),
      messageIds: [],
      renderedChunks: [],
      flushTimer: null,
      flushPromise: Promise.resolve(),
      lastFlush: 0,
    });
    await this.send(scopeId, localize(locale, `👁 正在观察：${session.title}\n\`${session.id}\``, `👁 Watching: ${session.title}\n\`${session.id}\``));
  }

  private async unwatchSession(scopeId: string, locale: AppLocale): Promise<void> {
    const watch = this.watchers.get(scopeId);
    if (watch?.flushTimer) clearTimeout(watch.flushTimer);
    this.watchers.delete(scopeId);
    await this.send(scopeId, localize(locale, watch ? '已停止观察。' : '当前没有观察会话。', watch ? 'Stopped watching.' : 'No watched session.'));
  }

  private async showStatus(scopeId: string, locale: AppLocale): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);
    const status = this.app.getServerStatus();
    const turn = this.activeTurns.get(scopeId);
    const prefs = readPrefs(settings);
    const lines = [
      `OpenCode serve: ${status.connected ? '✅' : '❌'} ${status.version ?? ''}`.trim(),
      `${localize(locale, '进程', 'Process')}: ${status.pid ?? '—'} · ${status.url ?? '—'}`,
      `${localize(locale, '会话', 'Session')}: ${binding ? `\`${binding.threadId}\`` : localize(locale, '无', 'none')}`,
      `${localize(locale, '目录', 'Directory')}: ${binding?.cwd ? `\`${binding.cwd}\`` : '—'}`,
      `${localize(locale, '模型', 'Model')}: ${formatStoredModel(settings?.model, locale)}`,
      `${localize(locale, '档位', 'Variant')}: ${prefs.variant ?? localize(locale, '默认', 'default')}`,
      `${localize(locale, 'Agent', 'Agent')}: ${settings?.collaborationMode === 'plan' ? 'plan' : prefs.agent ?? 'build'}`,
      `${localize(locale, '权限', 'Access')}: ${settings?.accessPreset ?? 'default'}`,
      `${localize(locale, '运行中新消息', 'Active messages')}: ${settings?.activeTurnMessageMode ?? 'steer'}`,
      `${localize(locale, '回复', 'Turn')}: ${turn ? '⏳' : 'idle'} · ${localize(locale, '排队', 'queued')} ${this.queuedPrompts.get(scopeId)?.length ?? 0}`,
    ];
    await this.send(scopeId, lines.join('\n'));
  }

  private async showSetup(scopeId: string, locale: AppLocale, messageId?: number): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const prefs = readPrefs(settings);
    const [providers, agentsResponse] = await Promise.all([
      this.listProviders(this.store.getBinding(scopeId)?.cwd),
      this.app.getClient().app.agents({ directory: this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd }),
    ]);
    const models = providers.flatMap((provider) => provider.models);
    const selectedModel = settings?.model ? parseStoredModel(settings.model) : null;
    const model = selectedModel
      ? models.find((item) => item.providerId === selectedModel.providerId && item.modelId === selectedModel.modelId)
      : providers.map((provider) => provider.models.find((item) => item.modelId === provider.defaultModelId)).find(Boolean) ?? null;
    const variants = model?.variants ?? [];
    const agents = unwrap(agentsResponse, 'agent.list').filter((agent) => !agent.hidden && agent.mode !== 'subagent');
    const access = settings?.accessPreset ?? 'default';
    const activeMode = settings?.activeTurnMessageMode ?? 'steer';
    const collaborationMode = settings?.collaborationMode ?? 'default';
    const currentAgent = collaborationMode === 'plan' ? 'plan' : prefs.agent ?? 'build';
    const displayModel = formatStoredModel(settings?.model, locale);
    const displayVariant = prefs.variant ?? localize(locale, '自动', 'Auto');
    const text = localize(locale,
      `⚙️ OpenCode 设置\n当前：${displayModel} · ${displayVariant} · ${currentAgent} · ${access}\n\n模型：${displayModel}\n推理档位：${displayVariant}\nFast：OpenCode serve 没有 Codex service tier 等价项\nAgent：${currentAgent}\n权限：${access}\n运行中新消息：${activeMode}`,
      `⚙️ OpenCode settings\nCurrent: ${displayModel} · ${displayVariant} · ${currentAgent} · ${access}\n\nModel: ${displayModel}\nReasoning variant: ${displayVariant}\nFast: OpenCode serve has no Codex service-tier equivalent\nAgent: ${currentAgent}\nAccess: ${access}\nActive messages: ${activeMode}`);

    const actions: Array<Array<{ label: string; action: SetupAction }>> = [
      [{
        label: `🧠 ${localize(locale, '模型', 'Model')} · ${clip(displayModel, 24)}`,
        action: { scopeId, kind: 'models', value: '', origin: 'setup' },
      }],
    ];
    if (variants.length > 0) {
      const variantActions = [
        { label: selectedLabel(prefs.variant === null, localize(locale, '自动', 'Auto')), action: { scopeId, kind: 'variant' as const, value: 'default', origin: 'setup' as const } },
        ...variants.map((variant) => ({
          label: selectedLabel(prefs.variant === variant, variant),
          action: { scopeId, kind: 'variant' as const, value: variant, origin: 'setup' as const },
        })),
      ];
      for (let index = 0; index < variantActions.length; index += 3) actions.push(variantActions.slice(index, index + 3));
    } else {
      actions.push([{
        label: localize(locale, '推理档位：先选择模型', 'Reasoning: choose a model'),
        action: { scopeId, kind: 'models', value: '', origin: 'setup' },
      }]);
    }
    actions.push([
      { label: selectedLabel(access === 'read-only', '🔒 read-only'), action: { scopeId, kind: 'access', value: 'read-only', origin: 'setup' } },
      { label: selectedLabel(access === 'default', '🛂 default'), action: { scopeId, kind: 'access', value: 'default', origin: 'setup' } },
      { label: selectedLabel(access === 'full-access', '🔓 full-access'), action: { scopeId, kind: 'access', value: 'full-access', origin: 'setup' } },
    ]);
    const agentActions = agents.map((agent) => ({
      label: selectedLabel(currentAgent === agent.name, agent.name === 'plan' ? '📝 Plan' : `🤖 ${agent.name}`),
      action: {
        scopeId,
        kind: agent.name === 'plan' ? 'mode' as const : 'agent' as const,
        value: agent.name === 'plan' ? 'plan' : agent.name,
        origin: 'setup' as const,
      },
    }));
    for (let index = 0; index < agentActions.length; index += 3) actions.push(agentActions.slice(index, index + 3));
    actions.push([
      { label: selectedLabel(activeMode === 'steer', localize(locale, '引导当前回复', 'Steer current turn')), action: { scopeId, kind: 'active', value: 'steer', origin: 'setup' } },
      { label: selectedLabel(activeMode === 'queue', localize(locale, '排队到下一轮', 'Queue next turn')), action: { scopeId, kind: 'active', value: 'queue', origin: 'setup' } },
    ]);
    actions.push([{
      label: localize(locale, 'Fast 无等价项', 'Fast unsupported'),
      action: { scopeId, kind: 'notice', value: 'fast', origin: 'setup' },
    }]);
    await this.sendOrEditPanel(scopeId, text, this.setupKeyboard(actions), messageId);
  }

  private setupKeyboard(rows: Array<Array<{ label: string; action: SetupAction }>>): InlineKeyboard {
    const keyboard = rows.map((row) => row.map((entry) => {
      const key = randomKey();
      this.setupActions.set(key, entry.action);
      return { text: entry.label, callback_data: `${SETUP_CALLBACK_PREFIX}${key}` };
    }));
    while (this.setupActions.size > 2_000) {
      const oldest = this.setupActions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.setupActions.delete(oldest);
    }
    return keyboard;
  }

  private async sendOrEditPanel(scopeId: string, text: string, keyboard: InlineKeyboard, messageId?: number): Promise<void> {
    if (messageId === undefined) await this.messaging.sendPlain(scopeId, text, keyboard);
    else await this.messaging.editPlain(scopeId, messageId, text, keyboard);
  }

  private async listProviders(cwd?: string | null): Promise<ProviderChoice[]> {
    const response = await this.app.getClient().provider.list({ ...(cwd ? { directory: cwd } : {}) });
    const data = unwrap(response, 'provider.list');
    return data.connected.flatMap((providerId) => {
      const provider = data.all.find((item) => item.id === providerId);
      if (!provider) return [];
      const models = Object.values(provider.models).map((model) => ({
        providerId: provider.id,
        modelId: model.id,
        name: model.name,
        variants: Object.entries(model.variants ?? {}).filter(([, value]) => value.disabled !== true).map(([key]) => key),
      })).sort((a, b) => a.name.localeCompare(b.name));
      return [{ providerId: provider.id, name: provider.name, defaultModelId: data.default[provider.id] ?? null, models }];
    });
  }

  private async listModels(cwd?: string | null): Promise<ModelChoice[]> {
    return (await this.listProviders(cwd)).flatMap((provider) => provider.models);
  }

  private async showModels(
    scopeId: string,
    rawProvider: string,
    locale: AppLocale,
    messageId?: number,
    origin: 'models' | 'setup' = 'models',
  ): Promise<void> {
    const providers = await this.listProviders(this.store.getBinding(scopeId)?.cwd);
    if (providers.length === 0) {
      await this.send(scopeId, localize(locale, '没有已连接 Provider 的模型。请先在终端运行 opencode auth。', 'No models from connected providers. Run opencode auth in a terminal.'));
      return;
    }
    if (!rawProvider) {
      const current = formatStoredModel(this.store.getChatSettings(scopeId)?.model, locale);
      const actions: Array<Array<{ label: string; action: SetupAction }>> = [[{
        label: selectedLabel(!this.store.getChatSettings(scopeId)?.model, localize(locale, '自动 / 服务端默认', 'Auto / server default')),
        action: { scopeId, kind: 'model', value: 'default', origin },
      }]];
      for (const provider of providers) {
        actions.push([{
          label: `${provider.name} · ${provider.models.length}`,
          action: { scopeId, kind: 'provider', value: provider.providerId, origin },
        }]);
      }
      if (origin === 'setup') actions.push([{ label: localize(locale, '← 返回设置', '← Back to settings'), action: { scopeId, kind: 'setup', value: '' } }]);
      const text = [
        localize(locale, '🧠 选择模型 Provider', '🧠 Choose a model provider'),
        `${localize(locale, '当前模型', 'Current model')}：${current}`,
        '',
        ...providers.map((provider, index) => `${index + 1}. ${provider.name} · \`${provider.providerId}\` · ${provider.models.length} models`),
      ].join('\n');
      await this.sendOrEditPanel(scopeId, text, this.setupKeyboard(actions), messageId);
      return;
    }
    const normalized = rawProvider.toLowerCase();
    const provider = providers.find((item) => item.providerId.toLowerCase() === normalized || item.name.toLowerCase() === normalized);
    if (!provider) throw new Error(localize(locale, `未知 Provider：${rawProvider}`, `Unknown provider: ${rawProvider}`));
    const stored = this.store.getChatSettings(scopeId)?.model;
    const selected = stored ? parseStoredModel(stored) : null;
    const entries = provider.models.map((model) => ({
      label: selectedLabel(selected?.providerId === model.providerId && selected.modelId === model.modelId, clip(model.name, 26)),
      action: { scopeId, kind: 'model' as const, value: storeModel(model.providerId, model.modelId), origin },
    }));
    const actions: Array<Array<{ label: string; action: SetupAction }>> = [];
    for (let index = 0; index < entries.length; index += 2) actions.push(entries.slice(index, index + 2));
    actions.push([{
      label: localize(locale, '← Provider', '← Providers'),
      action: { scopeId, kind: 'models', value: '', origin },
    }]);
    const text = [
      `🧠 ${provider.name}`,
      `\`${provider.providerId}\` · ${provider.models.length} models`,
      `${localize(locale, '当前模型', 'Current model')}：${formatStoredModel(stored, locale)}`,
      '',
      localize(locale, '选择一个模型：', 'Choose a model:'),
    ].join('\n');
    await this.sendOrEditPanel(scopeId, text, this.setupKeyboard(actions), messageId);
  }

  private async setModel(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    if (!raw) { await this.showModels(scopeId, '', locale); return; }
    if (raw === 'default' || raw === 'reset') {
      const settings = this.store.getChatSettings(scopeId);
      this.store.setChatSettings(scopeId, null, settings?.reasoningEffort ?? null);
      this.writePrefs(scopeId, { ...readPrefs(settings), variant: null });
      await this.send(scopeId, localize(locale, '模型已恢复服务端默认。', 'Model reset to server default.'));
      return;
    }
    const models = await this.listModels(this.store.getBinding(scopeId)?.cwd);
    const index = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) - 1 : -1;
    const normalized = raw.replace(/^`|`$/g, '');
    const model = index >= 0 ? models[index] : models.find((item) =>
      `${item.providerId}/${item.modelId}` === normalized || item.modelId === normalized || storeModel(item.providerId, item.modelId) === normalized);
    if (!model) throw new Error(localize(locale, `未知模型：${raw}`, `Unknown model: ${raw}`));
    this.store.setChatSettings(scopeId, storeModel(model.providerId, model.modelId), null);
    const prefs = readPrefs(this.store.getChatSettings(scopeId));
    if (prefs.variant && !model.variants.includes(prefs.variant)) this.writePrefs(scopeId, { ...prefs, variant: null });
    await this.send(scopeId, localize(locale, `模型 → \`${model.providerId}/${model.modelId}\``, `Model → \`${model.providerId}/${model.modelId}\``));
  }

  private async setVariant(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const prefs = readPrefs(settings);
    const model = settings?.model ? parseStoredModel(settings.model) : null;
    if (!raw) {
      await this.showSetup(scopeId, locale);
      return;
    }
    if (raw === 'default' || raw === 'reset' || raw === 'none') {
      this.writePrefs(scopeId, { ...prefs, variant: null });
      await this.send(scopeId, localize(locale, 'Variant 已恢复默认。', 'Variant reset to default.'));
      return;
    }
    if (!model) throw new Error(localize(locale, '先用 /model 选择模型。', 'Choose a model first with /model.'));
    const choices = await this.listModels(this.store.getBinding(scopeId)?.cwd);
    const selected = choices.find((item) => item.providerId === model.providerId && item.modelId === model.modelId);
    if (!selected?.variants.includes(raw)) throw new Error(localize(locale, `当前模型不支持 variant：${raw}`, `Selected model does not support variant: ${raw}`));
    this.writePrefs(scopeId, { ...prefs, variant: raw });
    await this.send(scopeId, `Variant → \`${raw}\``);
  }

  private async setMode(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    if (!raw) {
      await this.showSetup(scopeId, locale);
      return;
    }
    if (raw !== 'default' && raw !== 'plan') throw new Error(localize(locale, '用法：/mode <default|plan>', 'Usage: /mode <default|plan>'));
    this.store.setChatCollaborationMode(scopeId, raw);
    await this.send(scopeId, raw === 'plan'
      ? localize(locale, '📝 下一轮将使用 OpenCode Plan Agent，发送后自动回到 Agent。', '📝 OpenCode Plan Agent is armed for the next turn, then returns to Agent.')
      : localize(locale, '🤖 已切回 Agent。', '🤖 Switched back to Agent.'));
  }

  private async setAgent(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const prefs = readPrefs(settings);
    if (!raw) {
      this.store.setChatCollaborationMode(scopeId, 'default');
      await this.send(scopeId, localize(locale, `🤖 已切回 Agent：${prefs.agent ?? 'build'}`, `🤖 Switched back to Agent: ${prefs.agent ?? 'build'}`));
      return;
    }
    if (raw === 'default' || raw === 'build') {
      this.writePrefs(scopeId, { ...prefs, agent: raw === 'build' ? 'build' : null });
      this.store.setChatCollaborationMode(scopeId, 'default');
      await this.send(scopeId, localize(locale, 'Agent → build', 'Agent → build'));
      return;
    }
    const response = await this.app.getClient().app.agents({ directory: this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd });
    const agents = unwrap(response, 'agent.list').filter((agent) => !agent.hidden && agent.mode !== 'subagent');
    const match = agents.find((agent) => agent.name === raw);
    if (!match) {
      await this.send(scopeId, localize(locale,
        `未知 Agent：${raw}\n可用：${agents.map((agent) => `\`${agent.name}\``).join('、')}`,
        `Unknown agent: ${raw}\nAvailable: ${agents.map((agent) => `\`${agent.name}\``).join(', ')}`));
      return;
    }
    this.writePrefs(scopeId, { ...prefs, agent: match.name });
    this.store.setChatCollaborationMode(scopeId, 'default');
    await this.send(scopeId, `Agent → \`${match.name}\``);
  }

  private async setAccess(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    if (!raw) {
      await this.showSetup(scopeId, locale);
      return;
    }
    if (raw !== 'read-only' && raw !== 'default' && raw !== 'full-access') {
      throw new Error(localize(locale, '用法：/permissions <read-only|default|full-access>', 'Usage: /permissions <read-only|default|full-access>'));
    }
    await this.applyAccess(scopeId, raw);
    await this.send(scopeId, localize(locale, `权限 → ${raw}`, `Access → ${raw}`));
  }

  private async applyAccess(scopeId: string, access: 'read-only' | 'default' | 'full-access'): Promise<void> {
    this.store.setChatAccessPreset(scopeId, access);
    const binding = this.store.getBinding(scopeId);
    if (binding) {
      const response = await this.app.getClient().session.update({
        sessionID: binding.threadId,
        ...(binding.cwd ? { directory: binding.cwd } : {}),
        permission: permissionRules(access),
      });
      if (response.error) throw new Error(formatSdkError(response.error));
    }
  }

  private async setActiveMode(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    if (!raw) {
      await this.showSetup(scopeId, locale);
      return;
    }
    if (raw !== 'steer' && raw !== 'queue') throw new Error(localize(locale, '用法：/active <steer|queue>', 'Usage: /active <steer|queue>'));
    this.store.setChatActiveTurnMessageMode(scopeId, raw);
    await this.send(scopeId, localize(locale, `运行中新消息 → ${raw}`, `Active-turn messages → ${raw}`));
  }

  private writePrefs(scopeId: string, prefs: OpencodePrefs): void {
    this.store.setChatServiceTier(scopeId, `opencode:${JSON.stringify(prefs)}`);
  }

  private async sendWithBehavior(
    event: TelegramTextEvent,
    text: string,
    locale: AppLocale,
    behavior: 'steer' | 'queue',
  ): Promise<void> {
    if (!text) throw new Error(localize(locale, `用法：/${behavior} <消息>`, `Usage: /${behavior} <message>`));
    await this.dispatchPrompt(event, text, locale, behavior);
  }

  private async takeOver(event: TelegramTextEvent, text: string, locale: AppLocale): Promise<void> {
    if (!text) throw new Error(localize(locale, '用法：/takeover <消息>', 'Usage: /takeover <message>'));
    const active = this.activeTurns.get(event.scopeId);
    if (!active) {
      await this.dispatchPrompt(event, text, locale, 'steer');
      return;
    }
    const queue = this.queuedPrompts.get(event.scopeId) ?? [];
    queue.unshift({ event, text, locale });
    this.queuedPrompts.set(event.scopeId, queue);
    const response = await this.app.getClient().session.abort({ sessionID: active.sessionId, directory: active.cwd });
    if (response.error) {
      queue.shift();
      if (queue.length === 0) this.queuedPrompts.delete(event.scopeId);
      throw new Error(formatSdkError(response.error));
    }
    await this.finishSession(active.sessionId);
    await this.send(event.scopeId, localize(locale, '↪️ 已中断并接管当前会话。', '↪️ Interrupted and took over the current session.'));
  }

  private async dispatchPrompt(
    event: TelegramTextEvent,
    text: string,
    locale: AppLocale,
    behavior?: 'steer' | 'queue',
  ): Promise<void> {
    const active = this.activeTurns.get(event.scopeId);
    const activeMode = behavior ?? this.store.getChatSettings(event.scopeId)?.activeTurnMessageMode ?? 'steer';
    if (active && activeMode === 'queue') {
      const queue = this.queuedPrompts.get(event.scopeId) ?? [];
      queue.push({ event, text, locale });
      this.queuedPrompts.set(event.scopeId, queue);
      await this.send(event.scopeId, localize(locale, `⏭ 已排队（${queue.length}）。`, `⏭ Queued (${queue.length}).`));
      return;
    }
    const binding = this.store.getBinding(event.scopeId);
    const session = binding ? await this.resolveSessionTarget(event.scopeId, '') : await this.createAndBind(event.scopeId, null, locale);
    if (!session) throw new Error(localize(locale, '当前 OpenCode 会话不存在，请 /new。', 'The bound OpenCode session no longer exists; use /new.'));
    const cwd = session.directory || binding?.cwd || this.config.defaultCwd;
    const parts = await this.buildPromptParts(event, session.id, cwd, text, locale);
    const settings = this.store.getChatSettings(event.scopeId);
    const prefs = readPrefs(settings);
    const model = settings?.model ? parseStoredModel(settings.model) : null;
    const agent = settings?.collaborationMode === 'plan' ? 'plan' : prefs.agent ?? undefined;
    if (!active) this.startTrackedTurn(event.scopeId, session.id, cwd);
    await this.messaging.sendTypingInScope(event.scopeId);
    const response = await this.app.getClient().session.promptAsync({
      sessionID: session.id,
      directory: cwd,
      parts,
      ...(model ? { model: { providerID: model.providerId, modelID: model.modelId } } : {}),
      ...(prefs.variant ? { variant: prefs.variant } : {}),
      ...(agent ? { agent } : {}),
    });
    if (response.error) {
      if (!active) this.activeTurns.delete(event.scopeId);
      throw new Error(formatSdkError(response.error));
    }
    if (settings?.collaborationMode === 'plan') this.store.setChatCollaborationMode(event.scopeId, 'default');
    this.app.watchSessionUntilIdle(session.id, cwd);
    if (active) await this.send(event.scopeId, localize(locale, '↪️ 已追加到当前 OpenCode 回复。', '↪️ Steered the active OpenCode turn.'));
  }

  private startTrackedTurn(scopeId: string, sessionId: string, cwd: string): ActiveTurn {
    const turn: ActiveTurn = {
      sessionId,
      cwd,
      parts: new Map(),
      messageIds: [],
      renderedChunks: [],
      flushTimer: null,
      flushPromise: Promise.resolve(),
      lastFlush: 0,
      toolMessageId: null,
      toolLines: new Map(),
      toolTimer: null,
      toolPromise: Promise.resolve(),
    };
    this.activeTurns.set(scopeId, turn);
    return turn;
  }

  private async buildPromptParts(
    event: TelegramTextEvent,
    sessionId: string,
    cwd: string,
    text: string,
    locale: AppLocale,
  ): Promise<Array<TextPartInput | FilePartInput>> {
    if (event.attachments.length === 0) return [{ type: 'text', text }];
    const staged = await this.stageAttachments(cwd, sessionId, event.attachments, locale);
    const parts: Array<TextPartInput | FilePartInput> = [{ type: 'text', text: buildAttachmentPrompt(text, staged) }];
    for (const attachment of staged) {
      parts.push({
        type: 'file',
        mime: attachment.mimeType || 'application/octet-stream',
        filename: attachment.fileName,
        url: pathToFileURL(attachment.localPath).href,
      });
    }
    return parts;
  }

  private async stageAttachments(
    cwd: string,
    sessionId: string,
    attachments: readonly TelegramInboundAttachment[],
    locale: AppLocale,
  ): Promise<StagedTelegramAttachment[]> {
    const staged: StagedTelegramAttachment[] = [];
    for (const attachment of attachments) {
      const remote = attachment.localPath ? null : await this.messaging.getFile(attachment.fileId);
      const size = attachment.fileSize ?? remote?.file_size ?? null;
      if (size !== null && size > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES) {
        throw new Error(localize(locale, `附件超过 Telegram 20MB 下载限制：${attachment.fileName ?? attachment.fileUniqueId}`, `Attachment exceeds Telegram's 20MB download limit: ${attachment.fileName ?? attachment.fileUniqueId}`));
      }
      const remotePath = attachment.localPath ? path.basename(attachment.localPath) : remote?.file_path;
      if (!remotePath) throw new Error(localize(locale, 'Telegram 没有返回附件路径。', 'Telegram did not return an attachment path.'));
      const planned = planAttachmentStoragePath(cwd, sessionId, attachment, remotePath);
      await fs.mkdir(path.dirname(planned.localPath), { recursive: true });
      if (attachment.localPath) await fs.copyFile(attachment.localPath, planned.localPath);
      else await this.messaging.downloadResolvedFile(remotePath, planned.localPath);
      const resolved = { ...attachment, fileName: planned.fileName, fileSize: size };
      staged.push({
        ...resolved,
        fileName: planned.fileName,
        localPath: planned.localPath,
        relativePath: planned.relativePath,
        nativeImage: isNativeImageAttachment(resolved),
      });
    }
    return staged;
  }

  private async showHistory(scopeId: string, rawLimit: string, locale: AppLocale): Promise<void> {
    const session = await this.requireBoundSession(scopeId, locale);
    const limit = clampInt(rawLimit, 10, 1, 30);
    const response = await this.app.getClient().session.messages({ sessionID: session.id, directory: session.directory, limit });
    const messages = unwrap(response, 'session.messages');
    const lines = [localize(locale, `最近 ${Math.min(limit, messages.length)} 条消息：`, `Latest ${Math.min(limit, messages.length)} messages:`), ''];
    for (const row of messages.slice(-limit)) {
      const text = row.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
      lines.push(`${row.info.role === 'assistant' ? '🤖' : '🧑'} ${clip(text || localize(locale, '（非文本消息）', '(non-text message)'), 300)}`);
    }
    await this.send(scopeId, lines.join('\n'));
  }

  private async renameSession(scopeId: string, title: string, locale: AppLocale): Promise<void> {
    if (!title) throw new Error(localize(locale, '用法：/rename <名称>', 'Usage: /rename <name>'));
    const session = await this.requireBoundSession(scopeId, locale);
    unwrap(await this.app.getClient().session.update({ sessionID: session.id, directory: session.directory, title }), 'session.update');
    await this.send(scopeId, localize(locale, `已重命名为：${title}`, `Renamed to: ${title}`));
  }

  private async forkSession(scopeId: string, title: string, locale: AppLocale): Promise<void> {
    const session = await this.requireBoundSession(scopeId, locale);
    const fork = unwrap(await this.app.getClient().session.fork({ sessionID: session.id, directory: session.directory }), 'session.fork');
    if (title) unwrap(await this.app.getClient().session.update({ sessionID: fork.id, directory: fork.directory, title }), 'session.update');
    this.store.setBinding(scopeId, fork.id, fork.directory);
    await this.send(scopeId, localize(locale, `🍴 已 Fork 并打开：${title || fork.title}\n\`${fork.id}\``, `🍴 Forked and bound: ${title || fork.title}\n\`${fork.id}\``));
  }

  private async undoSession(scopeId: string, rawCount: string, locale: AppLocale): Promise<void> {
    if (this.activeTurns.has(scopeId)) throw new Error(localize(locale, '当前回复仍在运行，请先 /interrupt。', 'A turn is running; use /interrupt first.'));
    const session = await this.requireBoundSession(scopeId, locale);
    const count = clampInt(rawCount, 1, 1, 20);
    const rows = unwrap(await this.app.getClient().session.messages({
      sessionID: session.id,
      directory: session.directory,
      limit: 200,
    }), 'session.messages');
    const boundary = session.revert?.messageID
      ? rows.findIndex((row) => row.info.id === session.revert?.messageID)
      : rows.length;
    const visible = boundary >= 0 ? rows.slice(0, boundary) : rows;
    const users = visible.filter((row) => row.info.role === 'user');
    const target = users.at(-count);
    if (!target) throw new Error(localize(locale, `没有可回退的 ${count} 轮消息。`, `There are not ${count} user turns to undo.`));
    unwrap(await this.app.getClient().session.revert({
      sessionID: session.id,
      directory: session.directory,
      messageID: target.info.id,
    }), 'session.revert');
    await this.send(scopeId, localize(locale,
      `↩️ 已按 OpenCode 原生语义回退 ${count} 轮；文件快照与会话消息已一起恢复。使用 /redo 可重做。`,
      `↩️ Undid ${count} turn(s) with OpenCode's native revert, including file snapshots and messages. Use /redo to restore.`));
  }

  private async redoSession(scopeId: string, locale: AppLocale): Promise<void> {
    if (this.activeTurns.has(scopeId)) throw new Error(localize(locale, '当前回复仍在运行，请先 /interrupt。', 'A turn is running; use /interrupt first.'));
    const session = await this.requireBoundSession(scopeId, locale);
    const revertedMessageId = session.revert?.messageID;
    if (!revertedMessageId) throw new Error(localize(locale, '当前没有可重做的回退。', 'There is no reverted turn to redo.'));
    const rows = unwrap(await this.app.getClient().session.messages({
      sessionID: session.id,
      directory: session.directory,
      limit: 200,
    }), 'session.messages');
    const boundary = rows.findIndex((row) => row.info.id === revertedMessageId);
    const next = boundary >= 0 ? rows.slice(boundary + 1).find((row) => row.info.role === 'user') : undefined;
    if (next) {
      unwrap(await this.app.getClient().session.revert({
        sessionID: session.id,
        directory: session.directory,
        messageID: next.info.id,
      }), 'session.revert');
    } else {
      unwrap(await this.app.getClient().session.unrevert({ sessionID: session.id, directory: session.directory }), 'session.unrevert');
    }
    await this.send(scopeId, localize(locale, '↪️ 已重做一轮。', '↪️ Redid one turn.'));
  }

  private async archiveBoundSession(scopeId: string, locale: AppLocale): Promise<void> {
    if (this.activeTurns.has(scopeId)) throw new Error(localize(locale, '当前回复仍在运行，请先 /interrupt。', 'A turn is running; use /interrupt first.'));
    const session = await this.requireBoundSession(scopeId, locale);
    await this.archiveSession(scopeId, session, locale);
  }

  private async archiveCachedSession(scopeId: string, rawIndex: string, locale: AppLocale): Promise<void> {
    const index = Number.parseInt(rawIndex, 10);
    const cached = Number.isFinite(index) ? this.store.getCachedThread(scopeId, index) : null;
    if (!cached || cached.archived) throw new Error(localize(locale, '用法：先 /threads，再 /thread_archive <编号>。', 'Use /threads, then /thread_archive <number>.'));
    const session = await this.resolveSessionTarget(scopeId, rawIndex);
    if (!session) throw new Error(localize(locale, '找不到该会话。', 'Session not found.'));
    if ([...this.activeTurns.values()].some((turn) => turn.sessionId === session.id)) {
      throw new Error(localize(locale, '该会话仍在运行，请先中断。', 'That session is still running; interrupt it first.'));
    }
    await this.archiveSession(scopeId, session, locale);
  }

  private async archiveSession(scopeId: string, session: Session, locale: AppLocale): Promise<void> {
    unwrap(await this.app.getClient().session.update({
      sessionID: session.id,
      directory: session.directory,
      time: { archived: Date.now() },
    }), 'session.update');
    if (this.store.getBinding(scopeId)?.threadId === session.id) this.store.clearBinding(scopeId);
    const watch = this.watchers.get(scopeId);
    if (watch?.sessionId === session.id) {
      if (watch.flushTimer) clearTimeout(watch.flushTimer);
      this.watchers.delete(scopeId);
    }
    await this.send(scopeId, localize(locale, `📦 已归档 \`${session.id}\`。`, `📦 Archived \`${session.id}\`.`));
  }

  private async unarchiveSession(scopeId: string, rawIndex: string, locale: AppLocale): Promise<void> {
    const index = Number.parseInt(rawIndex, 10);
    const cached = Number.isFinite(index) ? this.store.getCachedThread(scopeId, index) : null;
    if (!cached?.archived) throw new Error(localize(locale, '用法：先 /threads archived，再 /unarchive <编号>。', 'Use /threads archived, then /unarchive <number>.'));
    const response = await this.app.getClient().session.get({
      sessionID: cached.threadId,
      ...(cached.cwd ? { directory: cached.cwd } : {}),
    });
    const session = unwrap(response, 'session.get');
    const restored = unwrap(await this.app.getClient().session.update({
      sessionID: session.id,
      directory: session.directory,
      time: { archived: 0 },
    }), 'session.update');
    this.store.setBinding(scopeId, restored.id, restored.directory);
    await this.send(scopeId, localize(locale, `📤 已恢复并打开：${restored.title}\n\`${restored.id}\``, `📤 Restored and bound: ${restored.title}\n\`${restored.id}\``));
  }

  private async showDiff(scopeId: string, locale: AppLocale): Promise<void> {
    const session = await this.requireBoundSession(scopeId, locale);
    const diffs = unwrap(await this.app.getClient().session.diff({ sessionID: session.id, directory: session.directory }), 'session.diff');
    if (diffs.length === 0) { await this.send(scopeId, localize(locale, '当前会话没有文件变更。', 'No file changes in this session.')); return; }
    const lines = [localize(locale, '📝 会话变更：', '📝 Session changes:'), ''];
    for (const diff of diffs.slice(0, 25)) lines.push(`\`${diff.file ?? '?'}\` · +${diff.additions} / -${diff.deletions}${diff.status ? ` · ${diff.status}` : ''}`);
    await this.send(scopeId, lines.join('\n'));
  }

  private async showWhere(scopeId: string, locale: AppLocale): Promise<void> {
    const session = await this.requireBoundSession(scopeId, locale);
    await this.send(scopeId, `${localize(locale, '会话', 'Session')}: \`${session.id}\`\n${localize(locale, '目录', 'Directory')}: \`${session.directory}\``);
  }

  private async findFiles(scopeId: string, query: string, locale: AppLocale): Promise<void> {
    if (!query) throw new Error(localize(locale, '用法：/files <关键词>', 'Usage: /files <query>'));
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const files = unwrap(await this.app.getClient().find.files({ directory: cwd, query, limit: 30 }), 'find.files');
    await this.send(scopeId, files.length
      ? [localize(locale, `🔍 “${query}” 的结果：`, `🔍 Results for “${query}”:`), '', ...files.map((file) => `\`${file}\``)].join('\n')
      : localize(locale, '没有匹配文件。', 'No matching files.'));
  }

  private async compactSession(scopeId: string, locale: AppLocale): Promise<void> {
    const session = await this.requireBoundSession(scopeId, locale);
    const selected = await this.effectiveModel(scopeId, session);
    if (!selected) throw new Error(localize(locale, '没有可用于压缩的模型。', 'No model is available for compaction.'));
    unwrap(await this.app.getClient().session.summarize({
      sessionID: session.id,
      directory: session.directory,
      providerID: selected.providerId,
      modelID: selected.modelId,
    }), 'session.summarize');
    await this.send(scopeId, localize(locale, '✅ 上下文压缩已完成。', '✅ Context compaction completed.'));
  }

  private async showLoaded(scopeId: string, locale: AppLocale): Promise<void> {
    const sessions = unwrap(await this.app.getClient().experimental.session.list({ limit: 100 }), 'session.list');
    const statuses = await this.statusesForSessions(sessions);
    const entries = Object.entries(statuses);
    if (entries.length === 0) { await this.send(scopeId, localize(locale, '当前没有已加载会话。', 'No loaded sessions.')); return; }
    const lines = [localize(locale, '已加载会话：', 'Loaded sessions:'), ''];
    for (const [id, status] of entries) lines.push(`${status.type === 'busy' ? '⏳' : status.type === 'retry' ? '🔁' : '○'} \`${shortId(id)}\` · ${status.type}`);
    await this.send(scopeId, lines.join('\n'));
  }

  private async statusesForSessions(sessions: readonly Session[]): Promise<Record<string, { type: string }>> {
    const directories = [...new Set(sessions.map((session) => session.directory))];
    const responses = await Promise.all(directories.map(async (directory) => {
      const response = await this.app.getClient().session.status({ directory });
      return response.error ? {} : response.data ?? {};
    }));
    return Object.assign({}, ...responses) as Record<string, { type: string }>;
  }

  private async showSkills(scopeId: string, locale: AppLocale): Promise<void> {
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const skills = unwrap(await this.app.getClient().app.skills({ directory: cwd }), 'skill.list');
    if (skills.length === 0) { await this.send(scopeId, localize(locale, '没有已加载 Skill。', 'No loaded skills.')); return; }
    const lines = [localize(locale, 'OpenCode Skills：', 'OpenCode skills:'), ''];
    for (const skill of skills.slice(0, 30)) lines.push(`• \`${skill.name}\` — ${clip(skill.description ?? '', 100)}`);
    await this.send(scopeId, lines.join('\n'));
  }

  private async showMcp(scopeId: string, locale: AppLocale, appsAlias = false): Promise<void> {
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const servers = unwrap(await this.app.getClient().mcp.status({ directory: cwd }), 'mcp.status');
    const entries = Object.entries(servers);
    if (entries.length === 0) {
      await this.send(scopeId, appsAlias
        ? localize(locale, 'OpenCode 用 MCP server 提供外部应用能力；当前没有配置 MCP server。', 'OpenCode exposes external app capabilities through MCP servers; none are configured.')
        : localize(locale, '没有配置 MCP server。', 'No MCP servers configured.'));
      return;
    }
    const icon = (status: string): string => status === 'connected' ? '✅' : status === 'failed' ? '❌' : status === 'needs_auth' ? '🔑' : '⚪';
    await this.send(scopeId, [appsAlias
      ? localize(locale, 'OpenCode Apps（MCP server）：', 'OpenCode apps (MCP servers):')
      : localize(locale, 'MCP 状态：', 'MCP status:'), '', ...entries.map(([name, value]) => `${icon(value.status)} \`${name}\` · ${value.status}${'error' in value ? ` · ${value.error}` : ''}`)].join('\n'));
  }

  private async showProviders(scopeId: string, locale: AppLocale): Promise<void> {
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const data = unwrap(await this.app.getClient().provider.list({ directory: cwd }), 'provider.list');
    const connected = new Set(data.connected);
    const lines = [localize(locale, '模型 Provider：', 'Model providers:'), ''];
    for (const provider of data.all) lines.push(`${connected.has(provider.id) ? '✅' : '○'} \`${provider.id}\` · ${provider.name} · ${Object.keys(provider.models).length} models`);
    await this.send(scopeId, lines.join('\n'));
  }

  private async showAuth(scopeId: string, locale: AppLocale): Promise<void> {
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const [providerData, authMethods] = await Promise.all([
      this.app.getClient().provider.list({ directory: cwd }),
      this.app.getClient().provider.auth({ directory: cwd }),
    ]);
    const providers = unwrap(providerData, 'provider.list');
    const methods = unwrap(authMethods, 'provider.auth');
    const connected = new Set(providers.connected);
    const lines = [localize(locale, '🔐 OpenCode Provider 认证：', '🔐 OpenCode provider authentication:'), ''];
    for (const provider of providers.all.filter((item) => connected.has(item.id))) {
      const available = methods[provider.id] ?? [];
      lines.push(`✅ ${provider.name} · \`${provider.id}\`${available.length ? ` · ${available.map((method) => method.label).join(' / ')}` : ''}`);
    }
    if (providers.connected.length === 0) lines.push(localize(locale, '当前没有已连接 Provider。', 'No providers are connected.'));
    lines.push('', localize(locale,
      'OpenCode serve 只公开认证方法和 OAuth 端点，没有 Codex 设备登录/账号切换面板。登录或切换请在终端运行：opencode auth',
      'OpenCode serve exposes auth methods and OAuth endpoints, but no Codex-style device-login/account-switch panel. Run opencode auth in a terminal to sign in or switch.'));
    await this.send(scopeId, lines.join('\n'));
  }

  private async showPlugins(scopeId: string, locale: AppLocale, hooksAlias: boolean): Promise<void> {
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const config = unwrap(await this.app.getClient().config.get({ directory: cwd }), 'config.get');
    const plugins = (config.plugin ?? []).map((entry) => Array.isArray(entry) ? entry[0] : entry);
    const title = hooksAlias
      ? localize(locale, '🪝 OpenCode Hooks（由 Plugins 提供）：', '🪝 OpenCode hooks (provided by plugins):')
      : localize(locale, '🧩 OpenCode Plugins：', '🧩 OpenCode plugins:');
    await this.send(scopeId, plugins.length > 0
      ? [title, '', ...plugins.map((plugin) => `• \`${plugin}\``), '', hooksAlias
        ? localize(locale, 'OpenCode 没有独立 hooks 注册表；hook 生命周期由这些 plugin 管理。', 'OpenCode has no separate hooks registry; these plugins own hook lifecycles.')
        : localize(locale, 'Plugin 配置来自当前目录的有效 OpenCode config。', 'Plugin entries come from the effective OpenCode config for this directory.')].join('\n')
      : [title, '', localize(locale, '当前有效配置没有 plugin。', 'No plugins are present in the effective config.')].join('\n'));
  }

  private async showFeatures(scopeId: string, locale: AppLocale): Promise<void> {
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const capabilities = unwrap(await this.app.getClient().experimental.capabilities.get({ directory: cwd }), 'experimental.capabilities.get');
    const entries = Object.entries(capabilities);
    await this.send(scopeId, [localize(locale, '🧪 OpenCode 实验能力：', '🧪 OpenCode experimental capabilities:'), '',
      ...(entries.length ? entries.map(([name, value]) => `${value ? '✅' : '○'} \`${name}\` · ${String(value)}`) : [localize(locale, '服务端没有报告实验能力。', 'The server reported no experimental capabilities.')]),
    ].join('\n'));
  }

  private async showConfig(scopeId: string, locale: AppLocale): Promise<void> {
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const config = unwrap(await this.app.getClient().config.get({ directory: cwd }), 'config.get');
    const keys = ['model', 'small_model', 'default_agent', 'share', 'autoupdate', 'username'] as const;
    const lines = [localize(locale, '⚙️ OpenCode 有效配置（敏感字段已省略）：', '⚙️ Effective OpenCode config (sensitive fields omitted):'), ''];
    for (const key of keys) {
      const value = config[key];
      if (value !== undefined) lines.push(`\`${key}\`: ${typeof value === 'object' ? '[configured]' : String(value)}`);
    }
    lines.push(`\`mcp\`: ${Object.keys(config.mcp ?? {}).length}`, `\`agent\`: ${Object.keys(config.agent ?? {}).length}`);
    await this.send(scopeId, lines.join('\n'));
  }

  private async runReview(event: TelegramTextEvent, argumentsText: string, locale: AppLocale): Promise<void> {
    if (this.activeTurns.has(event.scopeId)) {
      throw new Error(localize(locale, '当前回复仍在运行；请等待、/queue，或先 /interrupt。', 'A turn is already running; wait, use /queue, or /interrupt first.'));
    }
    const session = await this.requireBoundSession(event.scopeId, locale);
    const settings = this.store.getChatSettings(event.scopeId);
    const prefs = readPrefs(settings);
    const model = await this.effectiveModel(event.scopeId, session);
    const agent = settings?.collaborationMode === 'plan' ? 'plan' : prefs.agent ?? 'build';
    const tracked = this.startTrackedTurn(event.scopeId, session.id, session.directory);
    await this.messaging.sendTypingInScope(event.scopeId);
    const request = this.app.getClient().session.command({
      sessionID: session.id,
      directory: session.directory,
      command: 'review',
      arguments: argumentsText,
      agent,
      ...(model ? { model: `${model.providerId}/${model.modelId}` } : {}),
      ...(prefs.variant ? { variant: prefs.variant } : {}),
    });
    void request.then(async (response) => {
      if (!response.error) return;
      if (this.activeTurns.get(event.scopeId) === tracked) this.activeTurns.delete(event.scopeId);
      await this.reportError(event.scopeId, new Error(formatSdkError(response.error)));
    }, async (error: unknown) => {
      if (this.activeTurns.get(event.scopeId) === tracked) this.activeTurns.delete(event.scopeId);
      await this.reportError(event.scopeId, error);
    });
    if (settings?.collaborationMode === 'plan') this.store.setChatCollaborationMode(event.scopeId, 'default');
    this.app.watchSessionUntilIdle(session.id, session.directory);
  }

  private async showRichDemo(scopeId: string, locale: AppLocale): Promise<void> {
    const markdown = localize(locale,
      '## FoxClaw 富文本测试\n\n- **粗体**、`代码` 与 [链接](https://opencode.ai)\n- OpenCode 流式回复完成后也会使用同一套富文本渲染。',
      '## FoxClaw rich-text test\n\n- **Bold**, `code`, and a [link](https://opencode.ai)\n- Completed OpenCode streams use the same rich renderer.');
    await this.sendFinalChunk(scopeId, markdown);
  }

  private async handleVoiceCommand(scopeId: string, args: string[], locale: AppLocale): Promise<void> {
    if (args[0]?.toLowerCase() === 'file' || args[0]?.toLowerCase() === 'send') {
      const fileArg = args[1]?.trim();
      if (!fileArg) throw new Error(localize(locale,
        '用法：/voice file /path/to/audio.ogg [说明]',
        'Usage: /voice file /path/to/audio.ogg [caption]'));
      const filePath = path.resolve(this.config.defaultCwd, fileArg);
      const contentType = telegramVoiceContentType(filePath);
      if (!contentType) throw new Error(localize(locale,
        `只支持 Telegram voice 音频格式：${TELEGRAM_VOICE_SUPPORTED_EXTENSIONS}。`,
        `Supported Telegram voice formats: ${TELEGRAM_VOICE_SUPPORTED_EXTENSIONS}.`));
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) throw new Error(localize(locale, `找不到音频文件：${filePath}`, `Audio file not found: ${filePath}`));
      if (stat.size > TELEGRAM_VOICE_MAX_BYTES) throw new Error(localize(locale, 'Telegram voice 文件不能超过 50MB。', 'Telegram voice files must be 50MB or smaller.'));
      const contents = await fs.readFile(filePath);
      const caption = args.slice(2).join(' ').trim() || localize(locale, 'FoxClaw 语音文件', 'FoxClaw voice file');
      await this.messaging.sendVoice(scopeId, path.basename(filePath), contents, caption, contentType);
      return;
    }
    const raw = args.join(' ').trim();
    const text = raw.toLowerCase() === 'last' ? this.latestVoiceText.get(scopeId) ?? '' : raw;
    if (!text) throw new Error(localize(locale, '用法：/voice <文本>、/voice last 或 /voice file <路径>。', 'Usage: /voice <text>, /voice last, or /voice file <path>.'));
    if (!this.config.voiceTtsEnabled) throw new Error(localize(locale, '语音服务未启用。', 'Voice TTS is not enabled.'));
    try {
      const voice = await synthesizeTelegramVoice(text, this.config);
      await this.messaging.sendVoice(scopeId, voice.filename, voice.contents, localize(locale, 'FoxClaw 总结语音', 'FoxClaw voice summary'), voice.contentType);
    } catch (error) {
      throw new Error(localize(locale,
        `语音生成失败：${error instanceof Error ? error.message : String(error)}`,
        `Voice generation failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private async showFastUnsupported(scopeId: string, locale: AppLocale): Promise<void> {
    await this.send(scopeId, localize(locale,
      '⚡ OpenCode serve 没有 Codex Fast service tier 的等价 API。可在 /setup 中选择当前模型提供的 variant；FoxClaw 不会把某个 variant 冒充 Fast。',
      '⚡ OpenCode serve has no API equivalent to the Codex Fast service tier. Use /setup for model variants; FoxClaw will not relabel a variant as Fast.'));
  }

  private async abort(scopeId: string, locale: AppLocale): Promise<void> {
    const turn = this.activeTurns.get(scopeId);
    const binding = this.store.getBinding(scopeId);
    const sessionId = turn?.sessionId ?? binding?.threadId;
    if (!sessionId) { await this.send(scopeId, localize(locale, '没有进行中的回复。', 'No active turn.')); return; }
    const directory = turn?.cwd ?? binding?.cwd ?? null;
    const response = await this.app.getClient().session.abort({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
    });
    if (response.error) throw new Error(formatSdkError(response.error));
    await this.finishSession(sessionId);
    await this.send(scopeId, localize(locale, '⏹️ 已中断。', '⏹️ Turn aborted.'));
  }

  private async requireBoundSession(scopeId: string, locale: AppLocale): Promise<Session> {
    const session = await this.resolveSessionTarget(scopeId, '');
    if (!session) throw new Error(localize(locale, '当前没有有效会话，先发送消息或使用 /new。', 'No valid bound session; send a message or use /new.'));
    return session;
  }

  private async effectiveModel(scopeId: string, session: Session): Promise<{ providerId: string; modelId: string } | null> {
    const configured = this.store.getChatSettings(scopeId)?.model;
    if (configured) return parseStoredModel(configured);
    if (session.model) return { providerId: session.model.providerID, modelId: session.model.id };
    const data = unwrap(await this.app.getClient().provider.list({ directory: session.directory }), 'provider.list');
    const providerId = data.connected[0];
    if (!providerId) return null;
    const modelId = data.default[providerId] ?? Object.keys(data.all.find((provider) => provider.id === providerId)?.models ?? {})[0];
    return modelId ? { providerId, modelId } : null;
  }

  private async handleAppEvent(event: OpencodeBridgeEvent): Promise<void> {
    switch (event.kind) {
      case 'text': this.handleTextEvent(event); return;
      case 'tool': this.handleToolEvent(event); return;
      case 'permission': await this.handlePermission(event.request); return;
      case 'permissionResolved': this.resolvePermission(event.requestId); return;
      case 'question': await this.handleQuestion(event.request); return;
      case 'questionResolved': this.resolveQuestion(event.requestId); return;
      case 'idle': await this.finishSession(event.sessionId); return;
      case 'status':
        if (event.status.type === 'idle') await this.finishSession(event.sessionId);
        return;
      case 'error':
        if (event.sessionId) {
          for (const scopeId of this.scopesForSession(event.sessionId)) await this.send(scopeId, `⚠️ ${event.message}`);
          await this.finishSession(event.sessionId);
        }
    }
  }

  private async cleanupAfterDisconnect(): Promise<void> {
    const turns = [...this.activeTurns];
    this.activeTurns.clear();
    for (const [scopeId, turn] of turns) {
      this.clearTurnTimers(turn);
      await this.flushTurn(scopeId, turn, true).catch((error) => this.reportError(scopeId, error));
      if (turn.toolMessageId !== null) {
        await this.messaging.editPlain(scopeId, turn.toolMessageId, '⚠️ OpenCode serve disconnected').catch(() => {});
      }
      const locale = this.localeForScope(scopeId);
      await this.send(scopeId, localize(locale,
        '⚠️ OpenCode serve 已断开，FoxClaw 正在重连。',
        '⚠️ OpenCode serve disconnected; FoxClaw is reconnecting.')).catch(() => {});
    }
  }

  private async recoverAfterReconnect(cleanup: Promise<void>): Promise<void> {
    await cleanup;
    await this.app.recoverPendingRequests(this.store.listBindings()
      .filter((binding) => this.isOwnScope(binding.chatId))
      .flatMap((binding) => binding.cwd ? [binding.cwd] : []));
    for (const [scopeId, queue] of [...this.queuedPrompts]) {
      if (this.activeTurns.has(scopeId)) continue;
      const next = queue.shift();
      if (!next) {
        this.queuedPrompts.delete(scopeId);
        continue;
      }
      if (queue.length === 0) this.queuedPrompts.delete(scopeId);
      try {
        await this.dispatchPrompt(next.event, next.text, next.locale);
      } catch (error) {
        const pending = this.queuedPrompts.get(scopeId) ?? [];
        pending.unshift(next);
        this.queuedPrompts.set(scopeId, pending);
        await this.reportError(scopeId, error);
      }
    }
  }

  private scopesForSession(sessionId: string): string[] {
    const scopes = new Set(this.store.findAllChatIdsByThreadId(sessionId).filter((scopeId) => this.isOwnScope(scopeId)));
    for (const [scopeId, turn] of this.activeTurns) if (turn.sessionId === sessionId) scopes.add(scopeId);
    for (const [scopeId, watch] of this.watchers) if (watch.sessionId === sessionId) scopes.add(scopeId);
    return [...scopes];
  }

  private isOwnScope(scopeId: string): boolean {
    return Boolean(this.bot.identity && scopeId.startsWith(`telegram:${this.bot.identity}:`));
  }

  private cwdForSession(scopeId: string, sessionId: string): string {
    const turn = this.activeTurns.get(scopeId);
    if (turn?.sessionId === sessionId) return turn.cwd;
    const watch = this.watchers.get(scopeId);
    if (watch?.sessionId === sessionId) return watch.cwd;
    const binding = this.store.getBinding(scopeId);
    if (binding?.threadId === sessionId && binding.cwd) return binding.cwd;
    return this.config.defaultCwd;
  }

  private handleTextEvent(event: OpencodeTextEvent): void {
    for (const [scopeId, turn] of this.activeTurns) {
      if (turn.sessionId !== event.sessionId) continue;
      turn.parts.set(`${event.messageId}:${event.partId}`, event.text);
      this.scheduleTurnFlush(scopeId, turn);
    }
    for (const [scopeId, watch] of this.watchers) {
      if (watch.sessionId !== event.sessionId) continue;
      watch.parts.set(`${event.messageId}:${event.partId}`, event.text);
      this.scheduleWatchFlush(scopeId, watch);
    }
  }

  private handleToolEvent(event: OpencodeToolEvent): void {
    for (const [scopeId, turn] of this.activeTurns) {
      if (turn.sessionId !== event.sessionId) continue;
      const icon = event.status === 'completed' ? '✅' : event.status === 'error' ? '❌' : '🔧';
      turn.toolLines.set(event.callId, `${icon} ${clip(event.title ?? event.tool, 120)}${event.error ? ` — ${clip(event.error, 160)}` : ''}`);
      this.scheduleToolFlush(scopeId, turn);
    }
  }

  private scheduleTurnFlush(scopeId: string, turn: ActiveTurn): void {
    if (turn.flushTimer) return;
    turn.flushTimer = setTimeout(() => {
      turn.flushTimer = null;
      void this.flushTurn(scopeId, turn, false).catch((error) => this.reportError(scopeId, error));
    }, Math.max(0, STREAM_THROTTLE_MS - (Date.now() - turn.lastFlush)));
  }

  private async flushTurn(scopeId: string, turn: ActiveTurn, final: boolean): Promise<void> {
    const task = turn.flushPromise.then(() => this.flushTurnNow(scopeId, turn, final));
    turn.flushPromise = task.catch(() => {});
    return task;
  }

  private async flushTurnNow(scopeId: string, turn: ActiveTurn, final: boolean): Promise<void> {
    const text = [...turn.parts.values()].join('');
    if (!text.trim()) return;
    const chunks = chunkTelegramStreamMessage(text);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const messageId = turn.messageIds[index];
      if (messageId === undefined) {
        turn.messageIds.push(final
          ? await this.sendFinalChunk(scopeId, chunk)
          : await this.messaging.sendPlain(scopeId, chunk));
      } else if (turn.renderedChunks[index] !== chunk) {
        if (final) await this.editFinalChunk(scopeId, messageId, chunk);
        else await this.messaging.editPlain(scopeId, messageId, chunk);
      } else if (final) {
        await this.editFinalChunk(scopeId, messageId, chunk);
      }
    }
    turn.renderedChunks = chunks;
    turn.lastFlush = Date.now();
  }

  private scheduleToolFlush(scopeId: string, turn: ActiveTurn): void {
    if (turn.toolTimer) return;
    turn.toolTimer = setTimeout(() => {
      turn.toolTimer = null;
      void this.flushTools(scopeId, turn).catch((error) => this.reportError(scopeId, error));
    }, TOOL_THROTTLE_MS);
  }

  private async flushTools(scopeId: string, turn: ActiveTurn): Promise<void> {
    const task = turn.toolPromise.then(() => this.flushToolsNow(scopeId, turn));
    turn.toolPromise = task.catch(() => {});
    return task;
  }

  private async flushToolsNow(scopeId: string, turn: ActiveTurn): Promise<void> {
    const lines = [...turn.toolLines.values()].slice(-8);
    if (lines.length === 0) return;
    const text = `${lines.join('\n')}\n\n⏳ OpenCode…`;
    if (turn.toolMessageId === null) turn.toolMessageId = await this.messaging.sendPlain(scopeId, text);
    else await this.messaging.editPlain(scopeId, turn.toolMessageId, text);
  }

  private scheduleWatchFlush(scopeId: string, watch: WatchState): void {
    if (watch.flushTimer) return;
    watch.flushTimer = setTimeout(() => {
      watch.flushTimer = null;
      void this.flushWatch(scopeId, watch, false).catch((error) => this.reportError(scopeId, error));
    }, Math.max(0, STREAM_THROTTLE_MS - (Date.now() - watch.lastFlush)));
  }

  private async flushWatch(scopeId: string, watch: WatchState, final: boolean): Promise<void> {
    const task = watch.flushPromise.then(() => this.flushWatchNow(scopeId, watch, final));
    watch.flushPromise = task.catch(() => {});
    return task;
  }

  private async flushWatchNow(scopeId: string, watch: WatchState, final: boolean): Promise<void> {
    const text = [...watch.parts.values()].join('');
    if (!text.trim()) return;
    const chunks = chunkTelegramStreamMessage(text);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const id = watch.messageIds[index];
      if (id === undefined) watch.messageIds.push(final ? await this.sendFinalChunk(scopeId, chunk) : await this.messaging.sendPlain(scopeId, chunk));
      else if (watch.renderedChunks[index] !== chunk || final) {
        if (final) await this.editFinalChunk(scopeId, id, chunk);
        else await this.messaging.editPlain(scopeId, id, chunk);
      }
    }
    watch.renderedChunks = chunks;
    watch.lastFlush = Date.now();
  }

  private async finishSession(sessionId: string): Promise<void> {
    const current = this.finishingSessions.get(sessionId);
    if (current) return current;
    const task = this.finishSessionNow(sessionId);
    const tracked = task.finally(() => {
      if (this.finishingSessions.get(sessionId) === tracked) this.finishingSessions.delete(sessionId);
    });
    this.finishingSessions.set(sessionId, tracked);
    return tracked;
  }

  private async finishSessionNow(sessionId: string): Promise<void> {
    for (const [scopeId, turn] of [...this.activeTurns]) {
      if (turn.sessionId !== sessionId) continue;
      this.clearTurnTimers(turn);
      await this.flushTurn(scopeId, turn, true);
      const finalText = [...turn.parts.values()].join('').trim();
      if (finalText) this.latestVoiceText.set(scopeId, finalText);
      if (turn.toolMessageId !== null) {
        if (this.config.telegramDeleteToolDetailsAfterFinal) await this.messaging.deleteMessage(scopeId, turn.toolMessageId).catch(() => {});
        else await this.messaging.editPlain(scopeId, turn.toolMessageId, [...turn.toolLines.values()].join('\n') || '✅ done').catch(() => {});
      }
      this.activeTurns.delete(scopeId);
      const next = this.queuedPrompts.get(scopeId)?.shift();
      if (this.queuedPrompts.get(scopeId)?.length === 0) this.queuedPrompts.delete(scopeId);
      if (next) await this.dispatchPrompt(next.event, next.text, next.locale);
    }
    for (const [scopeId, watch] of this.watchers) {
      if (watch.sessionId !== sessionId) continue;
      if (watch.flushTimer) clearTimeout(watch.flushTimer);
      watch.flushTimer = null;
      await this.flushWatch(scopeId, watch, true);
      watch.parts.clear();
      watch.messageIds = [];
      watch.renderedChunks = [];
    }
  }

  private clearTurnTimers(turn: ActiveTurn): void {
    if (turn.flushTimer) clearTimeout(turn.flushTimer);
    if (turn.toolTimer) clearTimeout(turn.toolTimer);
    turn.flushTimer = null;
    turn.toolTimer = null;
  }

  private async handlePermission(request: PermissionRequest): Promise<void> {
    if (this.handlingPermissionIds.has(request.id)
      || [...this.permissions.values()].some((pending) => pending.request.id === request.id)) return;
    this.handlingPermissionIds.add(request.id);
    try {
      const scopes = this.scopesForSession(request.sessionID);
      const fullAccessScope = scopes.find((scopeId) => this.store.getChatSettings(scopeId)?.accessPreset === 'full-access');
      if (fullAccessScope) {
        const cwd = this.cwdForSession(fullAccessScope, request.sessionID);
        const response = await this.app.getClient().permission.reply({ requestID: request.id, directory: cwd, reply: 'always' });
        if (response.error) throw new Error(formatSdkError(response.error));
        this.logger.info('opencode.permission.auto_allowed', { sessionId: request.sessionID, permission: request.permission });
        return;
      }
      for (const scopeId of scopes) {
        const key = randomKey();
        const cwd = this.cwdForSession(scopeId, request.sessionID);
        const locale = this.localeForScope(scopeId);
        const keyboard: InlineKeyboard = [[
          { text: localize(locale, '✅ 本次', '✅ Once'), callback_data: `${PERMISSION_CALLBACK_PREFIX}${key}:once` },
          { text: localize(locale, '♾ 总是', '♾ Always'), callback_data: `${PERMISSION_CALLBACK_PREFIX}${key}:always` },
          { text: localize(locale, '🚫 拒绝', '🚫 Deny'), callback_data: `${PERMISSION_CALLBACK_PREFIX}${key}:reject` },
        ]];
        const text = [
          localize(locale, '🛂 OpenCode 请求权限', '🛂 OpenCode permission request'),
          `\`${request.permission}\``,
          ...request.patterns.slice(0, 8).map((pattern) => `• \`${pattern}\``),
          '',
          `${localize(locale, '命令回复', 'Command reply')}: /approve ${key} <once|always|reject>`,
        ].join('\n');
        const messageId = await this.messaging.sendPlain(scopeId, text, keyboard);
        this.permissions.set(`${key}:${scopeId}`, { key, scopeId, cwd, request, messageId });
      }
    } finally {
      this.handlingPermissionIds.delete(request.id);
    }
  }

  private resolvePermission(requestId: string): void {
    for (const [key, pending] of this.permissions) if (pending.request.id === requestId) this.permissions.delete(key);
  }

  private async approveFromCommand(scopeId: string, args: string[], locale: AppLocale): Promise<void> {
    const pending = [...this.permissions.values()].filter((item) => item.scopeId === scopeId);
    if (args.length === 0) {
      await this.send(scopeId, pending.length
        ? [localize(locale, '待审批：', 'Pending approvals:'), ...pending.map((item) => `\`${item.key}\` · ${item.request.permission}`), '', `/approve <id> <once|always|reject>`].join('\n')
        : localize(locale, '没有待审批请求。', 'No pending approvals.'));
      return;
    }
    const target = pending.find((item) => item.key === args[0] || item.request.id.startsWith(args[0]!));
    if (!target) throw new Error(localize(locale, '找不到待审批请求。', 'Pending approval not found.'));
    const reply = args[1] === 'always' ? 'always' : args[1] === 'reject' || args[1] === 'deny' ? 'reject' : 'once';
    await this.replyPermission(target, reply, locale);
  }

  private async replyPermission(pending: PendingPermissionUi, reply: 'once' | 'always' | 'reject', locale: AppLocale): Promise<void> {
    const response = await this.app.getClient().permission.reply({ requestID: pending.request.id, directory: pending.cwd, reply });
    if (response.error) throw new Error(formatSdkError(response.error));
    await this.messaging.editPlain(pending.scopeId, pending.messageId,
      `${reply === 'reject' ? '🚫' : '✅'} ${localize(locale, reply === 'reject' ? '已拒绝' : reply === 'always' ? '已永久允许' : '已允许本次', reply === 'reject' ? 'Denied' : reply === 'always' ? 'Always allowed' : 'Allowed once')} · ${pending.request.permission}`);
    this.resolvePermission(pending.request.id);
  }

  private async handleQuestion(request: QuestionRequest): Promise<void> {
    if (this.handlingQuestionIds.has(request.id)
      || [...this.questions.values()].some((pending) => pending.request.id === request.id)) return;
    this.handlingQuestionIds.add(request.id);
    try {
      for (const scopeId of this.scopesForSession(request.sessionID)) {
        const key = randomKey();
        const cwd = this.cwdForSession(scopeId, request.sessionID);
        const locale = this.localeForScope(scopeId);
        const pending: PendingQuestionUi = { key, scopeId, cwd, request, messageIds: [], answers: request.questions.map(() => []) };
        this.questions.set(`${key}:${scopeId}`, pending);
        for (let questionIndex = 0; questionIndex < request.questions.length; questionIndex++) {
          const question = request.questions[questionIndex]!;
          const keyboard: InlineKeyboard = question.options.map((option, optionIndex) => [{
            text: option.label,
            callback_data: `${QUESTION_CALLBACK_PREFIX}${key}:${questionIndex}:${optionIndex}`,
          }]);
          if (question.multiple) keyboard.push([{ text: localize(locale, '✅ 完成多选', '✅ Done'), callback_data: `${QUESTION_CALLBACK_PREFIX}${key}:${questionIndex}:done` }]);
          const text = [
            `❓ ${question.header}`,
            question.question,
            ...question.options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`),
            '',
            localize(locale, `文字回答：/answer ${key} ${questionIndex + 1} <内容>`, `Text answer: /answer ${key} ${questionIndex + 1} <text>`),
          ].join('\n');
          pending.messageIds.push(await this.messaging.sendPlain(scopeId, text, keyboard));
        }
      }
    } finally {
      this.handlingQuestionIds.delete(request.id);
    }
  }

  private resolveQuestion(requestId: string): void {
    for (const [key, pending] of this.questions) if (pending.request.id === requestId) this.questions.delete(key);
  }

  private async answerFromCommand(scopeId: string, args: string[], locale: AppLocale): Promise<void> {
    const pending = [...this.questions.values()].filter((item) => item.scopeId === scopeId);
    if (args.length === 0) {
      await this.send(scopeId, pending.length
        ? [localize(locale, '待回答：', 'Pending questions:'), ...pending.map((item) => `\`${item.key}\` · ${item.request.questions.map((q) => q.header).join(' / ')}`), '', '/answer <id> <questionNo> <text>'].join('\n')
        : localize(locale, '没有待回答问题。', 'No pending questions.'));
      return;
    }
    const target = pending.find((item) => item.key === args[0] || item.request.id.startsWith(args[0]!));
    if (!target) throw new Error(localize(locale, '找不到待回答请求。', 'Pending question not found.'));
    if (args[1] === 'reject' || args[1] === 'cancel') {
      const response = await this.app.getClient().question.reject({ requestID: target.request.id, directory: target.cwd });
      if (response.error) throw new Error(formatSdkError(response.error));
      this.resolveQuestion(target.request.id);
      await this.send(scopeId, localize(locale, '已拒绝问题请求。', 'Question request rejected.'));
      return;
    }
    const questionIndex = Number.parseInt(args[1] ?? '', 10) - 1;
    const answer = args.slice(2).join(' ').trim();
    if (!target.request.questions[questionIndex] || !answer) throw new Error('/answer <id> <questionNo> <text>');
    target.answers[questionIndex] = [answer];
    await this.maybeSubmitQuestion(target, locale);
  }

  private async maybeSubmitQuestion(pending: PendingQuestionUi, locale: AppLocale): Promise<void> {
    if (pending.answers.some((answer) => answer.length === 0)) return;
    const response = await this.app.getClient().question.reply({
      requestID: pending.request.id,
      directory: pending.cwd,
      answers: pending.answers,
    });
    if (response.error) throw new Error(formatSdkError(response.error));
    for (let index = 0; index < pending.messageIds.length; index++) {
      await this.messaging.editPlain(pending.scopeId, pending.messageIds[index]!,
        `✅ ${pending.request.questions[index]?.header ?? localize(locale, '已回答', 'Answered')}: ${pending.answers[index]!.join(', ')}`).catch(() => {});
    }
    this.resolveQuestion(pending.request.id);
  }

  private async handleCallback(event: TelegramCallbackEvent): Promise<void> {
    const locale = this.localeForScope(event.scopeId, event.languageCode);
    if (event.data.startsWith(SETUP_CALLBACK_PREFIX)) {
      const key = event.data.slice(SETUP_CALLBACK_PREFIX.length);
      const action = this.setupActions.get(key);
      if (!action || action.scopeId !== event.scopeId) { await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '已过期', 'Expired')); return; }
      this.setupActions.delete(key);
      if (action.kind === 'setup') {
        await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '设置', 'Settings'));
        await this.showSetup(event.scopeId, locale, event.messageId);
      } else if (action.kind === 'models') {
        await this.messaging.answerCallback(event.callbackQueryId, localize(locale, 'Provider', 'Providers'));
        await this.showModels(event.scopeId, '', locale, event.messageId, action.origin ?? 'models');
      } else if (action.kind === 'provider') {
        await this.messaging.answerCallback(event.callbackQueryId, action.value);
        await this.showModels(event.scopeId, action.value, locale, event.messageId, action.origin ?? 'models');
      } else if (action.kind === 'model') {
        let answer: string;
        if (action.value === 'default') {
          const settings = this.store.getChatSettings(event.scopeId);
          this.store.setChatSettings(event.scopeId, null, settings?.reasoningEffort ?? null);
          this.writePrefs(event.scopeId, { ...readPrefs(settings), variant: null });
          answer = localize(locale, '服务端默认', 'Server default');
        } else {
          const parsed = parseStoredModel(action.value)!;
          this.store.setChatSettings(event.scopeId, action.value, null);
          this.writePrefs(event.scopeId, { ...readPrefs(this.store.getChatSettings(event.scopeId)), variant: null });
          answer = `${parsed.providerId}/${parsed.modelId}`;
        }
        await this.messaging.answerCallback(event.callbackQueryId, answer);
        if (action.origin === 'setup') await this.showSetup(event.scopeId, locale, event.messageId);
        else {
          const parsed = action.value === 'default' ? null : parseStoredModel(action.value);
          await this.showModels(event.scopeId, parsed?.providerId ?? '', locale, event.messageId, 'models');
        }
      } else if (action.kind === 'variant') {
        const prefs = readPrefs(this.store.getChatSettings(event.scopeId));
        this.writePrefs(event.scopeId, { ...prefs, variant: action.value === 'default' ? null : action.value });
        await this.messaging.answerCallback(event.callbackQueryId, action.value);
        await this.showSetup(event.scopeId, locale, event.messageId);
      } else if (action.kind === 'access') {
        if (action.value !== 'read-only' && action.value !== 'default' && action.value !== 'full-access') {
          throw new Error(`Invalid access preset: ${action.value}`);
        }
        await this.applyAccess(event.scopeId, action.value);
        await this.messaging.answerCallback(event.callbackQueryId, action.value);
        await this.showSetup(event.scopeId, locale, event.messageId);
      } else if (action.kind === 'mode') {
        this.store.setChatCollaborationMode(event.scopeId, action.value === 'plan' ? 'plan' : 'default');
        await this.messaging.answerCallback(event.callbackQueryId, action.value);
        await this.showSetup(event.scopeId, locale, event.messageId);
      } else if (action.kind === 'agent') {
        const prefs = readPrefs(this.store.getChatSettings(event.scopeId));
        this.writePrefs(event.scopeId, { ...prefs, agent: action.value === 'build' ? 'build' : action.value });
        this.store.setChatCollaborationMode(event.scopeId, 'default');
        await this.messaging.answerCallback(event.callbackQueryId, action.value);
        await this.showSetup(event.scopeId, locale, event.messageId);
      } else if (action.kind === 'active') {
        this.store.setChatActiveTurnMessageMode(event.scopeId, action.value === 'queue' ? 'queue' : 'steer');
        await this.messaging.answerCallback(event.callbackQueryId, action.value);
        await this.showSetup(event.scopeId, locale, event.messageId);
      } else if (action.kind === 'notice') {
        await this.messaging.answerCallback(event.callbackQueryId, localize(locale, 'OpenCode 没有 Codex Fast 服务层等价项', 'OpenCode has no Codex Fast service-tier equivalent'));
      } else if (action.kind === 'open') {
        await this.openSession(event.scopeId, action.value, locale);
        await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '已打开', 'Opened'));
      } else {
        await this.watchSession(event.scopeId, action.value, locale);
        await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '正在观察', 'Watching'));
      }
      return;
    }
    if (event.data.startsWith(PERMISSION_CALLBACK_PREFIX)) {
      const [key, rawReply] = event.data.slice(PERMISSION_CALLBACK_PREFIX.length).split(':');
      const pending = this.permissions.get(`${key}:${event.scopeId}`);
      if (!pending) { await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '已过期', 'Expired')); return; }
      const reply = rawReply === 'always' ? 'always' : rawReply === 'reject' ? 'reject' : 'once';
      await this.replyPermission(pending, reply, locale);
      await this.messaging.answerCallback(event.callbackQueryId, reply);
      return;
    }
    if (event.data.startsWith(QUESTION_CALLBACK_PREFIX)) {
      const [key, questionRaw, optionRaw] = event.data.slice(QUESTION_CALLBACK_PREFIX.length).split(':');
      const pending = this.questions.get(`${key}:${event.scopeId}`);
      const questionIndex = Number.parseInt(questionRaw ?? '', 10);
      const question = pending?.request.questions[questionIndex];
      if (!pending || !question) { await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '已过期', 'Expired')); return; }
      if (optionRaw === 'done') {
        if (pending.answers[questionIndex]!.length === 0) { await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '请至少选择一项', 'Select at least one')); return; }
      } else {
        const optionIndex = Number.parseInt(optionRaw ?? '', 10);
        const label = question.options[optionIndex]?.label;
        if (!label) { await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '无效选项', 'Invalid option')); return; }
        if (question.multiple) {
          const answers = pending.answers[questionIndex]!;
          const existing = answers.indexOf(label);
          if (existing >= 0) answers.splice(existing, 1); else answers.push(label);
          await this.messaging.answerCallback(event.callbackQueryId, answers.join(', ') || localize(locale, '已清空', 'Cleared'));
          return;
        }
        pending.answers[questionIndex] = [label];
      }
      await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '已记录', 'Recorded'));
      await this.maybeSubmitQuestion(pending, locale);
    }
  }

  private async send(scopeId: string, text: string): Promise<number> {
    const chunks = chunkTelegramMessage(text);
    let first = 0;
    for (const chunk of chunks) {
      const id = await this.messaging.sendPlain(scopeId, chunk);
      if (!first) first = id;
    }
    return first;
  }

  private async sendFinalChunk(scopeId: string, markdown: string): Promise<number> {
    try {
      return await this.messaging.sendRichMarkdown(scopeId, markdown);
    } catch (error) {
      this.logger.warn('opencode.rich_send_failed', { error: error instanceof Error ? error.message : String(error) });
      return this.messaging.sendPlain(scopeId, markdown);
    }
  }

  private async editFinalChunk(scopeId: string, messageId: number, markdown: string): Promise<void> {
    try {
      await this.messaging.editRichMarkdown(scopeId, messageId, markdown);
    } catch (error) {
      this.logger.warn('opencode.rich_edit_failed', { error: error instanceof Error ? error.message : String(error) });
      await this.messaging.editPlain(scopeId, messageId, markdown);
    }
  }
}

function unwrap<T>(response: { data?: T; error?: unknown }, operation: string): NonNullable<T> {
  if (response.error !== undefined) throw new Error(`${operation}: ${formatSdkError(response.error)}`);
  if (response.data === undefined || response.data === null) throw new Error(`${operation}: OpenCode returned no data`);
  return response.data as NonNullable<T>;
}

function localize(locale: AppLocale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 17)}…` : value;
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function selectedLabel(selected: boolean, label: string): string {
  return selected ? `• ${label}` : label;
}

function formatStoredModel(value: string | null | undefined, locale: AppLocale): string {
  if (!value) return localize(locale, '服务端默认', 'server default');
  const parsed = parseStoredModel(value);
  return parsed ? `${parsed.providerId}/${parsed.modelId}` : value;
}

function randomKey(): string {
  return Math.random().toString(36).slice(2, 9);
}

function clampInt(raw: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function formatAge(timestamp: number, locale: AppLocale): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return localize(locale, `${seconds} 秒前`, `${seconds}s ago`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return localize(locale, `${minutes} 分钟前`, `${minutes}m ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return localize(locale, `${hours} 小时前`, `${hours}h ago`);
  const days = Math.round(hours / 24);
  return localize(locale, `${days} 天前`, `${days}d ago`);
}

function storeModel(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function parseStoredModel(value: string): { providerId: string; modelId: string } | null {
  const separator = value.indexOf('::');
  if (separator > 0) return { providerId: value.slice(0, separator), modelId: value.slice(separator + 2) };
  const slash = value.indexOf('/');
  return slash > 0 ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) } : null;
}

function readPrefs(settings: ChatSessionSettings | null): OpencodePrefs {
  const raw = settings?.serviceTier;
  if (!raw?.startsWith('opencode:')) return { agent: null, variant: null };
  try {
    const value = JSON.parse(raw.slice('opencode:'.length)) as Partial<OpencodePrefs>;
    return {
      agent: typeof value.agent === 'string' ? value.agent : null,
      variant: typeof value.variant === 'string' ? value.variant : null,
    };
  } catch {
    return { agent: null, variant: null };
  }
}

export function permissionRules(access: string): PermissionRuleset {
  if (access === 'read-only') return [
    { permission: 'edit', pattern: '*', action: 'deny' },
    { permission: 'bash', pattern: '*', action: 'deny' },
    { permission: 'external_directory', pattern: '*', action: 'deny' },
  ];
  return [];
}
