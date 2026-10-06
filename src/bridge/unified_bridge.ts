import { AntigravityConversationUi } from '../antigravity/conversation_ui.js';
import { AntigravityAccountUi } from '../antigravity/account_ui.js';
import type { AntigravityWatcher } from '../antigravity/conversation_ui.js';
import { createCodexBackendUi } from '../codex_app/backend_ui.js';
import type { ChannelPort } from '../core/channel_port.js';

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AppConfig } from '../config.js';
import { TelegramMessagingPort, type InlineKeyboard } from '../channels/telegram/telegram_messaging_port.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { AppLocale, RuntimeStatus } from '../types.js';

import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';

import { AntigravityAppClient } from '../antigravity/client.js';
import { AntigravityAuthManager, type AntigravityAccount } from '../antigravity/auth.js';
import { AntigravityConversationManager } from '../antigravity/conversations.js';
import { UnifiedChannelOrchestrator } from '../core/orchestrator.js';
import { AntigravityEngineAdapter } from '../antigravity/adapter.js';

import { CodexEngineAdapter } from '../codex_app/adapter.js';
import type { CodexAppClient, CodexAppServerRuntimeStatus } from '../codex_app/client.js';
import { OpencodeEngineAdapter } from '../opencode/adapter.js';
import type { OpencodeAppClient } from '../opencode/client.js';
import type { BackendDescriptor, IEngineAdapter } from '../core/engine_spi.js';
import { BridgeSessionCore } from '../controller/controller.js';
import { BridgeMessagingRouter } from '../channels/bridge_messaging_router.js';
import { BRIDGE_SCOPE_WEIXIN_PREFIX, BRIDGE_SCOPE_TELEGRAM_PREFIX, parseTelegramTargetFromBridgeScope } from '../core/bridge_scope.js';
import { syncCodexLocalUsageToStore } from '../store/token_usage.js';
import type { SelfUpdateRuntime } from '../update.js';
import { getTelegramCommands, getAntigravityTelegramCommands } from '../i18n.js';

export interface UnifiedBridgeRuntimeStatus {
  running: boolean;
  connected: boolean;
  activeTurns: number;
  pendingApprovals: number;
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

import {
  AGY_MODEL_CALLBACK_PREFIX,
  AGY_AUTH_CALLBACK_PREFIX,
  AGY_EFFORT_CALLBACK_PREFIX,
  AGY_OPEN_CALLBACK_PREFIX,
  AGY_SETUP_CALLBACK_PREFIX,
  AGY_WATCH_CALLBACK_PREFIX,
} from '../antigravity/ui_callbacks.js';



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
  selfUpdater?: SelfUpdateRuntime | undefined;
  backends?: BackendDescriptor[] | undefined;
  ownsScope?: (scopeId: string) => boolean;
}

export class UnifiedBridgeCore {
  private readonly conversationUi: AntigravityConversationUi;
  private readonly accountUi: AntigravityAccountUi;

  private readonly config: AppConfig;
  private readonly store: BridgeStore;
  private readonly logger: Logger;
  private readonly bot: TelegramGateway;
  private readonly app: AntigravityAppClient;
  private readonly auth: AntigravityAuthManager;
  private readonly conversations: AntigravityConversationManager;
  private readonly messaging: ChannelPort;
  private readonly adapter: AntigravityEngineAdapter;
  private readonly codexAdapter?: CodexEngineAdapter | undefined;
  private readonly codexApp?: CodexAppClient | undefined;
  readonly codexCore?: BridgeSessionCore | undefined;
  private readonly opencodeAdapter?: OpencodeEngineAdapter | undefined;
  private readonly defaultBackendId: string;
  private readonly selfUpdater?: SelfUpdateRuntime | undefined;
  private readonly orchestrator: UnifiedChannelOrchestrator;
  
  private readonly background = new Set<Promise<unknown>>();
  private trackBackground(pending: Promise<unknown>): void { this.background.add(pending); void pending.finally(() => this.background.delete(pending)).catch(() => {}); }

