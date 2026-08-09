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
  lastFlush: number;
  toolMessageId: number | null;
  toolLines: Map<string, string>;
  toolTimer: ReturnType<typeof setTimeout> | null;
}

interface WatchState {
  sessionId: string;
  cwd: string;
  parts: Map<string, string>;
  messageIds: number[];
  renderedChunks: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
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
  kind: 'model' | 'access' | 'mode' | 'open' | 'watch';
  value: string;
}

interface ModelChoice {
  providerId: string;
  modelId: string;
  name: string;
  variants: string[];
}

interface OpencodePrefs {
  agent: string | null;
  variant: string | null;
}

const UNSUPPORTED_COMMANDS = new Set([
  'account', 'apps', 'archive', 'auth', 'auth_reload', 'codex_restart', 'fast', 'features',
  'goal', 'goal_clear', 'goal_done', 'goal_pause', 'goal_resume', 'hooks', 'login',
  'login_cancel', 'login_device', 'logout', 'plugin', 'plugin_skill', 'plugins', 'quota',
  'remote', 'requirements', 'review', 'rollback', 'service_tier', 'thread_archive',
  'thread_unarchive', 'undo', 'unarchive', 'update',
]);

/** Telegram-facing OpenCode runtime. It shares FoxClaw's gateway/store/rendering primitives. */
export class OpencodeBridgeCore {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly watchers = new Map<string, WatchState>();
  private readonly queuedPrompts = new Map<string, QueuedPrompt[]>();
  private readonly permissions = new Map<string, PendingPermissionUi>();
  private readonly questions = new Map<string, PendingQuestionUi>();
  private readonly setupActions = new Map<string, SetupAction>();
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
      await this.send(scopeId, localize(locale,
        `/${name} 在 OpenCode runtime 上不可用。`,
        `/${name} is not available on the OpenCode runtime.`));
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
      case 'models': await this.showModels(scopeId, locale); return;
      case 'model': await this.setModel(scopeId, args.join(' ').trim(), locale); return;
      case 'effort': await this.setVariant(scopeId, args.join(' ').trim(), locale); return;
      case 'mode': await this.setMode(scopeId, args[0] ?? '', locale); return;
      case 'plan': await this.setMode(scopeId, 'plan', locale); return;
      case 'agent': await this.setAgent(scopeId, args.join(' ').trim(), locale); return;
      case 'permissions':
      case 'access': await this.setAccess(scopeId, args.join(' ').trim(), locale); return;
      case 'active': await this.setActiveMode(scopeId, args[0] ?? '', locale); return;
      case 'history': await this.showHistory(scopeId, args[0] ?? '', locale); return;
      case 'rename': await this.renameSession(scopeId, args.join(' ').trim(), locale); return;
      case 'fork': await this.forkSession(scopeId, args.join(' ').trim(), locale); return;
      case 'diff': await this.showDiff(scopeId, locale); return;
      case 'where': await this.showWhere(scopeId, locale); return;
      case 'files': await this.findFiles(scopeId, args.join(' ').trim(), locale); return;
      case 'compact': await this.compactSession(scopeId, locale); return;
      case 'loaded': await this.showLoaded(scopeId, locale); return;
      case 'skills': await this.showSkills(scopeId, locale); return;
      case 'mcp': await this.showMcp(scopeId, locale); return;
      case 'provider': await this.showProviders(scopeId, locale); return;
      case 'config': await this.showConfig(scopeId, locale); return;
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
      '/new [目录] · 新建会话', '/threads [关键词] · 最近会话', '/open <编号|ID> · 打开会话',
      '/watch [编号|ID] · 观察会话', '/unwatch · 停止观察', '/setup · 设置面板',
      '/models · 模型列表', '/model <编号|provider/model|default> · 选择模型', '/effort <variant|default> · 推理档位',
      '/mode <default|plan> · 模式', '/plan · 下一轮 Plan', '/agent [名称] · Agent',
      '/permissions <read-only|default|full-access> · 权限', '/active <steer|queue> · 运行中新消息',
      '/history [数量] · 历史', '/rename <名称> · 重命名', '/fork [名称] · 分叉', '/diff · 变更',
      '/where · 当前目录', '/files <关键词> · 文件搜索', '/compact · 压缩上下文', '/loaded · 活跃会话',
      '/skills · Skills', '/mcp · MCP 状态', '/provider · Provider', '/config · 配置摘要',
      '/approve · 待审批', '/answer · 待回答', '/interrupt · 中断', '/status · 状态', '',
      '直接发送文本、图片或文件会继续当前会话；没有绑定时会自动新建。',
      '/undo 与 /rollback 不会近似映射，避免误回滚文件。',
    ].join('\n');
    const en = [
      '⚡ OpenCode bridge commands', '',
      '/new [dir] · new session', '/threads [query] · recent sessions', '/open <number|ID> · bind session',
      '/watch [number|ID] · watch session', '/unwatch · stop watching', '/setup · settings panel',
      '/models · models', '/model <number|provider/model|default> · select model', '/effort <variant|default> · reasoning variant',
      '/mode <default|plan> · mode', '/plan · Plan next turn', '/agent [name] · agent',
      '/permissions <read-only|default|full-access> · access', '/active <steer|queue> · messages during a turn',
      '/history [n] · history', '/rename <name> · rename', '/fork [name] · fork', '/diff · changes',
      '/where · directory', '/files <query> · find files', '/compact · compact context', '/loaded · active sessions',
      '/skills · skills', '/mcp · MCP status', '/provider · providers', '/config · config summary',
      '/approve · approvals', '/answer · questions', '/interrupt · abort', '/status · status', '',
      'Plain text, images, and files continue the bound session, creating one when needed.',
      '/undo and /rollback stay unsupported to avoid approximating file rollback semantics.',
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
    const response = await this.app.getClient().experimental.session.list({
      ...(search ? { search } : {}),
      limit: Math.max(THREAD_LIST_LIMIT, this.config.threadListLimit),
    });
    const sessions = unwrap(response, 'session.list').filter((session) => !session.time.archived);
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
      updatedAt: session.time.updated,
    })));
    const bound = this.store.getBinding(scopeId)?.threadId;
    const lines = [localize(locale, 'OpenCode 会话：', 'OpenCode sessions:'), ''];
    sessions.forEach((session, index) => {
      const marker = session.id === bound ? '●' : statuses[session.id]?.type === 'busy' ? '◐' : '○';
      lines.push(`${marker} ${index + 1}. ${session.title || session.slug}`);
      lines.push(`   \`${shortId(session.id)}\` · \`${session.directory}\` · ${formatAge(session.time.updated, locale)}`);
    });
    lines.push('', localize(locale, '使用 /open <编号> 打开。', 'Use /open <number> to bind.'));
    const keyboard = this.setupKeyboard(sessions.slice(0, 10).map((session, index) => [
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
      `${localize(locale, '模型', 'Model')}: ${settings?.model ?? localize(locale, '服务端默认', 'server default')}`,
      `${localize(locale, '档位', 'Variant')}: ${prefs.variant ?? localize(locale, '默认', 'default')}`,
      `${localize(locale, 'Agent', 'Agent')}: ${settings?.collaborationMode === 'plan' ? 'plan' : prefs.agent ?? 'build'}`,
      `${localize(locale, '权限', 'Access')}: ${settings?.accessPreset ?? 'default'}`,
      `${localize(locale, '运行中新消息', 'Active messages')}: ${settings?.activeTurnMessageMode ?? 'steer'}`,
      `${localize(locale, '回复', 'Turn')}: ${turn ? '⏳' : 'idle'} · ${localize(locale, '排队', 'queued')} ${this.queuedPrompts.get(scopeId)?.length ?? 0}`,
    ];
    await this.send(scopeId, lines.join('\n'));
  }

  private async showSetup(scopeId: string, locale: AppLocale): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const prefs = readPrefs(settings);
    const actions: Array<Array<{ label: string; action: SetupAction }>> = [
      [
        { label: '🔒 read-only', action: { scopeId, kind: 'access', value: 'read-only' } },
        { label: '🛂 default', action: { scopeId, kind: 'access', value: 'default' } },
        { label: '🔓 full-access', action: { scopeId, kind: 'access', value: 'full-access' } },
      ],
      [
        { label: '🤖 Agent', action: { scopeId, kind: 'mode', value: 'default' } },
        { label: '📝 Plan', action: { scopeId, kind: 'mode', value: 'plan' } },
      ],
    ];
    const keyboard = this.setupKeyboard(actions);
    const text = localize(locale,
      `⚙️ OpenCode 设置\n\n模型：${settings?.model ?? '服务端默认'}\nVariant：${prefs.variant ?? 'default'}\nAgent：${prefs.agent ?? 'build'}\n权限：${settings?.accessPreset ?? 'default'}\n模式：${settings?.collaborationMode ?? 'default'}\n\n模型选择：/models\n推理档位：/effort`,
      `⚙️ OpenCode settings\n\nModel: ${settings?.model ?? 'server default'}\nVariant: ${prefs.variant ?? 'default'}\nAgent: ${prefs.agent ?? 'build'}\nAccess: ${settings?.accessPreset ?? 'default'}\nMode: ${settings?.collaborationMode ?? 'default'}\n\nModels: /models\nReasoning variant: /effort`);
    await this.messaging.sendPlain(scopeId, text, keyboard);
  }

  private setupKeyboard(rows: Array<Array<{ label: string; action: SetupAction }>>): InlineKeyboard {
    return rows.map((row) => row.map((entry) => {
      const key = randomKey();
      this.setupActions.set(key, entry.action);
      return { text: entry.label, callback_data: `${SETUP_CALLBACK_PREFIX}${key}` };
    }));
  }

  private async listModels(cwd?: string | null): Promise<ModelChoice[]> {
    const response = await this.app.getClient().provider.list({ ...(cwd ? { directory: cwd } : {}) });
    const data = unwrap(response, 'provider.list');
    const connected = new Set(data.connected);
    return data.all
      .filter((provider) => connected.has(provider.id))
      .flatMap((provider) => Object.values(provider.models).map((model) => ({
        providerId: provider.id,
        modelId: model.id,
        name: model.name,
        variants: Object.entries(model.variants ?? {}).filter(([, value]) => value.disabled !== true).map(([key]) => key),
      })))
      .sort((a, b) => `${a.providerId}/${a.name}`.localeCompare(`${b.providerId}/${b.name}`));
  }

  private async showModels(scopeId: string, locale: AppLocale): Promise<void> {
    const models = await this.listModels(this.store.getBinding(scopeId)?.cwd);
    if (models.length === 0) {
      await this.send(scopeId, localize(locale, '没有已连接 Provider 的模型。请先在终端运行 opencode auth。', 'No models from connected providers. Run opencode auth in a terminal.'));
      return;
    }
    const rows = models.slice(0, 18).map((model, index) => `${index + 1}. ${model.name} · \`${model.providerId}/${model.modelId}\``);
    const buttonRows = models.slice(0, 12).map((model, index) => [{
      label: `${index + 1}. ${clip(model.name, 28)}`,
      action: { scopeId, kind: 'model' as const, value: storeModel(model.providerId, model.modelId) },
    }]);
    await this.messaging.sendPlain(scopeId, [localize(locale, '可用模型：', 'Available models:'), '', ...rows,
      ...(models.length > 18 ? [localize(locale, `…其余 ${models.length - 18} 个可用 /model provider/model 选择。`, `…${models.length - 18} more; use /model provider/model.`)] : []),
    ].join('\n'), this.setupKeyboard(buttonRows));
  }

  private async setModel(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    if (!raw) { await this.showModels(scopeId, locale); return; }
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
      if (!model) {
        await this.send(scopeId, localize(locale, '先用 /model 选择模型，再查看 variant。', 'Choose a model with /model before listing variants.'));
        return;
      }
      const choices = await this.listModels(this.store.getBinding(scopeId)?.cwd);
      const selected = choices.find((item) => item.providerId === model.providerId && item.modelId === model.modelId);
      await this.send(scopeId, selected?.variants.length
        ? localize(locale, `可用 variant：${selected.variants.map((item) => `\`${item}\``).join('、')}\n当前：${prefs.variant ?? 'default'}`, `Variants: ${selected.variants.map((item) => `\`${item}\``).join(', ')}\nCurrent: ${prefs.variant ?? 'default'}`)
        : localize(locale, '当前模型没有可选 variant。', 'The selected model has no variants.'));
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
      const current = this.store.getChatSettings(scopeId)?.collaborationMode ?? 'default';
      await this.send(scopeId, localize(locale, `当前模式：${current}\n用法：/mode <default|plan>`, `Current mode: ${current}\nUsage: /mode <default|plan>`));
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
      const response = await this.app.getClient().app.agents({ directory: this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd });
      const agents = unwrap(response, 'agent.list').filter((agent) => !agent.hidden && agent.mode !== 'subagent');
      await this.send(scopeId, [
        localize(locale, `当前 Agent：${prefs.agent ?? 'build'}`, `Current agent: ${prefs.agent ?? 'build'}`),
        '',
        ...agents.map((agent) => `• \`${agent.name}\`${agent.description ? ` — ${clip(agent.description, 100)}` : ''}`),
        '',
        localize(locale, '使用 /agent <名称> 选择。', 'Use /agent <name> to select.'),
      ].join('\n'));
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
    this.store.setChatAccessPreset(scopeId, raw);
    const binding = this.store.getBinding(scopeId);
    if (binding) {
      const response = await this.app.getClient().session.update({
        sessionID: binding.threadId,
        ...(binding.cwd ? { directory: binding.cwd } : {}),
        permission: permissionRules(raw),
      });
      if (response.error) throw new Error(formatSdkError(response.error));
    }
    await this.send(scopeId, localize(locale, `权限 → ${raw}`, `Access → ${raw}`));
  }

  private async setActiveMode(scopeId: string, raw: string, locale: AppLocale): Promise<void> {
    if (!raw) {
      await this.send(scopeId, localize(locale,
        `当前：${this.store.getChatSettings(scopeId)?.activeTurnMessageMode ?? 'steer'}\n用法：/active <steer|queue>`,
        `Current: ${this.store.getChatSettings(scopeId)?.activeTurnMessageMode ?? 'steer'}\nUsage: /active <steer|queue>`));
      return;
    }
    if (raw !== 'steer' && raw !== 'queue') throw new Error(localize(locale, '用法：/active <steer|queue>', 'Usage: /active <steer|queue>'));
    this.store.setChatActiveTurnMessageMode(scopeId, raw);
    await this.send(scopeId, localize(locale, `运行中新消息 → ${raw}`, `Active-turn messages → ${raw}`));
  }

  private writePrefs(scopeId: string, prefs: OpencodePrefs): void {
    this.store.setChatServiceTier(scopeId, `opencode:${JSON.stringify(prefs)}`);
  }

  private async dispatchPrompt(event: TelegramTextEvent, text: string, locale: AppLocale): Promise<void> {
    const active = this.activeTurns.get(event.scopeId);
    const activeMode = this.store.getChatSettings(event.scopeId)?.activeTurnMessageMode ?? 'steer';
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
    if (!active) {
      this.activeTurns.set(event.scopeId, {
        sessionId: session.id,
        cwd,
        parts: new Map(),
        messageIds: [],
        renderedChunks: [],
        flushTimer: null,
        lastFlush: 0,
        toolMessageId: null,
        toolLines: new Map(),
        toolTimer: null,
      });
    }
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

  private async showMcp(scopeId: string, locale: AppLocale): Promise<void> {
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const servers = unwrap(await this.app.getClient().mcp.status({ directory: cwd }), 'mcp.status');
    const entries = Object.entries(servers);
    if (entries.length === 0) { await this.send(scopeId, localize(locale, '没有配置 MCP server。', 'No MCP servers configured.')); return; }
    const icon = (status: string): string => status === 'connected' ? '✅' : status === 'failed' ? '❌' : status === 'needs_auth' ? '🔑' : '⚪';
    await this.send(scopeId, [localize(locale, 'MCP 状态：', 'MCP status:'), '', ...entries.map(([name, value]) => `${icon(value.status)} \`${name}\` · ${value.status}${'error' in value ? ` · ${value.error}` : ''}`)].join('\n'));
  }

  private async showProviders(scopeId: string, locale: AppLocale): Promise<void> {
    const cwd = this.store.getBinding(scopeId)?.cwd ?? this.config.defaultCwd;
    const data = unwrap(await this.app.getClient().provider.list({ directory: cwd }), 'provider.list');
    const connected = new Set(data.connected);
    const lines = [localize(locale, '模型 Provider：', 'Model providers:'), ''];
    for (const provider of data.all) lines.push(`${connected.has(provider.id) ? '✅' : '○'} \`${provider.id}\` · ${provider.name} · ${Object.keys(provider.models).length} models`);
    await this.send(scopeId, lines.join('\n'));
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
      if (action.kind === 'model') {
        const parsed = parseStoredModel(action.value)!;
        this.store.setChatSettings(event.scopeId, action.value, null);
        this.writePrefs(event.scopeId, { ...readPrefs(this.store.getChatSettings(event.scopeId)), variant: null });
        await this.messaging.answerCallback(event.callbackQueryId, `${parsed.providerId}/${parsed.modelId}`);
      } else if (action.kind === 'access') {
        await this.setAccess(event.scopeId, action.value, locale);
        await this.messaging.answerCallback(event.callbackQueryId, action.value);
      } else if (action.kind === 'mode') {
        await this.setMode(event.scopeId, action.value, locale);
        await this.messaging.answerCallback(event.callbackQueryId, action.value);
      } else if (action.kind === 'open') {
        await this.openSession(event.scopeId, action.value, locale);
        await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '已打开', 'Opened'));
      } else {
        await this.watchSession(event.scopeId, action.value, locale);
        await this.messaging.answerCallback(event.callbackQueryId, localize(locale, '正在观察', 'Watching'));
      }
      this.setupActions.delete(key);
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
