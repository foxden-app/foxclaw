import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AppConfig } from '../config.js';
import { TelegramMessagingPort, type InlineKeyboard } from '../channels/telegram/telegram_messaging_port.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { AppLocale, RuntimeStatus } from '../types.js';
import { chunkTelegramMessage } from '../telegram/text.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import { escapeTelegramHtml } from '../telegram/html.js';
import { AntigravityAppClient } from './client.js';
import { formatQuotaResetTime, AntigravityAuthManager, type AntigravityAccount } from './auth.js';
import { AntigravityConversationManager, formatAge, type AntigravityConversation } from './conversations.js';
import { UnifiedChannelOrchestrator } from '../core/orchestrator.js';
import { AntigravityEngineAdapter } from './adapter.js';
import { CodexEngineAdapter } from '../codex_app/adapter.js';
import type { CodexAppClient, CodexAppServerRuntimeStatus } from '../codex_app/client.js';
import { OpencodeEngineAdapter } from '../opencode/adapter.js';
import type { OpencodeAppClient } from '../opencode/client.js';
import type { BackendDescriptor, IEngineAdapter } from '../core/engine_spi.js';
import { BridgeSessionCore } from '../controller/controller.js';
import { BridgeMessagingRouter } from '../channels/bridge_messaging_router.js';
import { BRIDGE_SCOPE_WEIXIN_PREFIX } from '../core/bridge_scope.js';
import { syncCodexLocalUsageToStore } from '../store/token_usage.js';

export interface UnifiedBridgeRuntimeStatus {
  running: boolean;
  connected: boolean;
  activeTurns: number;
  botUsername: string | null;
  codexHome: string;
  codexAppServer?: CodexAppServerRuntimeStatus | undefined;
  userAgent: string | null;
  authProactiveRefresh?: RuntimeStatus['authProactiveRefresh'];
  lastError?: string | null | undefined;
}

function formatCandidateButtonPrefix(c: AntigravityAccount): string {
  const p5h = typeof c.quota?.fiveHourPercent === 'number' ? `${c.quota.fiveHourPercent}%` : '—';
  const pw = typeof c.quota?.weeklyPercent === 'number' ? `${c.quota.weeklyPercent}%` : '—';
  return `${p5h}|${pw}`;
}

function formatCandidateDisplayName(c: AntigravityAccount): string {
  if (c.email) {
    return c.email.replace(/@gmail\.com$/i, '');
  }
  return c.name.replace(/^antigravity-oauth-token_/, '');
}

function formatAccountExpiry(expiryMs: number | null, locale: AppLocale, isActive = false): string {
  if (!expiryMs) return locale === 'zh' ? '未知' : 'unknown';
  const now = Date.now();
  if (expiryMs <= now) {
    if (isActive) {
      return locale === 'zh' ? '待命中 (发任务时即时刷新)' : 'standby (refreshes on task)';
    }
    return locale === 'zh' ? '待命中 (就绪 · 切号时即时激活)' : 'standby (ready · refreshes on switch)';
  }
  const remainingMins = Math.round((expiryMs - now) / 60000);
  const timeStr = new Date(expiryMs).toTimeString().slice(0, 5);
  return locale === 'zh'
    ? `${timeStr} (剩 ${remainingMins} 分钟)`
    : `${timeStr} (${remainingMins}m left)`;
}

const AGY_MODEL_CALLBACK_PREFIX = 'agy:m:';
const AGY_AUTH_CALLBACK_PREFIX = 'agy:a:';
const AGY_EFFORT_CALLBACK_PREFIX = 'agy:e:';
const AGY_OPEN_CALLBACK_PREFIX = 'agy:open:';
const AGY_SETUP_CALLBACK_PREFIX = 'agy:setup:';
const AGY_WATCH_CALLBACK_PREFIX = 'agy:w:';

interface AntigravityWatcher {
  scopeId: string;
  conversationId: string;
  transcriptPath: string;
  fileOffset: number;
  remainder: string;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  messageId: number | null;
  currentToolLines: string[];
  lastContentPreview: string;
}

export interface UnifiedBridgeCoreOptions {
  codexApp?: CodexAppClient | undefined;
  codexAdapter?: CodexEngineAdapter | undefined;
  codexCore?: BridgeSessionCore | undefined;
  antigravityApp?: AntigravityAppClient | undefined;
  antigravityAuth?: AntigravityAuthManager | undefined;
  antigravityAdapter?: AntigravityEngineAdapter | undefined;
  opencodeApp?: OpencodeAppClient | undefined;
  opencodeAdapter?: OpencodeEngineAdapter | undefined;
  defaultBackendId?: 'antigravity' | 'codex' | 'opencode' | string | undefined;
}