  private readonly pendingAgyRenames = new Map<string, { conversationId: string }>();

  constructor(
    config: AppConfig,
    store: BridgeStore,
    logger: Logger,
    bot: TelegramGateway,
    app?: AntigravityAppClient | undefined,
    auth?: AntigravityAuthManager | undefined,
    messaging?: ChannelPort | undefined,
    options?: UnifiedBridgeCoreOptions,
  ) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.bot = bot;
    this.auth = options?.antigravityAuth ?? auth ?? new AntigravityAuthManager(config.antigravityAuthDir, logger);
    this.app = options?.antigravityApp ?? app ?? new AntigravityAppClient(config.antigravityCliBin, logger);
    const effectiveAuthDir = this.auth.authDir || config.antigravityAuthDir;
    this.conversations = new AntigravityConversationManager(effectiveAuthDir, logger);
    this.messaging = messaging ?? new TelegramMessagingPort(bot);
    this.codexApp = options?.codexApp;
    this.defaultBackendId = options?.defaultBackendId ?? 'antigravity';
    this.selfUpdater = options?.selfUpdater;

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
        defaultApprovalPolicy: config.defaultApprovalPolicy,
        defaultSandboxMode: config.defaultSandboxMode,
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

    initialBackends.push(...(options?.backends ?? []));
    for (const backend of initialBackends) {
      backend.isDefault = backend.id === this.defaultBackendId;
      if (backend.engineType === 'codex') {
        backend.defaults = { reasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], boost: true, tokenUsage: true };
        backend.commands = getTelegramCommands;
      } else if (backend.engineType === 'antigravity') {
        backend.defaults = { reasoningEffort: 'high', supportedReasoningEfforts: ['low', 'medium', 'high'], boost: true, tokenUsage: true };
        backend.commands = getAntigravityTelegramCommands;
      }
    }
    this.backendDefinitions = initialBackends;
    const allAdapters: IEngineAdapter[] = [this.adapter];
    if (this.codexAdapter) allAdapters.push(this.codexAdapter);
    if (this.opencodeAdapter) allAdapters.push(this.opencodeAdapter);

    const legacyUi = {
        renderCustomStatus: (scopeId: string, locale: AppLocale) => this.renderCustomStatus(scopeId, locale),
        renderCustomSetupRows: (scopeId: string, locale: AppLocale) => this.renderCustomSetupRows(scopeId, locale),
        handleCustomCallback: (scopeId: string, data: string, locale: AppLocale, messageId?: number, event?: TelegramCallbackEvent) =>
          this.handleCustomCallback(scopeId, data, locale, messageId, event),
        handleCustomCommand: (scopeId: string, command: string, args: string, locale: AppLocale, event?: TelegramTextEvent) =>
          this.handleCustomCommand(scopeId, command, args, locale, event),
        handleCustomInbound: (event: TelegramTextEvent, locale: AppLocale) => this.handleCustomInbound(event, locale),
      };
    for (const backend of initialBackends) {
      if (backend.engineType === 'codex' && this.codexCore) backend.createUi = host => createCodexBackendUi(this.codexCore!, host, legacyUi);
      else if (backend.engineType === 'codex' || backend.engineType === 'antigravity') backend.createUi = () => legacyUi;
    }

    this.orchestrator = new UnifiedChannelOrchestrator({
      config,
      store,
      logger,
      bot,
      adapter: primaryAdapter,
      adapters: allAdapters,
      backends: initialBackends,
      defaultBackendId: this.defaultBackendId,
      ownsScope: options?.ownsScope ?? (scopeId => {
        if (!scopeId.startsWith(BRIDGE_SCOPE_TELEGRAM_PREFIX)) return !config.tgMultiBotMode && !scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX);
        const target = parseTelegramTargetFromBridgeScope(scopeId);
        return target.botId ? target.botId === this.bot.identity : !config.tgMultiBotMode;
      }),
      backendProvider: () => this.getBackendDescriptors(),
      messaging: this.messaging,
      serviceUi: { handleCustomCommand: (scopeId, cmd, args, locale, event) => this.handleServiceCommand(scopeId, cmd, args, locale, event) },

    });
    const panels = { sendMessage: this.sendMessage.bind(this), editMessage: this.editMessage.bind(this), scheduleStalePanelDeletion: this.scheduleStalePanelDeletion.bind(this) };
    this.conversationUi = new AntigravityConversationUi(config, store, logger, this.conversations, panels, this.orchestrator);
    this.accountUi = new AntigravityAccountUi(config, store, logger, this.auth, panels, this.orchestrator);

  }

  private readonly backendDefinitions: BackendDescriptor[];

  private async getBackendDescriptors(): Promise<BackendDescriptor[]> {
    const list: BackendDescriptor[] = [];
    list.push(...this.backendDefinitions.filter(backend => !['codex', 'antigravity', 'opencode'].includes(backend.id)));
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

    return list.map(backend => ({ ...this.backendDefinitions.find(definition => definition.id === backend.id), ...backend, isDefault: backend.id === this.defaultBackendId }));
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
    if (this.codexCore) {
      this.codexCore.attachExecutionHost({ ownsScope: scope => this.orchestrator.ownsScopeId(scope), hasExecutingTasks: () => this.orchestrator.hasExecutingTasks() });
      await this.codexCore.startControlPlane();
      return;
    }
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
    this.trackBackground(syncCodexLocalUsageToStore(this.store, this.config.codexHome ?? undefined));

    // Restore persisted watchers on startup
    try {
      const persisted = this.store.listWatchedThreads();
      for (const item of persisted) {
        this.trackBackground(this.watchConversation(item.scopeId, item.threadId, 'zh', undefined, false).catch((err) => {
          this.logger.warn('antigravity.restore_watcher_failed', { scopeId: item.scopeId, error: String(err) });
        }));
      }
    } catch (err) {
      this.logger.warn('antigravity.restore_watchers_error', { error: String(err) });
    }
    if (this.selfUpdater) {
      this.scheduleSelfUpdateStatusPoll(500);
    }
  }

  async stop(): Promise<void> {
    this.clearSelfUpdateStatusPoll();
    try { await this.orchestrator.stop(); }
    finally {
      await this.auth.stopKeepAlive();
      await this.conversationUi.stop();
      await Promise.allSettled([...this.background]);
    }
  }

  private selfUpdatePollTimer: NodeJS.Timeout | null = null;

  private scheduleSelfUpdateStatusPoll(delay = 1000): void {
    if (!this.selfUpdater || this.selfUpdatePollTimer) {
      return;
    }
    this.selfUpdatePollTimer = setTimeout(() => {
      this.selfUpdatePollTimer = null;
      void this.pollSelfUpdateStatus().catch((error) => {
        this.logger.error('antigravity.self_update_poll_failed', { error: String(error) });
        this.scheduleSelfUpdateStatusPoll();
      });
    }, delay);
    this.selfUpdatePollTimer.unref?.();
  }

  private clearSelfUpdateStatusPoll(): void {
    if (!this.selfUpdatePollTimer) return;
    clearTimeout(this.selfUpdatePollTimer);
    this.selfUpdatePollTimer = null;
  }

  private ownsScope(scopeId: string): boolean {
    if (this.bot.identity) {
      return scopeId.includes(`:${this.bot.identity}:`);
    }
    return !scopeId.includes(':bot');
  }

  private async pollSelfUpdateStatus(): Promise<void> {
    const status = await this.selfUpdater?.readStatus();
    if (!status) return;
    if (status.state === 'pending') {
      this.scheduleSelfUpdateStatusPoll();
      return;
    }
    if (status.scopeId.startsWith('cluster:')) {
      await this.selfUpdater?.clearStatus();
      return;
    }
    if (!this.ownsScope(status.scopeId)) {
      this.scheduleSelfUpdateStatusPoll();
      return;
    }
    const isZh = status.locale === 'zh';
    if (status.state === 'succeeded') {
      const notes = status.releaseNotes?.filter((n) => n.trim()) ?? [];
      const title = isZh ? '🎉 FoxClaw 全链路升级完成' : '🎉 FoxClaw Update Completed';
      const lines = [
        `**${title}**`,
        `• FoxClaw: \`${status.fromVersion}\` ➔ \`${status.toVersion ?? '0.11.0'}\``,
        `• Codex CLI: \`${status.codexFromVersion ?? '0.157.1'}\` ➔ \`${status.codexToVersion ?? '0.159.2'}\``,
        `• Antigravity CLI: \`${status.agyFromVersion ?? '1.2.14'}\` (最新)`,
      ];
      if (notes.length > 0) {
        lines.push('', isZh ? '**更新日志**:' : '**Release Notes**:');
        for (const note of notes) {
          lines.push(`• ${note}`);
        }
      }
      lines.push('', isZh ? '服务已自动重载并恢复就绪。' : 'Service reloaded and ready.');
      await this.sendMessage(status.scopeId, lines.join('\n')).catch(() => {});
    } else {
      const errorMsg = status.error ?? (isZh ? '未知错误' : 'Unknown error');
      await this.sendMessage(status.scopeId, `❌ **FoxClaw 升级失败**: ${errorMsg}`).catch(() => {});
    }
    await this.selfUpdater?.clearStatus();
  }

  getRuntimeStatus(): UnifiedBridgeRuntimeStatus {
    const isConnected = this.codexApp && typeof this.codexApp.isConnected === 'function'
      ? this.codexApp.isConnected()
      : true;
    return {
      running: true,
      connected: isConnected,
      activeTurns: this.orchestrator.getActiveTurnsCount(),
      pendingApprovals: this.orchestrator.getPendingApprovals(),
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
    return this.orchestrator.isIdleForServiceUpdate();
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
    } catch {
      /* ignore */
    }
    return 'default';
  }

  async handleExternalCodexAuthCandidateDeleted(candidateName: string, _reason: string | null = null): Promise<void> {
    void _reason;
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
    void _candidateName;
    void _rawAuth;
    void _expectedAccountId;
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
    this.orchestrator.scheduleStalePanelDeletion(scopeId, messageId);
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
      } catch {
        /* ignore */
      }

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

    const currentWatcher = this.conversationUi.watcherFor(scopeId);
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
    void _locale;
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
      } catch {
        /* ignore */
      }

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
    // OAuth uploads belong to Antigravity; other backends receive their files intact.
    if (this.orchestrator.getBackendDescriptorForScope(scopeId).engineType !== 'antigravity') {
      if (this.orchestrator.getBackendDescriptorForScope(scopeId).engineType === 'codex' && this.codexCore?.hasPendingInteraction(scopeId)) {
        this.codexCore.dispatchInboundLikeTelegramText(event);
        return true;
      }
      return false;
    }

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

  private async handleServiceCommand(
    scopeId: string, cmd: string, _args: string, locale: AppLocale, _event?: TelegramTextEvent,
  ): Promise<boolean> {
    if (cmd.toLowerCase() === 'update') {
      if (this.selfUpdater) {
        const status = await this.selfUpdater.readStatus();
        if (status?.state === 'pending') {
          await this.sendMessage(
            scopeId,
            locale === 'zh'
              ? '⏳ 升级任务已在后台执行中，请稍候…'
              : '⏳ Self-update is already running, please wait…',
          );
          return true;
        }
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? '🚀 正在启动全链路自升级（FoxClaw + Codex + Antigravity CLI），服务将自动更新并重载…'
            : '🚀 Starting full-stack self-update (FoxClaw + Codex + Antigravity CLI). Service will restart automatically…',
        );
        try {
          await this.selfUpdater.launch(scopeId, locale);
        } catch (err) {
          await this.sendMessage(scopeId, `❌ 自升级启动失败: ${String(err)}`);
        }
        return true;
      }
      if (this.codexCore) {
        if (_event) {
          this.codexCore.dispatchInboundLikeTelegramText(_event);
        } else {
          this.codexCore.dispatchInboundLikeTelegramText({
            scopeId,
            text: '/update',
            senderId: '0',
            senderName: 'User',
            timestamp: Date.now(),
          } as unknown as TelegramTextEvent);
        }
        return true;
      }
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? '⚠️ 当前运行环境下未配置自升级服务，请在终端执行 `foxclaw update`。'
          : '⚠️ Self-updater is not available in current runtime. Run `foxclaw update` in terminal.',
      );
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
    const engine = this.orchestrator.getBackendDescriptorForScope(scopeId).engineType;
    const isCodexCallback = /^(codex:|thread:|auth:|settings:)/.test(data);
    const isAntigravityCallback = data.startsWith('agy:');
    if ((isCodexCallback && engine !== 'codex') || (isAntigravityCallback && engine !== 'antigravity')) {
      if (event) await this.messaging.answerCallback(event.callbackQueryId, locale === 'zh' ? '后端已切换，请重新打开设置面板。' : 'Backend changed; reopen the setup panel.');
      return true;
    }
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
      this.store.setBinding(scopeId, '', cwd);
      this.orchestrator.syncCurrentBackendSettings(scopeId);
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
      const existing = this.conversationUi.watcherFor(scopeId);
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
      this.store.setChatModel(scopeId, model === 'default' ? null : model);
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
      this.store.setChatEffort(scopeId, effort);
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
  ): Promise<void> { return this.conversationUi.sendThreadsPanel(scopeId, search, locale, editMessageId); }

  private async openThread(
    scopeId: string,
    rawTarget: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> { return this.conversationUi.openThread(scopeId, rawTarget, locale, editMessageId); }

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
        } catch {
          /* ignore */
        }
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
          } catch {
            /* ignore */
          }
        }
        if (idx >= 0 && idx < items.length) {
          targetThreadId = items[idx]!;
        }
      } catch {
        /* ignore */
      }
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
  ): Promise<void> { return this.conversationUi.watchConversation(scopeId, rawTarget, locale, editMessageId, notify); }

  private async unwatchConversation(
    scopeId: string,
    locale: AppLocale,
    notify = true,
  ): Promise<void> { return this.conversationUi.unwatchConversation(scopeId, locale, notify); }

  private scheduleWatcherPoll(watcher: AntigravityWatcher): void { return this.conversationUi.scheduleWatcherPoll(watcher); }

  private getScopeLocale(scopeId: string): AppLocale { return this.conversationUi.getScopeLocale(scopeId); }

  private async renderWatcherProgressUpdate(watcher: AntigravityWatcher): Promise<void> { return this.conversationUi.renderWatcherProgressUpdate(watcher); }

  private async pollWatcher(watcher: AntigravityWatcher): Promise<void> { return this.conversationUi.pollWatcher(watcher); }

  private async handleWatcherTranscriptEntry(watcher: AntigravityWatcher, entry: any): Promise<void> { return this.conversationUi.handleWatcherTranscriptEntry(watcher, entry); }

  private async sendAuthMenu(
    scopeId: string,
    args: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> { return this.accountUi.sendAuthMenu(scopeId, args, locale, editMessageId); }

  private async startLoginFlow(scopeId: string, locale: AppLocale, editMessageId?: number): Promise<void> { return this.accountUi.startLoginFlow(scopeId, locale, editMessageId); }

  private async sendEffortMenu(
    scopeId: string,
    arg: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> { return this.accountUi.sendEffortMenu(scopeId, arg, locale, editMessageId); }
}

export { UnifiedBridgeCore as AntigravityBridgeCore };