export class UnifiedBridgeCore {
  private readonly config: AppConfig;
  private readonly store: BridgeStore;
  private readonly logger: Logger;
  private readonly bot: TelegramGateway;
  private readonly app: AntigravityAppClient;
  private readonly auth: AntigravityAuthManager;
  private readonly conversations: AntigravityConversationManager;
  private readonly messaging: TelegramMessagingPort;
  private readonly adapter: AntigravityEngineAdapter;
  private readonly codexAdapter?: CodexEngineAdapter | undefined;
  private readonly codexApp?: CodexAppClient | undefined;
  readonly codexCore?: BridgeSessionCore | undefined;
  private readonly opencodeAdapter?: OpencodeEngineAdapter | undefined;
  private readonly defaultBackendId: string;
  private readonly orchestrator: UnifiedChannelOrchestrator;
  private readonly watchers = new Map<string, AntigravityWatcher>();
  private readonly pendingAgyRenames = new Map<string, { conversationId: string }>();
  private readonly stalePanelDeleteTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    config: AppConfig,
    store: BridgeStore,
    logger: Logger,
    bot: TelegramGateway,
    app?: AntigravityAppClient | undefined,
    auth?: AntigravityAuthManager | undefined,
    messaging?: TelegramMessagingPort | undefined,
    options?: UnifiedBridgeCoreOptions,
  ) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.bot = bot;
    this.auth = options?.antigravityAuth ?? auth ?? new AntigravityAuthManager(config.antigravityAuthDir, logger);
    this.app = options?.antigravityApp ?? app ?? new AntigravityAppClient(config.antigravityCliBin, logger);
    this.conversations = new AntigravityConversationManager(config.antigravityAuthDir, logger);
    this.messaging = messaging ?? new TelegramMessagingPort(bot);
    this.codexApp = options?.codexApp;
    this.defaultBackendId = options?.defaultBackendId ?? 'antigravity';

    this.codexCore = options?.codexCore;
    if (!this.codexCore && options?.codexApp) {
      try {
        this.codexCore = new BridgeSessionCore(
          this.config,
          this.store,
          this.logger,
          this.bot,
          options.codexApp,
          new BridgeMessagingRouter(this.messaging, null),
          null,
          null,
          false,
        );
      } catch (err) {
        this.logger.warn('unified.codex_core_init_failed', { error: String(err) });
      }
    }

    this.adapter = options?.antigravityAdapter ?? new AntigravityEngineAdapter(
      this.app,
      config.antigravityDefaultModel,
      this.auth,
      logger,
    );

    if (options?.codexAdapter) {
      this.codexAdapter = options.codexAdapter;
    } else if (options?.codexApp) {
      this.codexAdapter = new CodexEngineAdapter(options.codexApp, {
        defaultModel: 'gpt-4o',
      });
    }

    if (options?.opencodeAdapter) {
      this.opencodeAdapter = options.opencodeAdapter;
    } else if (options?.opencodeApp) {
      this.opencodeAdapter = new OpencodeEngineAdapter(options.opencodeApp);
    }

    const isCodexDefault = this.defaultBackendId === 'codex';
    const isOpencodeDefault = this.defaultBackendId === 'opencode';
    const primaryAdapter = isCodexDefault && this.codexAdapter
      ? this.codexAdapter
      : isOpencodeDefault && this.opencodeAdapter
        ? this.opencodeAdapter
        : this.adapter;

    const initialBackends: BackendDescriptor[] = [];
    if (isCodexDefault && this.codexAdapter) {
      initialBackends.push({
        id: 'codex',
        name: 'OpenAI Codex (App Server)',
        engineType: 'codex',
        adapter: this.codexAdapter,
        isDefault: true,
      });
      initialBackends.push({
        id: 'antigravity',
        name: 'Google Antigravity (AGY)',
        engineType: 'antigravity',
        adapter: this.adapter,
        isDefault: false,
      });
    } else {
      initialBackends.push({
        id: 'antigravity',
        name: 'Google Antigravity (AGY)',
        engineType: 'antigravity',
        adapter: this.adapter,
        isDefault: !isOpencodeDefault,
      });
      if (this.codexAdapter) {
        initialBackends.push({
          id: 'codex',
          name: 'OpenAI Codex (App Server)',
          engineType: 'codex',
          adapter: this.codexAdapter,
          isDefault: false,
        });
      }
    }
    if (this.opencodeAdapter) {
      initialBackends.push({
        id: 'opencode',
        name: 'OpenCode (SDK)',
        engineType: 'opencode',
        adapter: this.opencodeAdapter,
        isDefault: isOpencodeDefault,
      });
    }

    const allAdapters: IEngineAdapter[] = [this.adapter];
    if (this.codexAdapter) allAdapters.push(this.codexAdapter);
    if (this.opencodeAdapter) allAdapters.push(this.opencodeAdapter);

    this.orchestrator = new UnifiedChannelOrchestrator({
      config,
      store,
      logger,
      bot,
      adapter: primaryAdapter,
      adapters: allAdapters,
      backends: initialBackends,
      defaultBackendId: this.defaultBackendId,
      backendProvider: () => this.getBackendDescriptors(),
      messaging: this.messaging,
      customUi: {
        renderCustomStatus: (scopeId, locale) => this.renderCustomStatus(scopeId, locale),
        renderCustomSetupRows: (scopeId, locale) => this.renderCustomSetupRows(scopeId, locale),
        handleCustomCallback: (scopeId, data, locale, messageId, event) =>
          this.handleCustomCallback(scopeId, data, locale, messageId, event),
        handleCustomCommand: (scopeId, command, args, locale, event) =>
          this.handleCustomCommand(scopeId, command, args, locale, event),
        handleCustomInbound: (event, locale) => this.handleCustomInbound(event, locale),
      },
    });
  }

  private async getBackendDescriptors(): Promise<BackendDescriptor[]> {
    const list: BackendDescriptor[] = [];
    const isCodexDefault = this.defaultBackendId === 'codex';

    const active = await this.auth.getActiveAccount();
    const activeQuota = active?.quota
      ? `${formatCandidateButtonPrefix(active)} · ${formatAccountExpiry(active.expiry, 'zh', true)}`
      : undefined;

    const agyPrimary: BackendDescriptor = {
      id: 'antigravity',
      name: 'Google Antigravity (AGY)',
      engineType: 'antigravity',
      adapter: this.adapter,
      account: active?.email || active?.name || 'default',
      details: activeQuota,
      isDefault: !isCodexDefault,
    };

    let codexPrimary: BackendDescriptor | null = null;
    if (this.codexAdapter) {
      const codexHome = this.config.codexAuthDir ?? this.config.codexHome ?? path.join(os.homedir(), '.codex');
      let currentCodexAccount = 'default';
      try {
        const authPath = path.join(codexHome, 'auth.json');
        const stat = await fsPromises.lstat(authPath).catch(() => null);
        if (stat?.isSymbolicLink()) {
          const target = await fsPromises.readlink(authPath);
          currentCodexAccount = path.basename(target).replace(/^auth\.json_/, '');
        }
      } catch {
        // ignore
      }

      codexPrimary = {
        id: 'codex',
        name: 'OpenAI Codex (App Server)',
        engineType: 'codex',
        adapter: this.codexAdapter,
        account: currentCodexAccount,
        details: 'Official Codex App runtime',
        isDefault: isCodexDefault,
      };
    }

    let opencodePrimary: BackendDescriptor | null = null;
    if (this.opencodeAdapter) {
      opencodePrimary = {
        id: 'opencode',
        name: 'OpenCode (SDK)',
        engineType: 'opencode',
        adapter: this.opencodeAdapter,
        account: 'default',
        details: 'OpenCode CLI / Server',
        isDefault: false,
      };
    }

    if (isCodexDefault) {
      if (codexPrimary) list.push(codexPrimary);
      list.push(agyPrimary);
      if (opencodePrimary) list.push(opencodePrimary);
    } else {
      list.push(agyPrimary);
      if (codexPrimary) list.push(codexPrimary);
      if (opencodePrimary) list.push(opencodePrimary);
    }

    return list;
  }

  registerInboundHandlers(): void {
    this.orchestrator.registerInboundHandlers();
  }

  registerTelegramInboundHandlers(): void {
    this.registerInboundHandlers();
  }

  dispatchInboundLikeTelegramText(event: TelegramTextEvent): void {
    this.orchestrator.dispatchInboundLikeTelegramText(event);
  }

  async startCodexApp(): Promise<void> {
    if (this.codexApp && typeof this.codexApp.isConnected === 'function' && !this.codexApp.isConnected()) {
      if (typeof this.codexApp.start === 'function') {
        await this.codexApp.start().catch((err) => {
          this.logger.warn('codex.app.start_failed', { error: String(err) });
        });
      }
    }
  }

  async startTelegramPolling(): Promise<void> {
    await this.start();
  }

  async start(): Promise<void> {
    await this.startCodexApp();
    await this.orchestrator.start();
    this.auth.startKeepAlive();
    this.logger.info('bridge.started', { defaultBackendId: this.defaultBackendId });
    void syncCodexLocalUsageToStore(this.store, this.config.codexHome ?? undefined);

    // Restore persisted watchers on startup
    try {
      const persisted = this.store.listWatchedThreads();
      for (const item of persisted) {
        this.watchConversation(item.scopeId, item.threadId, 'zh', undefined, false).catch((err) => {
          this.logger.warn('antigravity.restore_watcher_failed', { scopeId: item.scopeId, error: String(err) });
        });
      }
    } catch (err) {
      this.logger.warn('antigravity.restore_watchers_error', { error: String(err) });
    }
  }

  async stop(): Promise<void> {
    await this.orchestrator.stop();
    this.auth.stopKeepAlive();
    for (const [scopeId, watcher] of this.watchers.entries()) {
      watcher.stopped = true;
      if (watcher.timer) clearTimeout(watcher.timer);
      this.watchers.delete(scopeId);
    }
  }

  getRuntimeStatus(): UnifiedBridgeRuntimeStatus {
    const isConnected = this.codexApp && typeof this.codexApp.isConnected === 'function'
      ? this.codexApp.isConnected()
      : true;
    return {
      running: true,
      connected: isConnected,
      activeTurns: this.orchestrator.getActiveTurnsCount(),
      botUsername: this.bot.username,
      codexHome: this.config.codexHome ?? this.config.codexAuthDir ?? path.join(os.homedir(), '.codex'),
      ...(this.codexApp && typeof this.codexApp.getServerStatus === 'function' && this.codexApp.getServerStatus()
        ? { codexAppServer: this.codexApp.getServerStatus() }
        : {}),
      userAgent: this.codexApp && typeof this.codexApp.getUserAgent === 'function'
        ? this.codexApp.getUserAgent()
        : null,
    };
  }

  isIdleForServiceUpdate(): boolean {
    return this.orchestrator.getActiveTurnsCount() === 0;
  }

  async getCurrentAuthLabel(): Promise<string | null> {
    const codexHome = this.config.codexAuthDir ?? this.config.codexHome ?? path.join(os.homedir(), '.codex');
    try {
      const authPath = path.join(codexHome, 'auth.json');
      const stat = await fsPromises.lstat(authPath).catch(() => null);
      if (stat?.isSymbolicLink()) {
        const target = await fsPromises.readlink(authPath);
        return path.basename(target).replace(/^auth\.json_/, '');
      }
    } catch {}
    return 'default';
  }

  async handleExternalCodexAuthCandidateDeleted(candidateName: string, _reason: string | null = null): Promise<void> {
    this.store.deleteCodexAuthCandidate(candidateName);
    if (this.codexApp) {
      await this.codexApp.restart().catch(() => {});
    }
  }

  async validateExternalCodexAuthCandidate(
    _candidateName: string,
    _rawAuth: string,
    _expectedAccountId: string,
  ): Promise<{ ok: boolean; reason?: string | null }> {
    return { ok: true };
  }

  private async sendMessage(scopeId: string, text: string, inlineKeyboard?: InlineKeyboard): Promise<number> {
    try {
      return await this.messaging.sendRichMarkdown(scopeId, text, inlineKeyboard);
    } catch {
      return this.messaging.sendPlain(scopeId, text, inlineKeyboard);
    }
  }

  private async editMessage(
    scopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<void> {
    try {
      await this.messaging.editRichMarkdown(scopeId, messageId, text, inlineKeyboard);
    } catch {
      await this.messaging.editPlain(scopeId, messageId, text, inlineKeyboard);
    }
  }

  scheduleStalePanelDeletion(scopeId: string, messageId: number): void {
    if (this.config.telegramPanelTtlMs <= 0 || scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      return;
    }
    const key = `${scopeId}:${messageId}`;
    const existing = this.stalePanelDeleteTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.stalePanelDeleteTimers.delete(key);
      if (typeof this.messaging?.deleteMessage === 'function') {
        void this.messaging.deleteMessage(scopeId, messageId).catch((error) => {
          this.logger.debug('telegram.stale_panel_delete_failed', { scopeId, messageId, error: String(error) });
        });
      }
    }, this.config.telegramPanelTtlMs);
    timer.unref();
    this.stalePanelDeleteTimers.set(key, timer);
  }

  private async renderCustomStatus(scopeId: string, locale: AppLocale): Promise<string> {
    const activeBackend = this.orchestrator.getBackendDescriptorForScope(scopeId);
    if (activeBackend.engineType === 'codex') {
      const codexHome = this.config.codexAuthDir ?? this.config.codexHome ?? path.join(os.homedir(), '.codex');
      let currentCodexAccount = 'default';
      try {
        const authPath = path.join(codexHome, 'auth.json');
        const stat = await fsPromises.lstat(authPath).catch(() => null);
        if (stat?.isSymbolicLink()) {
          const target = await fsPromises.readlink(authPath);
          currentCodexAccount = path.basename(target).replace(/^auth\.json_/, '');
        }
      } catch {}

      const binding = this.store.getBinding(scopeId);
      const threadLine = binding?.threadId
        ? (locale === 'zh' ? `\n• **当前会话**: \`${binding.threadId.slice(0, 16)}…\`` : `\n• **Thread**: \`${binding.threadId.slice(0, 16)}…\``)
        : (locale === 'zh' ? `\n• **当前会话**: \`新会话就绪 (发送消息开启)\`` : `\n• **Thread**: \`Ready (new)\``);
      const cwdLine = `\n• **工作目录**: \`${binding?.cwd || this.config.defaultCwd}\``;

      return (
        (locale === 'zh'
          ? `• **Codex 账号**: \`${currentCodexAccount}\` (软链接管理)\n• **执行引擎**: \`OpenAI Codex App Server\``
          : `• **Codex Account**: \`${currentCodexAccount}\`\n• **Engine**: \`OpenAI Codex App Server\``) +
        threadLine +
        cwdLine
      );
    }

    const activeAccount = await this.auth.getActiveAccount();
    const candidates = await this.auth.listCandidates();

    const currentWatcher = this.watchers.get(scopeId);
    let watchLine = '';
    if (currentWatcher && !currentWatcher.stopped) {
      watchLine =
        locale === 'zh'
          ? `\n• **观察状态**: 👁 正在观察 \`${currentWatcher.conversationId.slice(0, 8)}\``
          : `\n• **Watching**: 👁 Observing \`${currentWatcher.conversationId.slice(0, 8)}\``;
    }

    let quotaLine = '';
    if (activeAccount) {
      const q = activeAccount.quota ?? (await this.auth.fetchQuotaForAccount(activeAccount.name));
      if (q) {
        const p5h = typeof q.fiveHourPercent === 'number' ? `${q.fiveHourPercent}%` : '—';
        const pw = typeof q.weeklyPercent === 'number' ? `${q.weeklyPercent}%` : '—';
        quotaLine =
          locale === 'zh'
            ? `\n• **5h/7d 额度**: \`${p5h} | ${pw}\` (剩余百分比)`
            : `\n• **5h/7d Quota**: \`${p5h} | ${pw}\` (remaining %)`;
      } else {
        quotaLine =
          locale === 'zh'
            ? `\n• **5h/7d 额度**: \`未获取到\` (在 /auth 中可实时刷新)`
            : `\n• **5h/7d Quota**: \`Not available\` (refresh in /auth)`;
      }
    }

    return (
      (locale === 'zh'
        ? `• **当前账号**: \`${activeAccount?.email ?? activeAccount?.name ?? '未知'}\` (共 ${candidates.length} 个账号)`
        : `• **Account**: \`${activeAccount?.email ?? activeAccount?.name ?? 'unknown'}\` (${candidates.length} candidates)`) +
      quotaLine +
      watchLine
    );
  }

  private async renderCustomSetupRows(scopeId: string, _locale: AppLocale): Promise<InlineKeyboard> {
    const activeBackend = this.orchestrator.getBackendDescriptorForScope(scopeId);

    if (activeBackend.engineType === 'codex') {
      const codexHome = this.config.codexAuthDir ?? this.config.codexHome ?? path.join(os.homedir(), '.codex');
      let currentCodexAccount = 'default';
      try {
        const authPath = path.join(codexHome, 'auth.json');
        const stat = await fsPromises.lstat(authPath).catch(() => null);
        if (stat?.isSymbolicLink()) {
          const target = await fsPromises.readlink(authPath);
          currentCodexAccount = path.basename(target).replace(/^auth\.json_/, '');
        }
      } catch {}

      return [
        [
          { text: `👤 Codex 账号 (${currentCodexAccount})`, callback_data: 'codex:setup:auth' },
          { text: '📁 Codex 会话历史', callback_data: 'codex:setup:threads' },
        ],
      ];
    }

    if (activeBackend.engineType === 'opencode') {
      return [
        [
          { text: '📁 OpenCode 会话历史', callback_data: 'opencode:setup:threads' },
        ],
      ];
    }

    const candidates = await this.auth.listCandidates();
    const active = candidates.find((c) => c.isActive) || candidates[0];

    let quotaBadge = '';
    if (active?.quota) {
      const p5h = typeof active.quota.fiveHourPercent === 'number' ? `${active.quota.fiveHourPercent}%` : '—';
      const pw = typeof active.quota.weeklyPercent === 'number' ? `${active.quota.weeklyPercent}%` : '—';
      quotaBadge = ` · ${p5h}|${pw}`;
    }

    return [
      [
        { text: `👤 AGY 账号 (${candidates.length}${quotaBadge})`, callback_data: `${AGY_SETUP_CALLBACK_PREFIX}auth` },
        { text: '📁 AGY 会话历史', callback_data: `${AGY_SETUP_CALLBACK_PREFIX}threads` },
      ],
    ];
  }

  private async handleCustomInbound(event: TelegramTextEvent, locale: AppLocale): Promise<boolean> {
    const scopeId = event.scopeId;

    // Check for JSON token upload / document attachment
    const doc = event.attachments?.find((a) => a.kind === 'document');
    if (doc && (doc.fileName?.endsWith('.json') || doc.mimeType?.includes('json'))) {
      try {
        const remoteFile = await this.bot.getFile(doc.fileId);
        if (remoteFile.file_path) {
          const tempDest = path.join(os.tmpdir(), `agy_upload_${Date.now()}_${doc.fileName || 'token.json'}`);
          await this.bot.downloadResolvedFile(remoteFile.file_path, tempDest);
          const content = await fsPromises.readFile(tempDest, 'utf8');
          await fsPromises.unlink(tempDest).catch(() => {});
          if (content.includes('refresh_token')) {
            const importRes = await this.auth.importAccountFromJson(content);
            if (importRes.success && importRes.account) {
              const candidates = await this.auth.listCandidates();
              await this.sendMessage(
                scopeId,
                locale === 'zh'
                  ? `🎉 **Antigravity 账号导入成功！**\n\n` +
                    `• **账号名称**: \`${importRes.account.name}\`\n` +
                    `• **绑定邮箱**: \`${importRes.account.email || '未知'}\`\n` +
                    `• **鉴权状态**: ✅ Google OAuth 鉴权校验通过并已刷新 Token\n` +
                    `• **账号池现存**: 共 ${candidates.length} 个账号\n\n` +
                    `已自动加入候选池与自动保活轮转！`
                  : `🎉 **Antigravity Account Imported!**\n\n` +
                    `• **Name**: \`${importRes.account.name}\`\n` +
                    `• **Email**: \`${importRes.account.email || 'unknown'}\`\n` +
                    `• **Status**: ✅ Google OAuth validated & refreshed\n` +
                    `• **Pool Size**: ${candidates.length} accounts\n\n` +
                    `Joined keep-alive and rotation pool!`,
              );
              return true;
            } else if (importRes.error) {
              await this.sendMessage(scopeId, `❌ 凭据导入失败: ${importRes.error}`);
              return true;
            }
          }
        }
      } catch (err) {
        this.logger.warn('antigravity.doc_import_error', { error: String(err) });
      }
    }

    // Check for inline JSON paste containing refresh_token
    const trimmed = event.text.trim();
    if (trimmed.startsWith('{') && trimmed.includes('refresh_token')) {
      try {
        const importRes = await this.auth.importAccountFromJson(trimmed);
        if (importRes.success && importRes.account) {
          const candidates = await this.auth.listCandidates();
          await this.sendMessage(
            scopeId,
            locale === 'zh'
              ? `🎉 **Antigravity 账号导入成功！**\n\n` +
                `• **账号名称**: \`${importRes.account.name}\`\n` +
                `• **绑定邮箱**: \`${importRes.account.email || '未知'}\`\n` +
                `• **鉴权状态**: ✅ Google OAuth 鉴权校验通过并已刷新 Token\n` +
                `• **账号池现存**: 共 ${candidates.length} 个账号\n\n` +
                `已自动加入候选池与自动保活轮转！`
              : `🎉 **Antigravity Account Imported!**\n\n` +
                `• **Name**: \`${importRes.account.name}\`\n` +
                `• **Email**: \`${importRes.account.email || 'unknown'}\`\n` +
                `• **Status**: ✅ Google OAuth validated & refreshed\n` +
                `• **Pool Size**: ${candidates.length} accounts\n\n` +
                `Joined keep-alive and rotation pool!`,
          );
          return true;
        } else if (importRes.error) {
          await this.sendMessage(scopeId, `❌ 凭据导入失败: ${importRes.error}`);
          return true;
        }
      } catch (err) {
        this.logger.warn('antigravity.text_import_error', { error: String(err) });
      }
    }

    // Check if there is an active pending browser login session awaiting authorization code
    if (this.auth.hasPendingLogin(scopeId)) {
      const loginRes = await this.auth.completeBrowserLogin(scopeId, event.text);
      if (loginRes.success && loginRes.account) {
        const candidates = await this.auth.listCandidates();
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `🎉 **Google 账号登录成功！**\n\n` +
              `• **账号名称**: \`${loginRes.account.name}\`\n` +
              `• **绑定邮箱**: \`${loginRes.account.email || '未知'}\`\n` +
              `• **鉴权状态**: ✅ 授权码兑换成功，Token 已保存\n` +
              `• **账号池现存**: 共 ${candidates.length} 个账号\n\n` +
              `已成功加入候选池，并已纳入后台自动静默保活！`
            : `🎉 **Google Account Logged In!**\n\n` +
              `• **Account**: \`${loginRes.account.name}\`\n` +
              `• **Email**: \`${loginRes.account.email || 'unknown'}\`\n` +
              `• **Status**: ✅ Code exchanged successfully\n` +
              `• **Pool Size**: ${candidates.length} accounts\n\n` +
              `Joined candidate pool with automatic keep-alive!`,
        );
        return true;
      } else {
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `❌ **登录授权失败**: ${loginRes.error || '未能识别或兑换授权码'}\n\n请检查是否复制了完整授权码，或发送 \`/login\` 重新发起登录，发送 \`/auth cancel\` 可取消。`
            : `❌ **Login Failed**: ${loginRes.error || 'Failed to exchange code'}\nPlease check the code or send /login again. Send /auth cancel to abort.`,
        );
        return true;
      }
    }

    if (this.codexCore?.hasPendingInteraction(scopeId)) {
      this.codexCore.dispatchInboundLikeTelegramText(event);
      return true;
    }

    const rename = this.pendingAgyRenames.get(scopeId);
    if (rename && event.text.trim()) {
      this.pendingAgyRenames.delete(scopeId);
      const newTitle = event.text.trim();
      this.conversations.renameConversation(rename.conversationId, newTitle);
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `✅ 会话名称已修改为: **${newTitle}**`
          : `✅ Conversation renamed to: **${newTitle}**`,
      );
      await this.sendThreadsPanel(scopeId, '', locale);
      return true;
    }

    return false;
  }

  private async handleCustomCommand(
    scopeId: string,
    cmd: string,
    args: string,
    locale: AppLocale,
    _event?: TelegramTextEvent,
  ): Promise<boolean> {
    const activeBackend = this.orchestrator.getBackendDescriptorForScope(scopeId);
    const isCodex = activeBackend.engineType === 'codex';

    if (isCodex) {
      if (this.codexCore) {
        switch (cmd.toLowerCase()) {
          case 'threads':
            if (_event) {
              this.codexCore.dispatchInboundLikeTelegramText(_event);
            } else {
              await this.codexCore.showThreadsPanel(scopeId, undefined, args.trim() || null, locale);
            }
            return true;

          case 'open':
            if (_event) {
              this.codexCore.dispatchInboundLikeTelegramText(_event);
            } else if (!args.trim()) {
              await this.codexCore.showThreadsPanel(scopeId, undefined, null, locale);
            }
            return true;

          case 'auth':
            if (_event) {
              this.codexCore.dispatchInboundLikeTelegramText(_event);
            } else {
              await this.codexCore.handleAuthCommand(scopeId, locale, args ? args.split(/\s+/) : []);
            }
            return true;

          case 'login_device':
            if (_event) {
              this.codexCore.dispatchInboundLikeTelegramText(_event);
              return true;
            }
            break;

          case 'login':
            await this.sendMessage(
              scopeId,
              locale === 'zh'
                ? `ℹ️ **Codex 账号登录**\n\n发送 \`/auth\` 可在账号池中一键切换，或点击【🔑 设备登录】使用浏览器授权。`
                : `ℹ️ Use /auth to manage accounts or use Device Login.`,
            );
            return true;

          case 'watch':
          case 'unwatch':
            await this.sendMessage(
              scopeId,
              locale === 'zh'
                ? `ℹ️ 会话实时观察模式当前仅在 Google Antigravity (AGY) 引擎下可用。可使用 \`/backend antigravity\` 切换。`
                : `ℹ️ Observer mode is only available on Google Antigravity (AGY) engine.`,
            );
            return true;

          default:
            return false;
        }
      }

      switch (cmd.toLowerCase()) {
        case 'threads':
          await this.sendCodexThreadsMenu(scopeId, locale);
          return true;

        case 'open':
          if (!args.trim()) {
            await this.sendCodexThreadsMenu(scopeId, locale);
          } else {
            await this.openCodexThread(scopeId, args.trim(), locale);
          }
          return true;

        case 'auth':
          await this.sendCodexAuthMenu(scopeId, locale);
          return true;

        case 'login':
          await this.sendMessage(
            scopeId,
            locale === 'zh'
              ? `ℹ️ **Codex 账号管理说明**\n\nCodex 使用 \`~/.codex/auth.json\` 凭据。\n发送 \`/auth\` 可在多个已有账号候选之间一键热切换。\n若需添加新账号，可在终端运行 \`codex auth login\` 或将 \`auth.json_<name>\` 放入 \`~/.codex/\` 目录。`
              : `ℹ️ **Codex Auth Note**\n\nUse /auth to switch between accounts in ~/.codex/. To log in, run \`codex auth login\` in terminal.`,
          );
          return true;

        case 'watch':
        case 'unwatch':
          await this.sendMessage(
            scopeId,
            locale === 'zh'
              ? `ℹ️ 会话实时观察模式当前仅在 Google Antigravity (AGY) 引擎下可用。可使用 \`/backend antigravity\` 切换。`
              : `ℹ️ Observer mode is only available on Google Antigravity (AGY) engine.`,
          );
          return true;

        default:
          return false;
      }
    }

    switch (cmd.toLowerCase()) {
      case 'threads':
        await this.sendThreadsPanel(scopeId, args.trim(), locale);
        return true;

      case 'open':
        await this.openThread(scopeId, args.trim(), locale);
        return true;

      case 'watch':
        await this.watchConversation(scopeId, args.trim(), locale);
        return true;

      case 'unwatch':
        await this.unwatchConversation(scopeId, locale);
        return true;

      case 'login':
        await this.startLoginFlow(scopeId, locale);
        return true;

      case 'auth':
        if (args.trim() === 'login') {
          await this.startLoginFlow(scopeId, locale);
        } else if (args.trim() === 'cancel' || args.trim() === 'cancel_login') {
          this.auth.cancelBrowserLogin(scopeId);
          await this.sendMessage(scopeId, locale === 'zh' ? '已取消登录会话。' : 'Login session canceled.');
        } else {
          await this.sendAuthMenu(scopeId, args.trim(), locale);
        }
        return true;

      default:
        return false;
    }
  }

  private async handleCustomCallback(
    scopeId: string,
    data: string,
    locale: AppLocale,
    messageId?: number,
    event?: TelegramCallbackEvent,
  ): Promise<boolean> {
    if (this.codexCore && (
      data.startsWith('thread:') ||
      data.startsWith('auth:') ||
      data.startsWith('settings:access:') ||
      data.startsWith('settings:permissions')
    )) {
      if (event) {
        await this.codexCore.handleCallback(event);
      }
      return true;
    }

    if (data.startsWith('codex:setup:auth')) {
      await this.messaging.answerCallback(data, '');
      if (this.codexCore) {
        await this.codexCore.handleAuthCommand(scopeId, locale, []);
      } else {
        await this.sendCodexAuthMenu(scopeId, locale, messageId);
      }
      return true;
    }

    if (data.startsWith('codex:setup:threads')) {
      await this.messaging.answerCallback(data, '');
      if (this.codexCore) {
        await this.codexCore.showThreadsPanel(scopeId, messageId, undefined, locale);
      } else {
        await this.sendCodexThreadsMenu(scopeId, locale, messageId);
      }
      return true;
    }

    if (data.startsWith('agy:rename:')) {
      const convId = data.slice('agy:rename:'.length);
      this.pendingAgyRenames.set(scopeId, { conversationId: convId });
      await this.messaging.answerCallback(data, '请输入新名称');
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `✏️ 请直接回复发送该会话的新名称：`
          : `✏️ Please reply with the new conversation name:`,
      );
      return true;
    }

    if (data.startsWith('agy:archive:')) {
      const convId = data.slice('agy:archive:'.length);
      this.conversations.archiveConversation(convId);
      await this.messaging.answerCallback(data, locale === 'zh' ? '已归档' : 'Archived');
      await this.sendThreadsPanel(scopeId, '', locale, messageId);
      return true;
    }

    if (data.startsWith('agy:new:')) {
      const convId = data.slice('agy:new:'.length);
      const conv = this.conversations.getConversation(convId);
      const cwd = conv?.workspaceDir || this.config.defaultCwd;
      this.store.clearBinding(scopeId);
      await this.messaging.answerCallback(data, locale === 'zh' ? '已创建新会话' : 'New conversation ready');
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `✨ **已在目录创建新会话**\n• 工作目录: \`${cwd}\`\n\n发送任意消息开启新任务。`
          : `✨ **New conversation ready** in \`${cwd}\`.`,
      );
      return true;
    }

    if (data.startsWith('codex:auth:')) {
      const cand = data.slice('codex:auth:'.length);
      await this.switchCodexAccount(scopeId, cand, locale, messageId);
      return true;
    }

    if (data.startsWith('codex:open:')) {
      const threadId = data.slice('codex:open:'.length);
      await this.openCodexThread(scopeId, threadId, locale, messageId);
      return true;
    }

    if (data.startsWith(AGY_OPEN_CALLBACK_PREFIX)) {
      const targetId = data.slice(AGY_OPEN_CALLBACK_PREFIX.length);
      const conv = this.conversations.resolveConversation(targetId, scopeId, this.store);
      if (conv) {
        this.store.setBinding(scopeId, conv.conversationId, conv.workspaceDir || this.config.defaultCwd);
        await this.messaging.answerCallback(data, `已切换到: ${conv.title}`);
        await this.openThread(scopeId, conv.conversationId, locale, messageId);
      } else {
        await this.messaging.answerCallback(data, '未找到会话');
      }
      return true;
    }

    if (data.startsWith(AGY_WATCH_CALLBACK_PREFIX)) {
      const targetId = data.slice(AGY_WATCH_CALLBACK_PREFIX.length);
      if (targetId === 'stop') {
        await this.messaging.answerCallback(data, '已停止观察');
        await this.unwatchConversation(scopeId, locale, true);
        return true;
      }
      const existing = this.watchers.get(scopeId);
      if (existing && !existing.stopped && existing.conversationId === targetId) {
        await this.messaging.answerCallback(data, '已停止观察');
        await this.unwatchConversation(scopeId, locale, true);
        return true;
      }
      await this.messaging.answerCallback(data, '进入观察模式');
      await this.watchConversation(scopeId, targetId, locale, messageId);
      return true;
    }

    if (data.startsWith(AGY_SETUP_CALLBACK_PREFIX)) {
      const sub = data.slice(AGY_SETUP_CALLBACK_PREFIX.length);
      switch (sub) {
        case 'auth':
          await this.sendAuthMenu(scopeId, '', locale, messageId);
          return true;
        case 'threads':
          await this.sendThreadsPanel(scopeId, '', locale, messageId);
          return true;
        case 'effort':
          await this.sendEffortMenu(scopeId, '', locale, messageId);
          return true;
        default:
          return false;
      }
    }

    if (data.startsWith(AGY_MODEL_CALLBACK_PREFIX)) {
      const model = data.slice(AGY_MODEL_CALLBACK_PREFIX.length);
      this.store.setChatSettings(scopeId, model, null);
      this.orchestrator.syncCurrentBackendSettings(scopeId);
      await this.messaging.answerCallback(data, `Model: ${model}`);
      await this.orchestrator.sendModelsMenu(scopeId, locale, messageId);
      return true;
    }

    if (data.startsWith(AGY_EFFORT_CALLBACK_PREFIX)) {
      const effort = data.slice(AGY_EFFORT_CALLBACK_PREFIX.length) as 'low' | 'medium' | 'high';
      const settings = this.store.getChatSettings(scopeId);
      if (effort !== 'high' && settings?.serviceTier === 'boost') {
        this.store.setChatServiceTier(scopeId, null);
      }
      this.store.setChatSettings(scopeId, null, effort);
      this.orchestrator.syncCurrentBackendSettings(scopeId);
      await this.messaging.answerCallback(data, `Effort: ${effort}`);
      await this.sendEffortMenu(scopeId, '', locale, messageId);
      return true;
    }

    if (data.startsWith(AGY_AUTH_CALLBACK_PREFIX)) {
      const accountName = data.slice(AGY_AUTH_CALLBACK_PREFIX.length);
      if (accountName.startsWith('filter:')) {
        await this.sendAuthMenu(scopeId, accountName, locale, messageId);
        return true;
      }

      if (accountName === 'login') {
        await this.startLoginFlow(scopeId, locale, messageId);
        return true;
      }

      if (accountName === 'cancel_login') {
        this.auth.cancelBrowserLogin(scopeId);
        await this.messaging.answerCallback(data, '已取消登录');
        await this.sendAuthMenu(scopeId, '', locale, messageId);
        return true;
      }

      if (accountName === 'rotate') {
        try {
          const res = await this.auth.rotateNextCandidate();
          await this.messaging.answerCallback(data, `已轮转到: ${res.account.email || res.account.name}`);
          await this.sendAuthMenu(scopeId, '', locale, messageId);
        } catch (err) {
          await this.messaging.answerCallback(data, `轮转失败: ${String(err)}`);
        }
        return true;
      }

      if (accountName === 'refresh_current') {
        const active = await this.auth.getActiveAccount();
        if (!active) {
          await this.messaging.answerCallback(data, '无活跃账号');
          return true;
        }
        const res = await this.auth.refreshTokenForAccount(active.name);
        await this.messaging.answerCallback(
          data,
          res.success ? '⚡ 当前 Token 刷新成功！' : `刷新失败: ${res.error}`,
        );
        await this.sendAuthMenu(scopeId, '', locale, messageId);
        return true;
      }

      if (accountName === 'refresh_all') {
        const res = await this.auth.refreshAllTokens();
        await this.messaging.answerCallback(
          data,
          `⚡ 刷新完成: ${res.refreshed}/${res.total} 成功`,
        );
        await this.sendAuthMenu(scopeId, '', locale, messageId);
        return true;
      }

      if (accountName === 'import_help') {
        await this.messaging.answerCallback(data, '查看导入指南');
        const guideText =
          `📥 **Antigravity 账号导入指南**\n\n` +
          `你可以通过以下任意方式向机器人导入新的 Google / Antigravity 账号：\n\n` +
          `1️⃣ **直接发送 Token 文件**：\n` +
          `   将包含 OAuth 凭据的 \`.json\` 文件（例如从其他机器复制的 \`antigravity-oauth-token\`）作为文档直接发送给机器人。\n\n` +
          `2️⃣ **粘贴 Token JSON**：\n` +
          `   直接在会话中发送包含 \`refresh_token\` 的 JSON 文本。\n\n` +
          `3️⃣ **使用命令**：\n` +
          `   发送 \`/auth add <json_content>\` 即可导入。\n\n` +
          `机器人会自动校验并向 Google API 请求刷新测试，校验成功后立即加入候选池与自动保活轮转！`;
        await this.sendMessage(scopeId, guideText);
        return true;
      }

      if (accountName.startsWith('toggle_pause:')) {
        const target = accountName.slice('toggle_pause:'.length);
        const nowPaused = this.auth.togglePauseAccount(target);
        await this.messaging.answerCallback(
          data,
          nowPaused ? `⏸ 账号已暂停: ${target}` : `▶️ 账号已恢复启用: ${target}`,
        );
        await this.sendAuthMenu(scopeId, '', locale, messageId);
        return true;
      }

      if (accountName.startsWith('repair:')) {
        const target = accountName.slice('repair:'.length);
        const res = await this.auth.diagnoseAndRepairAccount(target);
        await this.messaging.answerCallback(
          data,
          res.ok ? `🩺 修复成功: ${res.message}` : `❌ 修复失败: ${res.message}`,
        );
        await this.sendAuthMenu(scopeId, '', locale, messageId);
        return true;
      }

      if (accountName === 'repair_all') {
        const res = await this.auth.diagnoseAndRepairAll();
        await this.messaging.answerCallback(
          data,
          `🩺 体检完成: 正常/已修复 ${res.healthy + res.repaired} / 需关注 ${res.failed}`,
        );
        await this.sendAuthMenu(scopeId, '', locale, messageId);
        return true;
      }

      if (accountName.startsWith('switch:')) {
        const target = accountName.slice('switch:'.length);
        try {
          const res = await this.auth.switchAccount(target);
          await this.messaging.answerCallback(data, `已切换到: ${res.account.email || res.account.name}`);
        } catch (err) {
          await this.messaging.answerCallback(data, `切换失败: ${String(err)}`);
        }
        await this.sendAuthMenu(scopeId, '', locale, messageId);
        return true;
      }

      try {
        const res = await this.auth.switchAccount(accountName);
        await this.messaging.answerCallback(data, `已切换到: ${res.account.email || res.account.name}`);
        await this.sendAuthMenu(scopeId, '', locale, messageId);
      } catch (err) {
        await this.messaging.answerCallback(
          data,
          `Failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return true;
    }

    return false;
  }

  private async sendThreadsPanel(
    scopeId: string,
    search: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    const boundThreadId = this.store.getBinding(scopeId)?.threadId;
    const list = this.conversations.listConversations(10, search);

    if (list.length === 0) {
      const emptyText =
        locale === 'zh'
          ? `📁 **Antigravity 会话列表**\n\n暂无历史会话。发送任意消息或执行 \`/new\` 即可创建。`
          : `📁 **Antigravity Conversations**\n\nNo history found. Send a message or run \`/new\` to create one.`;
      const emptyKb: InlineKeyboard = [
        [{ text: '✨ 新建会话', callback_data: 'engine:setup:new' }],
        [{ text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' }],
      ];
      if (editMessageId) {
        await this.editMessage(scopeId, editMessageId, emptyText, emptyKb);
      } else {
        await this.sendMessage(scopeId, emptyText, emptyKb);
      }
      return;
    }

    // Cache threads in database so `/open <idx>` works
    this.store.cacheThreadList(
      scopeId,
      list.map((c, i) => ({
        listIndex: i + 1,
        threadId: c.conversationId,
        name: c.title,
        preview: c.preview,
        cwd: c.workspaceDir ?? this.config.defaultCwd,
        modelProvider: 'antigravity',
        status: 'idle',
        updatedAt: c.updatedAt,
      })),
    );

    const currentWatcher = this.watchers.get(scopeId);
    const watchingThreadId = currentWatcher && !currentWatcher.stopped ? currentWatcher.conversationId : null;

    const lines: string[] = [
      locale === 'zh' ? `📁 **Antigravity 会话列表**：` : `📁 **Antigravity Conversations**:`,
      '',
    ];

    const keyboard: InlineKeyboard = [];

    list.forEach((session, idx) => {
      const isCurrent = session.conversationId === boundThreadId;
      const isWatching = session.conversationId === watchingThreadId;
      const marker = isCurrent ? '●' : '○';
      const short = session.conversationId.slice(0, 8);
      const dir = session.workspaceDir ?? this.config.defaultCwd;
      const age = formatAge(session.updatedAt, locale);
      const watchBadge = isWatching ? ' [👁 观察中]' : '';

      lines.push(`${marker} **${idx + 1}.** ${session.title}${watchBadge}`);
      lines.push(`   \`${short}\` · \`${dir}\` · ${age}`);

      if (idx < 8) {
        const dirName = path.basename(dir || this.config.defaultCwd);
        const titleSnippet = session.title ? session.title.replace(/\s+/g, ' ') : 'Untitled';
        const openText = `${isCurrent ? '✅ ' : ''}${idx + 1}. ${dirName}|${titleSnippet.length > 32 ? titleSnippet.slice(0, 31) + '…' : titleSnippet}`;
        keyboard.push([
          {
            text: openText,
            callback_data: `${AGY_OPEN_CALLBACK_PREFIX}${session.conversationId}`,
          },
        ]);
        keyboard.push([
          { text: '✏️', callback_data: `agy:rename:${session.conversationId}` },
          { text: isWatching ? '👁 监视' : '👀', callback_data: `${AGY_WATCH_CALLBACK_PREFIX}${session.conversationId}` },
          { text: '🗑️', callback_data: `agy:archive:${session.conversationId}` },
          { text: '➕', callback_data: `agy:new:${session.conversationId}` },
        ]);
      }
    });

    if (watchingThreadId) {
      keyboard.push([
        {
          text: locale === 'zh' ? '🛑 停止观察当前会话 (/unwatch)' : '🛑 Stop watching (/unwatch)',
          callback_data: `${AGY_WATCH_CALLBACK_PREFIX}stop`,
        },
      ]);
    }

    lines.push(
      '',
      locale === 'zh'
        ? `• 点击名称切换会话；\n• 点击快捷按钮：\`[✏️ 重命名]\` \`[👀 观察]\` \`[🗑️ 归档]\` \`[➕ 新建分支]\`；\n• 命令行：\`/open <编号>\`，\`/watch <编号>\`，\`/unwatch\`，\`/new\`。`
        : `• Tap name to bind conversation;\n• Tap actions: \`[✏️ Rename]\` \`[👀 Watch]\` \`[🗑️ Archive]\` \`[➕ Fork]\`;\n• Commands: \`/open <num>\`, \`/watch <num>\`, \`/unwatch\`, \`/new\`.`,
    );

    keyboard.push([
      { text: '➕ 新建', callback_data: 'engine:setup:new' },
      { text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' },
    ]);

    const content = lines.join('\n');
    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, content, keyboard);
      this.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.sendMessage(scopeId, content, keyboard);
      this.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }

  private async openThread(
    scopeId: string,
    rawTarget: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    if (!rawTarget) {
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? '用法：`/open <编号|会话ID>`。例如 `/open 1`。可使用 `/threads` 查看有效编号。'
          : 'Usage: `/open <number|conversation-id>`. Use `/threads` to list.',
      );
      return;
    }

    const conv = this.conversations.resolveConversation(rawTarget, scopeId, this.store);
    if (!conv) {
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `❌ 未找到会话 \`${rawTarget}\`。请使用 \`/threads\` 查看会话列表。`
          : `❌ Conversation \`${rawTarget}\` not found. Use \`/threads\` to list.`,
      );
      return;
    }

    const targetCwd = conv.workspaceDir || this.config.defaultCwd;
    this.store.setBinding(scopeId, conv.conversationId, targetCwd);

    const currentWatcher = this.watchers.get(scopeId);
    let watchNoteZh = '';
    let watchNoteEn = '';
    if (currentWatcher && !currentWatcher.stopped) {
      watchNoteZh = `\n• **当前观察**: \`${currentWatcher.conversationId.slice(0, 8)}\``;
      watchNoteEn = `\n• **Watching**: \`${currentWatcher.conversationId.slice(0, 8)}\``;
    }

    const text =
      locale === 'zh'
        ? `✅ **已切换绑定到既有 Antigravity 会话**\n\n` +
          `• **标题**: ${conv.title}\n` +
          `• **会话 ID**: \`${conv.conversationId}\`\n` +
          `• **工作目录**: \`${targetCwd}\`\n` +
          `• **更新时间**: ${formatAge(conv.updatedAt, 'zh')}` +
          watchNoteZh +
          `\n\n后续消息将在此会话继续执行。`
        : `✅ **Switched to Antigravity Conversation**\n\n` +
          `• **Title**: ${conv.title}\n` +
          `• **ID**: \`${conv.conversationId}\`\n` +
          `• **Directory**: \`${targetCwd}\`\n` +
          `• **Updated**: ${formatAge(conv.updatedAt, 'en')}` +
          watchNoteEn +
          `\n\nNext messages will continue in this conversation.`;

    const keyboard: InlineKeyboard = [
      [{ text: '👁 开启实时观察 (/watch)', callback_data: `${AGY_WATCH_CALLBACK_PREFIX}${conv.conversationId}` }],
      [
        { text: '📁 查看其他会话', callback_data: `${AGY_SETUP_CALLBACK_PREFIX}threads` },
        { text: '⚙️ 控制面板', callback_data: 'engine:setup:main' },
      ],
    ];

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, text, keyboard);
    } else {
      await this.sendMessage(scopeId, text, keyboard);
    }
  }

  private async sendCodexAuthMenu(
    scopeId: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    const codexHome = this.config.codexAuthDir ?? this.config.codexHome ?? path.join(os.homedir(), '.codex');
    let currentAccount = 'default';
    let candidates: string[] = [];
    try {
      const files = await fsPromises.readdir(codexHome);
      candidates = files
        .filter((f) => f.startsWith('auth.json_') && !f.endsWith('.bak') && !f.endsWith('.tmp'))
        .map((f) => f.replace(/^auth\.json_/, ''))
        .sort();

      const authPath = path.join(codexHome, 'auth.json');
      const stat = await fsPromises.lstat(authPath).catch(() => null);
      if (stat?.isSymbolicLink()) {
        const target = await fsPromises.readlink(authPath);
        currentAccount = path.basename(target).replace(/^auth\.json_/, '');
      }
    } catch (err) {
      this.logger.warn('codex.list_auth_failed', { error: String(err) });
    }

    const text =
      locale === 'zh'
        ? `👤 **OpenAI Codex 账号管理 (Account Pool)**\n\n` +
          `• **当前活跃账号**: ● **${currentAccount}**\n` +
          `• **账号候选池**: 共 ${candidates.length} 个账号\n` +
          `• **凭据路径**: \`${path.join(codexHome, 'auth.json')}\`\n\n` +
          `点击下方账号名称可直接热切换 Codex 登录凭据：`
        : `👤 **OpenAI Codex Account Management**\n\n` +
          `• **Active Account**: ● **${currentAccount}**\n` +
          `• **Candidates**: ${candidates.length} accounts\n` +
          `• **Path**: \`${path.join(codexHome, 'auth.json')}\`\n\n` +
          `Tap an account below to switch:`;

    const keyboard: InlineKeyboard = [];
    for (let i = 0; i < candidates.length; i += 2) {
      const row: InlineKeyboard[0] = [];
      const c1 = candidates[i]!;
      const isC1 = c1 === currentAccount;
      row.push({
        text: `${isC1 ? '● ' : '○ '}${c1}`,
        callback_data: `codex:auth:${c1}`,
      });
      if (i + 1 < candidates.length) {
        const c2 = candidates[i + 1]!;
        const isC2 = c2 === currentAccount;
        row.push({
          text: `${isC2 ? '● ' : '○ '}${c2}`,
          callback_data: `codex:auth:${c2}`,
        });
      }
      keyboard.push(row);
    }

    keyboard.push([
      { text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' },
      { text: '🔄 刷新列表', callback_data: 'codex:setup:auth' },
    ]);

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.sendMessage(scopeId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }

  private async switchCodexAccount(
    scopeId: string,
    candName: string,
    locale: AppLocale,
    messageId?: number,
  ): Promise<void> {
    const codexHome = this.config.codexAuthDir ?? this.config.codexHome ?? path.join(os.homedir(), '.codex');
    const authPath = path.join(codexHome, 'auth.json');
    const targetPath = path.join(codexHome, `auth.json_${candName}`);
    try {
      await fsPromises.unlink(authPath).catch(() => {});
      await fsPromises.symlink(targetPath, authPath);
      this.logger.info('codex.auth_switched', { candidate: candName });
      await this.messaging.answerCallback(`codex:auth:${candName}`, locale === 'zh' ? `已切换至 Codex 账号: ${candName}` : `Switched to: ${candName}`);
      if (messageId) {
        await this.sendCodexAuthMenu(scopeId, locale, messageId);
      }
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `🔄 **Codex 账号已热切换至: \`${candName}\`**`
          : `🔄 **Codex account switched to: \`${candName}\`**`,
      );
    } catch (err) {
      this.logger.error('codex.auth_switch_error', { candidate: candName, error: String(err) });
      await this.messaging.answerCallback(`codex:auth:${candName}`, `切换失败: ${String(err)}`);
    }
  }

  private async sendCodexThreadsMenu(
    scopeId: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    const codexHome = this.config.codexAuthDir ?? this.config.codexHome ?? path.join(os.homedir(), '.codex');
    const currentBinding = this.store.getBinding(scopeId);
    const activeThreadId = currentBinding?.threadId;

    interface CodexSessionItem {
      id: string;
      title: string;
      updatedAt?: string;
    }

    const items: CodexSessionItem[] = [];
    try {
      const indexPath = path.join(codexHome, 'session_index.jsonl');
      const content = await fsPromises.readFile(indexPath, 'utf8').catch(() => '');
      const lines = content.trim().split('\n').filter(Boolean);
      const seenIds = new Set<string>();
      for (let i = lines.length - 1; i >= 0 && items.length < 8; i--) {
        try {
          const parsed = JSON.parse(lines[i]!);
          if (parsed.id && !seenIds.has(parsed.id)) {
            seenIds.add(parsed.id);
            items.push({
              id: parsed.id,
              title: parsed.thread_name || parsed.id.slice(0, 16),
              updatedAt: parsed.updated_at,
            });
          }
        } catch {}
      }
    } catch (err) {
      this.logger.warn('codex.list_threads_failed', { error: String(err) });
    }

    const listLines = items.map((item, idx) => {
      const num = idx + 1;
      const isActive = item.id === activeThreadId;
      return `${isActive ? '●' : '○'} **${num}.** ${item.title}${isActive ? ' `[当前会话]`' : ''}\n   \`${item.id.slice(0, 16)}…\``;
    });

    const text =
      locale === 'zh'
        ? `📁 **OpenAI Codex 会话历史**\n\n` +
          `• **当前会话**: ${activeThreadId ? `\`${activeThreadId.slice(0, 16)}…\`` : '`新会话就绪 (发送消息开启)`'}\n` +
          `• **工作目录**: \`${currentBinding?.cwd || this.config.defaultCwd}\`\n\n` +
          (items.length > 0
            ? `**最近会话列表**：\n${listLines.join('\n')}\n\n点击下方按钮恢复会话，或使用 \`/open <编号>\`：`
            : `暂无历史会话记录。发送消息将开启新会话。`)
        : `📁 **OpenAI Codex Session History**\n\n` +
          `• **Current Thread**: ${activeThreadId ? `\`${activeThreadId.slice(0, 16)}…\`` : '`Ready (new)`'}\n` +
          `• **Directory**: \`${currentBinding?.cwd || this.config.defaultCwd}\`\n\n` +
          (items.length > 0 ? `${listLines.join('\n')}\n\nTap below to resume or use \`/open <num>\`:` : 'No sessions found.');

    const keyboard: InlineKeyboard = [];
    for (let i = 0; i < items.length; i += 2) {
      const row: InlineKeyboard[0] = [];
      const item1 = items[i]!;
      const isA1 = item1.id === activeThreadId;
      const shortTitle1 = item1.title.length > 14 ? item1.title.slice(0, 13) + '…' : item1.title;
      row.push({
        text: `${isA1 ? '● ' : ''}${i + 1}. ${shortTitle1}`,
        callback_data: `codex:open:${item1.id}`,
      });
      if (i + 1 < items.length) {
        const item2 = items[i + 1]!;
        const isA2 = item2.id === activeThreadId;
        const shortTitle2 = item2.title.length > 14 ? item2.title.slice(0, 13) + '…' : item2.title;
        row.push({
          text: `${isA2 ? '● ' : ''}${i + 2}. ${shortTitle2}`,
          callback_data: `codex:open:${item2.id}`,
        });
      }
      keyboard.push(row);
    }

    keyboard.push([
      { text: '✨ 新建会话', callback_data: 'engine:setup:new' },
      { text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' },
    ]);

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.sendMessage(scopeId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }

  private async openCodexThread(
    scopeId: string,
    rawTarget: string,
    locale: AppLocale,
    messageId?: number,
  ): Promise<void> {
    const codexHome = this.config.codexAuthDir ?? this.config.codexHome ?? path.join(os.homedir(), '.codex');
    let targetThreadId = rawTarget.trim();

    if (/^\d+$/.test(targetThreadId)) {
      const idx = parseInt(targetThreadId, 10) - 1;
      try {
        const indexPath = path.join(codexHome, 'session_index.jsonl');
        const content = await fsPromises.readFile(indexPath, 'utf8').catch(() => '');
        const lines = content.trim().split('\n').filter(Boolean);
        const seenIds = new Set<string>();
        const items: string[] = [];
        for (let i = lines.length - 1; i >= 0 && items.length < 20; i--) {
          try {
            const parsed = JSON.parse(lines[i]!);
            if (parsed.id && !seenIds.has(parsed.id)) {
              seenIds.add(parsed.id);
              items.push(parsed.id);
            }
          } catch {}
        }
        if (idx >= 0 && idx < items.length) {
          targetThreadId = items[idx]!;
        }
      } catch {}
    }

    const currentBinding = this.store.getBinding(scopeId);
    const targetCwd = currentBinding?.cwd || this.config.defaultCwd;

    this.store.setBinding(scopeId, targetThreadId, targetCwd);
    const activeBackend = this.orchestrator.getBackendDescriptorForScope(scopeId);
    this.store.setScopeBackendBinding(scopeId, activeBackend.id, targetThreadId, targetCwd);

    if (messageId) {
      await this.messaging.answerCallback(`codex:open:${targetThreadId}`, locale === 'zh' ? '已恢复会话' : 'Thread resumed');
    }

    const text =
      locale === 'zh'
        ? `📂 **已切换绑定到既有 OpenAI Codex 会话**\n\n` +
          `• **会话 ID**: \`${targetThreadId}\`\n` +
          `• **工作目录**: \`${targetCwd}\`\n\n` +
          `后续消息将在此 Codex 会话继续执行。`
        : `📂 **Switched to Codex Session**\n\n` +
          `• **ID**: \`${targetThreadId}\`\n` +
          `• **Directory**: \`${targetCwd}\`\n\n` +
          `Next messages will continue in this thread.`;

    const keyboard: InlineKeyboard = [
      [
        { text: '📁 查看其他会话', callback_data: 'codex:setup:threads' },
        { text: '⚙️ 控制面板', callback_data: 'engine:setup:main' },
      ],
    ];

    if (messageId) {
      await this.editMessage(scopeId, messageId, text, keyboard);
    } else {
      await this.sendMessage(scopeId, text, keyboard);
    }
  }

  private async watchConversation(
    scopeId: string,
    rawTarget: string,
    locale: AppLocale,
    editMessageId?: number,
    notify = true,
  ): Promise<void> {
    let conv: AntigravityConversation | null = null;
    if (rawTarget) {
      conv = this.conversations.resolveConversation(rawTarget, scopeId, this.store);
    } else {
      const boundThreadId = this.store.getBinding(scopeId)?.threadId;
      if (boundThreadId) {
        conv = this.conversations.getConversation(boundThreadId);
      }
    }

    if (!conv) {
      if (notify) {
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `❌ 未找到指定会话进行观察。用法：\`/watch <编号|会话ID>\`，或使用 \`/threads\` 选择。`
            : `❌ Conversation not found. Usage: \`/watch <num|id>\` or check \`/threads\`.`,
        );
      }
      return;
    }

    const transcriptPath = this.conversations.getTranscriptPath(conv.conversationId);
    if (!transcriptPath) {
      if (notify) {
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `⚠️ 会话 \`${conv.conversationId.slice(0, 8)}\` 暂无本地日志文件，无法进入实时观察模式。`
            : `⚠️ No transcript log found for \`${conv.conversationId.slice(0, 8)}\`.`,
        );
      }
      return;
    }

    // Stop existing watcher for this scope if any
    const existing = this.watchers.get(scopeId);
    if (existing) {
      existing.stopped = true;
      if (existing.timer) clearTimeout(existing.timer);
    }

    // Seek to end of file initially to only tail new entries
    let initialOffset = 0;
    try {
      if (fs.existsSync(transcriptPath)) {
        initialOffset = fs.statSync(transcriptPath).size;
      }
    } catch {}

    const watcher: AntigravityWatcher = {
      scopeId,
      conversationId: conv.conversationId,
      transcriptPath,
      fileOffset: initialOffset,
      remainder: '',
      timer: null,
      stopped: false,
      messageId: null,
      currentToolLines: [],
      lastContentPreview: '',
    };

    this.watchers.set(scopeId, watcher);
    this.store.setWatchedThread(scopeId, conv.conversationId);

    if (notify) {
      const keyboard: InlineKeyboard = [
        [{ text: '🛑 停止观察 (/unwatch)', callback_data: `${AGY_WATCH_CALLBACK_PREFIX}stop` }],
        [
          { text: '📁 会话列表', callback_data: `${AGY_SETUP_CALLBACK_PREFIX}threads` },
          { text: '⚙️ 控制面板', callback_data: 'engine:setup:main' },
        ],
      ];

      const text =
        locale === 'zh'
          ? `👁 **已开启实时观察会话**\n\n` +
            `• **会话标题**: ${conv.title}\n` +
            `• **会话 ID**: \`${conv.conversationId}\`\n` +
            `• **工作目录**: \`${conv.workspaceDir || this.config.defaultCwd}\`\n` +
            `• **日志路径**: \`${transcriptPath}\`\n\n` +
            `现在开始，外部终端或其他客户端在此会话产生的步骤、工具调用和回复将实时同步至 Telegram。\n\n` +
            `发送 \`/unwatch\` 或点击下方按钮可随时退出观察。`
          : `👁 **Started Watching Conversation**\n\n` +
            `• **Title**: ${conv.title}\n` +
            `• **ID**: \`${conv.conversationId}\`\n` +
            `• **Directory**: \`${conv.workspaceDir || this.config.defaultCwd}\`\n` +
            `• **Log**: \`${transcriptPath}\`\n\n` +
            `Now monitoring new turns, tools, and responses in real-time.\n\n` +
            `Send \`/unwatch\` or tap below to stop.`;

      if (editMessageId) {
        await this.editMessage(scopeId, editMessageId, text, keyboard);
      } else {
        await this.sendMessage(scopeId, text, keyboard);
      }
    }

    this.scheduleWatcherPoll(watcher);
  }

  private async unwatchConversation(
    scopeId: string,
    locale: AppLocale,
    notify = true,
  ): Promise<void> {
    this.store.setWatchedThread(scopeId, null);
    const watcher = this.watchers.get(scopeId);
    if (!watcher) {
      if (notify) {
        await this.sendMessage(
          scopeId,
          locale === 'zh' ? 'ℹ️ 当前没有正在观察的会话。' : 'ℹ️ No conversation is currently being watched.',
        );
      }
      return;
    }

    watcher.stopped = true;
    if (watcher.timer) clearTimeout(watcher.timer);
    this.watchers.delete(scopeId);

    if (notify) {
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `🛑 **已停止观察会话**\n\n已退出只读监控模式。`
          : `🛑 **Stopped Watching Conversation**\n\nExited read-only watch mode.`,
      );
    }
  }

  private scheduleWatcherPoll(watcher: AntigravityWatcher): void {
    if (watcher.stopped) return;
    watcher.timer = setTimeout(() => {
      watcher.timer = null;
      void this.pollWatcher(watcher)
        .catch((err) => {
          this.logger.debug('antigravity.watch_poll_error', { error: String(err) });
        })
        .finally(() => {
          if (!watcher.stopped && this.watchers.get(watcher.scopeId) === watcher) {
            this.scheduleWatcherPoll(watcher);
          }
        });
    }, 1500);
    watcher.timer?.unref?.();
  }

  private async pollWatcher(watcher: AntigravityWatcher): Promise<void> {
    if (watcher.stopped) return;

    if (this.orchestrator.hasActiveTurn(watcher.scopeId)) {
      try {
        if (fs.existsSync(watcher.transcriptPath)) {
          watcher.fileOffset = fs.statSync(watcher.transcriptPath).size;
        }
      } catch {}
      return;
    }

    try {
      if (!fs.existsSync(watcher.transcriptPath)) {
        return;
      }

      const stats = fs.statSync(watcher.transcriptPath);
      if (stats.size < watcher.fileOffset) {
        watcher.fileOffset = 0;
        watcher.remainder = '';
        return;
      }

      if (stats.size === watcher.fileOffset) {
        return;
      }

      const bytesToRead = stats.size - watcher.fileOffset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(watcher.transcriptPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, bytesToRead, watcher.fileOffset);
      } finally {
        fs.closeSync(fd);
      }

      watcher.fileOffset = stats.size;
      const chunk = watcher.remainder + buffer.toString('utf8');
      const lines = chunk.split('\n');
      watcher.remainder = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: any;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue;
        }

        await this.handleWatcherTranscriptEntry(watcher, entry);
      }
    } catch (err) {
      this.logger.debug('antigravity.poll_watcher_error', { error: String(err) });
    }
  }

  private async handleWatcherTranscriptEntry(watcher: AntigravityWatcher, entry: any): Promise<void> {
    if (entry.type === 'USER_INPUT') {
      const text = typeof entry.content === 'string' ? entry.content : '';
      const preview = text.length > 300 ? text.slice(0, 300) + '…' : text;
      await this.sendMessage(
        watcher.scopeId,
        `👤 <b>外部用户输入</b>：\n${escapeTelegramHtml(preview)}`,
      );
      watcher.messageId = null;
      watcher.currentToolLines = [];
      watcher.lastContentPreview = '';
      return;
    }

    if (entry.type === 'PLANNER_RESPONSE') {
      let hasUpdate = false;
      if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
        for (const tc of entry.tool_calls) {
          const name = tc.name || 'tool';
          let desc = '';
          if (tc.args) {
            const raw = tc.args.toolSummary || tc.args.toolAction || tc.args.CommandLine || tc.args.TargetFile || '';
            desc = typeof raw === 'string' ? raw.replace(/^"|"$/g, '').trim() : '';
          }
          const toolLine = `⚙️ <code>${escapeTelegramHtml(name)}</code>${desc ? ` · <i>${escapeTelegramHtml(desc.slice(0, 60))}</i>` : ''}`;
          if (!watcher.currentToolLines.includes(toolLine)) {
            watcher.currentToolLines.push(toolLine);
            hasUpdate = true;
          }
        }
      }

      const isFinalAnswer =
        entry.status === 'DONE' &&
        typeof entry.content === 'string' &&
        entry.content.trim().length > 0 &&
        (!entry.tool_calls || entry.tool_calls.length === 0);

      if (isFinalAnswer) {
        if (watcher.messageId) {
          let progressFinal = `✅ <b>[Antigravity 步骤已完成]</b>`;
          if (watcher.currentToolLines.length > 0) {
            progressFinal += `\n\n<blockquote expandable>🛠️ <b>已调用工具 (${watcher.currentToolLines.length} 项)</b>\n${watcher.currentToolLines.join('\n')}</blockquote>`;
          }
          await this.editMessage(watcher.scopeId, watcher.messageId, progressFinal).catch(() => {});
        }

        const chunks = chunkTelegramMessage(entry.content.trim(), 4000);
        for (const chunk of chunks) {
          await this.sendMessage(watcher.scopeId, chunk);
        }

        watcher.messageId = null;
        watcher.currentToolLines = [];
        watcher.lastContentPreview = '';
        return;
      }

      if (entry.content) {
        watcher.lastContentPreview = entry.content;
        hasUpdate = true;
      }

      if (hasUpdate) {
        let messageText = `👁 <b>[Antigravity 观察中]</b>\n\n`;
        if (watcher.currentToolLines.length > 0) {
          const recent = watcher.currentToolLines.slice(-8);
          messageText += `<blockquote expandable>🛠️ <b>已调用工具 (${watcher.currentToolLines.length} 项)</b>\n${recent.join('\n')}</blockquote>\n\n`;
        }
        if (watcher.lastContentPreview) {
          messageText += watcher.lastContentPreview.slice(-3000);
        } else {
          messageText += `⏳ 正在执行步骤 #${entry.step_index ?? '…'}…`;
        }

        if (watcher.messageId) {
          await this.editMessage(watcher.scopeId, watcher.messageId, messageText).catch(() => {});
        } else {
          watcher.messageId = await this.sendMessage(watcher.scopeId, messageText).catch(() => null);
        }
      }
    }
  }

  private async sendAuthMenu(
    scopeId: string,
    args: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    const trimmedArgs = (args || '').trim();
    let currentFilter: 'all' | 'enabled' | 'attention' = 'all';

    if (trimmedArgs.startsWith('filter:')) {
      const f = trimmedArgs.slice('filter:'.length).toLowerCase();
      if (f === 'enabled' || f === 'attention' || f === 'all') {
        currentFilter = f;
      }
    } else if (trimmedArgs) {
      if (trimmedArgs.startsWith('pause ')) {
        const target = trimmedArgs.slice('pause '.length).trim();
        this.auth.pauseAccount(target);
        await this.sendMessage(
          scopeId,
          locale === 'zh' ? `⏸ 账号 \`${target}\` 已暂停使用。` : `⏸ Account \`${target}\` paused.`,
        );
        return;
      }

      if (trimmedArgs.startsWith('resume ')) {
        const target = trimmedArgs.slice('resume '.length).trim();
        this.auth.resumeAccount(target);
        await this.sendMessage(
          scopeId,
          locale === 'zh' ? `▶️ 账号 \`${target}\` 已恢复启用。` : `▶️ Account \`${target}\` resumed.`,
        );
        return;
      }

      if (trimmedArgs === 'repair_all' || trimmedArgs === 'repair all') {
        const res = await this.auth.diagnoseAndRepairAll();
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `🩺 **账号池体检与修复结果**\n\n• 总账号数: ${res.total}\n• 正常/已修复: ${res.healthy + res.repaired}\n• 需关注/失败: ${res.failed}\n\n${res.summary.join('\n')}`
            : `🩺 **Account Diagnostics & Repair**\n\n• Total: ${res.total}\n• Healthy/Repaired: ${res.healthy + res.repaired}\n• Failed: ${res.failed}\n\n${res.summary.join('\n')}`,
        );
        return;
      }

      if (trimmedArgs.startsWith('repair ') || trimmedArgs === 'repair') {
        const target = trimmedArgs === 'repair' ? 'active' : trimmedArgs.slice('repair '.length).trim();
        const res = await this.auth.diagnoseAndRepairAccount(target);
        await this.sendMessage(
          scopeId,
          res.ok
            ? (locale === 'zh' ? `🩺 账号 \`${res.email || res.accountName}\` 检查修复成功：${res.message}` : `🩺 Account \`${res.email || res.accountName}\` repaired: ${res.message}`)
            : (locale === 'zh' ? `❌ 检查修复失败：${res.message}` : `❌ Repair failed: ${res.message}`),
        );
        return;
      }

      if (trimmedArgs === 'rotate') {
        try {
          const res = await this.auth.rotateNextCandidate();
          await this.sendMessage(
            scopeId,
            locale === 'zh'
              ? `🔄 已成功轮转到下一个账号: \`${res.account.email ?? res.account.name}\``
              : `🔄 Successfully rotated to next account: \`${res.account.email ?? res.account.name}\``,
          );
        } catch (err) {
          await this.sendMessage(scopeId, `❌ ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (trimmedArgs === 'refresh') {
        const active = await this.auth.getActiveAccount();
        if (!active) {
          await this.sendMessage(scopeId, locale === 'zh' ? '❌ 当前无活跃账号。' : '❌ No active account.');
          return;
        }
        const res = await this.auth.refreshTokenForAccount(active.name);
        if (res.success) {
          await this.sendMessage(
            scopeId,
            locale === 'zh'
              ? `⚡ 账号 \`${active.email || active.name}\` Token 刷新成功！`
              : `⚡ Account \`${active.email || active.name}\` refreshed successfully!`,
          );
        } else {
          await this.sendMessage(scopeId, `❌ 刷新失败: ${res.error}`);
        }
        return;
      }

      if (trimmedArgs === 'refresh all' || trimmedArgs === 'refresh_all') {
        const res = await this.auth.refreshAllTokens();
        await this.auth.populateQuotas(await this.auth.listCandidates(false), true);
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `⚡ 全部 Token 与额度已刷新完成: 成功 ${res.refreshed} / 共 ${res.total} 个${res.failed > 0 ? ` (失败 ${res.failed})` : ''}`
            : `⚡ All tokens and quotas refreshed: ${res.refreshed} / ${res.total} succeeded`,
        );
        return;
      }

      if (trimmedArgs.startsWith('add ') || trimmedArgs.startsWith('{')) {
        const jsonContent = trimmedArgs.startsWith('add ') ? trimmedArgs.slice('add '.length).trim() : trimmedArgs;
        const res = await this.auth.importAccountFromJson(jsonContent);
        if (res.success && res.account) {
          const candidates = await this.auth.listCandidates();
          await this.sendMessage(
            scopeId,
            locale === 'zh'
              ? `🎉 **Antigravity 账号导入成功！**\n• 账号名称: \`${res.account.name}\`\n• 绑定邮箱: \`${res.account.email || '未知'}\`\n• 候选池总数: 共 ${candidates.length} 个账号`
              : `🎉 **Account Imported!**\n• Name: \`${res.account.name}\`\n• Email: \`${res.account.email || 'unknown'}\`\n• Pool: ${candidates.length} accounts`,
          );
        } else {
          await this.sendMessage(scopeId, `❌ 导入失败: ${res.error || '未知错误'}`);
        }
        return;
      }

      // Direct switch
      try {
        const res = await this.auth.switchAccount(trimmedArgs);
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `✅ 已成功切换到账号: \`${res.account.email ?? res.account.name}\``
            : `✅ Successfully switched to account: \`${res.account.email ?? res.account.name}\``,
        );
        return;
      } catch (err) {
        await this.sendMessage(scopeId, `❌ ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    const candidates = await this.auth.listCandidates(true);
    const active = candidates.find((c) => c.isActive) || candidates[0];

    const filtered = candidates.filter((c) => {
      if (currentFilter === 'enabled') {
        return !c.isPaused && !c.isCooldown && c.hasRefreshToken;
      }
      if (currentFilter === 'attention') {
        return c.isPaused || c.isCooldown || !c.hasRefreshToken;
      }
      return true;
    });

    const keyboard: InlineKeyboard = [];
    for (const c of filtered) {
      const prefix = formatCandidateButtonPrefix(c);
      let icon = '🔐 ';
      if (c.isPaused) {
        icon = '⏸ ';
      } else if (c.isActive) {
        icon = '🟢 ';
      } else if (c.isCooldown) {
        icon = '⏳ ';
      }
      const label = `${icon}${prefix}|${formatCandidateDisplayName(c)}${c.isPaused ? ' · off' : ''}`;

      let rightBtnText = '⏸';
      let rightBtnAction = `${AGY_AUTH_CALLBACK_PREFIX}toggle_pause:${c.name}`;
      if (!c.hasRefreshToken || c.isCooldown) {
        rightBtnText = '🩺';
        rightBtnAction = `${AGY_AUTH_CALLBACK_PREFIX}repair:${c.name}`;
      } else if (c.isPaused) {
        rightBtnText = '▶️';
        rightBtnAction = `${AGY_AUTH_CALLBACK_PREFIX}toggle_pause:${c.name}`;
      } else if (c.isActive) {
        rightBtnText = '✅';
        rightBtnAction = `${AGY_AUTH_CALLBACK_PREFIX}toggle_pause:${c.name}`;
      }

      keyboard.push([
        {
          text: label.length > 28 ? `${label.slice(0, 27)}…` : label,
          callback_data: `${AGY_AUTH_CALLBACK_PREFIX}switch:${c.name}`,
        },
        {
          text: rightBtnText,
          callback_data: rightBtnAction,
        },
      ]);
    }

    // Filter tab row matching Codex
    keyboard.push([
      {
        text: currentFilter === 'all' ? '☑️ 全部' : '全部',
        callback_data: `${AGY_AUTH_CALLBACK_PREFIX}filter:all`,
      },
      {
        text: currentFilter === 'enabled' ? '☑️ 已启用' : '已启用',
        callback_data: `${AGY_AUTH_CALLBACK_PREFIX}filter:enabled`,
      },
      {
        text: currentFilter === 'attention' ? '☑️ 需关注' : '需关注',
        callback_data: `${AGY_AUTH_CALLBACK_PREFIX}filter:attention`,
      },
    ]);

    keyboard.push([
      { text: '🔑 设备登录', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}login` },
      { text: '🩺 账号体检与修复', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}repair_all` },
    ]);

    keyboard.push([
      { text: '🔄 轮转切号', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}rotate` },
      { text: '⚡ 刷新额度与Token', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}refresh_all` },
    ]);

    keyboard.push([
      { text: '📥 账号导入指南', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}import_help` },
      { text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' },
    ]);

    const activeExpiry = formatAccountExpiry(active?.expiry ?? null, locale, true);
    const activeLabel = active ? `${active.email || active.name}` : locale === 'zh' ? '无' : 'None';

    let quotaDetails = '';
    if (active?.quota) {
      const q = active.quota;
      const p5h = typeof q.fiveHourPercent === 'number' ? `${q.fiveHourPercent}%` : '未知';
      const pw = typeof q.weeklyPercent === 'number' ? `${q.weeklyPercent}%` : '未知';
      const r5h = q.resetTime5h ? formatQuotaResetTime(q.resetTime5h) : '—';
      const rw = q.resetTimeWeekly ? formatQuotaResetTime(q.resetTimeWeekly) : '—';

      quotaDetails =
        locale === 'zh'
          ? `\n• **Gemini 5h 额度**: \`${p5h}\` (重置于 ${r5h})` +
            `\n• **Gemini 7d 额度**: \`${pw}\` (重置于 ${rw})`
          : `\n• **Gemini 5h Quota**: \`${p5h}\` (resets ${r5h})` +
            `\n• **Gemini 7d Quota**: \`${pw}\` (resets ${rw})`;

      if (typeof q.thirdPartyWeeklyPercent === 'number') {
        const p3pw = `${q.thirdPartyWeeklyPercent}%`;
        const r3pw = q.resetTimeWeekly ? formatQuotaResetTime(q.resetTimeWeekly) : '—';
        quotaDetails +=
          locale === 'zh'
            ? `\n• **3P (Claude/GPT)**: \`${p3pw}\` (重置于 ${r3pw})`
            : `\n• **3P (Claude/GPT)**: \`${p3pw}\` (resets ${r3pw})`;
      }
    } else {
      quotaDetails =
        locale === 'zh'
          ? `\n• **5h/7d 额度**: \`未获取到\` (点击【⚡ 刷新额度与Token】实时获取)`
          : `\n• **5h/7d Quota**: \`Not available\` (tap [⚡ Refresh Quota & Token])`;
    }

    const text =
      locale === 'zh'
        ? `👤 **Antigravity 账号管理池**\n\n` +
          `• **当前活跃账号**: \`${activeLabel}\`\n` +
          `• **活跃 Token 状态**: ${activeExpiry}` +
          quotaDetails +
          `\n• **账号池总数**: 共 ${candidates.length} 个账号\n` +
          `• **按键前缀说明**: \`5h剩余% | 7d剩余% | 账号别名\` (数值为剩余额度百分比，非时间)\n\n` +
          `点击下方账号名称可即时无缝热切换；点击【🔑 设备登录】可在 Telegram 内直接授权绑定新账号。`
        : `👤 **Antigravity Account Pool**\n\n` +
          `• **Active**: \`${activeLabel}\`\n` +
          `• **Status**: ${activeExpiry}` +
          quotaDetails +
          `\n• **Pool Size**: ${candidates.length} accounts\n` +
          `• **Prefix Meaning**: \`5h% | 7d% | account\` (values represent remaining quota %, not time)\n\n` +
          `Tap candidate below to switch seamlessly. Tap [🔑 Device Login] to sign in.`;

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.sendMessage(scopeId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }

  private async startLoginFlow(scopeId: string, locale: AppLocale, editMessageId?: number): Promise<void> {
    const session = this.auth.startBrowserLogin(scopeId);

    const keyboard: InlineKeyboard = [
      [{ text: '❌ 取消登录会话', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}cancel_login` }],
      [{ text: '◀️ 返回账号列表', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}filter:all` }],
    ];

    const text =
      locale === 'zh'
        ? `🔑 **Google / Antigravity 设备授权登录**\n\n` +
          `1️⃣ **点击授权链接**（在浏览器中打开）：\n` +
          `[👉 点击打开 Google 授权登录页面](${session.authUrl})\n\n` +
          `2️⃣ 在浏览器中完成账号选择与权限授予；\n` +
          `3️⃣ 授权完成后，浏览器页面可能提示复制授权码（Authorization Code），或重定向至空白页；\n` +
          `4️⃣ 直接将**授权码**或**重定向完整 URL**复制并作为消息发送给本机器人即可！\n\n` +
          `*临时会话有效期 10 分钟。随时发送 \`/auth cancel\` 可取消。*`
        : `🔑 **Google / Antigravity OAuth Login**\n\n` +
          `1️⃣ **Click authorization link**:\n` +
          `[👉 Open Google Authorization](${session.authUrl})\n\n` +
          `2️⃣ Approve requested permissions;\n` +
          `3️⃣ Paste the authorization code or redirect URL back into this chat!\n\n` +
          `*Valid for 10 minutes. Send /auth cancel to abort.*`;

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, text, keyboard);
    } else {
      await this.sendMessage(scopeId, text, keyboard);
    }
  }

  private async sendEffortMenu(
    scopeId: string,
    arg: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const isBoost = settings?.serviceTier === 'boost';

    if (arg) {
      const target = arg.toLowerCase();
      if (target === 'low' || target === 'medium' || target === 'high') {
        if (target !== 'high' && isBoost) {
          this.store.setChatServiceTier(scopeId, null);
        }
        this.store.setChatSettings(scopeId, null, target);
        this.orchestrator.syncCurrentBackendSettings(scopeId);
        await this.sendMessage(
          scopeId,
          locale === 'zh' ? `✅ 思考深度已切换为: \`${target}\`` : `✅ Effort switched to: \`${target}\``,
        );
        return;
      }
    }

    const current = isBoost ? 'high' : (settings?.reasoningEffort ?? 'high');

    const keyboard: InlineKeyboard = [
      [
        {
          text: `${current === 'low' ? '✅ ' : ''}Low (快速)`,
          callback_data: `${AGY_EFFORT_CALLBACK_PREFIX}low`,
        },
        {
          text: `${current === 'medium' ? '✅ ' : ''}Medium (平衡)`,
          callback_data: `${AGY_EFFORT_CALLBACK_PREFIX}medium`,
        },
        {
          text: `${current === 'high' ? '✅ ' : ''}High (深度思考)`,
          callback_data: `${AGY_EFFORT_CALLBACK_PREFIX}high`,
        },
      ],
      [{ text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' }],
    ];

    const boostHint = isBoost
      ? locale === 'zh'
        ? '\n\n*(当前处于 Boost 模式，深度锁定为 High)*'
        : '\n\n*(Locked to High in Boost Mode)*'
      : '';

    const text =
      locale === 'zh'
        ? `⚡ **选择思考深度 (Reasoning Effort)**\n当前深度: \`${current}\`${boostHint}`
        : `⚡ **Select Reasoning Effort**\nCurrent: \`${current}\`${boostHint}`;

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.sendMessage(scopeId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }
}

export { UnifiedBridgeCore as AntigravityBridgeCore };

