import { ListenerScope } from '../core/listener_scope.js';
import { CodexLocalUsageService } from './local_usage_service.js';
import { CodexAuthQuotaService } from './auth_quota_service.js';
import { CodexNativePanelService } from './native_panel_service.js';
import { externalWriterControl, type ExternalWriterIdentity } from '../codex_app/force_takeover.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import { type CodexLocalUsageSnapshot, type CodexLocalUsageStats } from '../codex_app/local_usage.js';
import {
  buildAccessSettingsKeyboard,
  buildModelSettingsKeyboard,
  buildSetupPanelKeyboard,
  buildThreadListKeyboard,
  buildThreadsKeyboard,
  clampEffortToModel,
  formatAccessPresetLabel,
  formatActiveTurnMessageModeLabel,
  formatAccessSettingsMessage,
  formatApprovalPolicyLabel,
  formatCollaborationModeLabel,
  formatModelSettingsMessage,
  formatSandboxModeLabel,
  formatServiceTierStatusLabel,
  formatSetupPanelMessage,
  formatThreadContextSummary,
  formatThreadsMessage,
  formatWeixinAccessCopyPaste,
  formatWeixinModelCopyPaste,
  formatWeixinThreadsCopyPaste,
  formatWeixinWhereNavCopyPaste,
  formatWhereMessage,
  normalizeRequestedEffort,
  resolveCurrentModel,
  resolveActiveTurnMessageMode,
  resolveRequestedModel,
  type SetupFocusSection,
  type ThreadListPresentationState,
} from './presentation.js';
import { BridgeMessagingRouter } from '../channels/bridge_messaging_router.js';
import type { AppConfig } from '../config.js';
import type { ActiveTurnPreviewRecord, BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { CodexAppClient, JsonRpcNotification, JsonRpcServerRequest, TurnInput } from '../codex_app/client.js';
import type { SelfUpdateRuntime, SelfUpdateStatus } from '../update.js';
import { parseCommand } from './commands.js';
import type {
  AppLocale,
  AccessPresetValue,
  ChatSessionSettings,
  CodexCollaborationMode,
  CodexRateLimitSnapshot,
  CodexSkillsListEntry,
  CollaborationModeValue,
  GuidedPlanSessionRecord,
  AppThreadSnapshot,
  AppTurnSnapshot,
  ModelInfo,
  PendingAttachmentBatchRecord,
  PendingApprovalRecord,
  QueuedTurnInputRecord,
  ReasoningEffortValue,
  RuntimeStatus,
  ThreadBinding,
  ThreadGoalStatusValue,
  ThreadSessionState,
} from '../types.js';
import path from 'node:path';
import os from 'node:os';
import { BRIDGE_SCOPE_WEIXIN_PREFIX, parseTelegramTargetFromBridgeScope, parseWeixinBridgeScope } from '../core/bridge_scope.js';
import {
  TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
  buildAttachmentPrompt,
  isNativeImageAttachment,
  planAttachmentStoragePath,
  summarizeTelegramInput,
  type StagedTelegramAttachment,
  type TelegramInboundAttachment,
} from '../telegram/media.js';
import { normalizeLocale, t } from '../i18n.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../telegram/addressing.js';
import { shouldShowRuntimeLastUpdate } from '../update_status.js';
import { normalizeAccessPreset, resolveAccessMode } from './access.js';
import { normalizeTurnActivityEvent, type RawExecCommandEvent, type TurnActivityEvent } from './activity.js';
import fs from 'node:fs/promises';
import {
  chatGptAuthMetadataMatchesCandidateName,
  parseChatGptAuthMetadata,
  readChatGptAuthRecord,
  readChatGptAuthMetadata,
  type ChatGptAuthMetadata,
} from '../auth/mirror.js';
import crypto from 'node:crypto';
import { clampServiceTierToModel, resolveFastTierForModel } from './service_tier.js';
import { resolveTelegramRenderRoute } from '../telegram/rendering.js';
import { TELEGRAM_MESSAGE_LIMIT, chunkTelegramMessage, chunkTelegramStreamMessage, clipTelegramDraftMessage } from '../telegram/text.js';
import { writeRuntimeStatus } from '../runtime.js';
import { renderTelegramMarkdownRichHtml } from '../telegram/rich_markdown.js';
import { escapeTelegramHtml, telegramBold, telegramDetails, telegramPre } from '../telegram/html.js';
import { diffObservedTurn, findLatestTurn, findLiveTurn } from './observer.js';
import { applySessionLog, bootstrapSessionLog, splitJsonlChunk } from './session_observer.js';
import { TELEGRAM_VOICE_MAX_BYTES, TELEGRAM_VOICE_SUPPORTED_EXTENSIONS, telegramVoiceContentType } from '../voice/files.js';
import { normalizeVoiceText, synthesizeTelegramVoice } from '../voice/tts.js';

import { renderActiveTurnStatus } from './status.js';
import {
  ActiveTurn,
  ObservedThreadWatcher,
  PendingUserInputRequest,
  PendingMcpElicitation,
  PendingAuthAdd,
  PendingAuthChoiceList,
  PendingAuthRotation,
  CodexAuthQuotaSnapshot,
  RemoteControlStatusState,
  PendingThreadRename,
  PendingThreadNewCwd,
  AuthProactiveRefreshStatus,
  CoreCoordinator,
  CODEX_AUTH_PROACTIVE_REFRESH_INITIAL_DELAY_MS,
  DEFAULT_COLLABORATION_MODE,
  DYNAMIC_HELP_COMMANDS,
  PINNED_HELP_COMMANDS,
  CodexAuthListFilter,
  McpElicitationAction,
  ApprovalAction,
  PendingPlanImplementation,
  PendingUserInputStatus,
  PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX,
  PLAN_IMPLEMENTATION_CODING_MESSAGE,
  UserFacingError,
  AuthRetryContext,
  OBSERVED_CLI_USER_LABEL,
  USER_INPUT_SUBMITTED_NOTICE_MS,
  OBSERVED_THREAD_POLL_MS,
  ServiceRuntimeStatus,
  SELF_UPDATE_STATUS_POLL_MS,
  SelfUpdateBroadcastSummary,
  CODEX_AUTH_PROACTIVE_REFRESH_INTERVAL_MS,
  CODEX_AUTH_PROACTIVE_REFRESH_DAYS,
  CodexAuthClusterAuditOutcome,
  CodexAuthRefreshAllResult,
  CodexAuthCandidate,
  CodexAuthSelection,
  CodexAuthState,
  CodexAuthSwitchResult,
  CodexAuthRotationReason,
  CodexAuthSwitchOutcome,
  CodexAuthRepairDisposition,
  AUTH_DELETE_REASON_NEEDS_REPAIR,
  CodexAuthQuotaIdentity,
  RESTART_PREVIEW_RECOVERY_RETRY_DELAYS_MS,
  ArchivedStatusContent,
  ToolBatchState,
  ActiveTurnSegment,
} from './state_types.js';
import {
  toErrorMeta,
  formatUserError,
  isThreadNotFoundError,
  isThreadActiveWriterError,
  normalizeHelpUsageKey,
  normalizeApprovalTextAction,
  isTelegramMessageGone,
  stringOrNull,
  cloneAuthRetryContext,
  normalizeThreadStatusLabel,
  formatThreadTokenUsage,
  mapGoalNotification,
  formatRawLabel,
  attachedThreadKey,
  isFileMissingError,
  isCodexTransportFallbackWarning,
  formatWarningNotification,
  normalizePlanImplementationTextAction,
  normalizeMcpElicitationTextAction,
  resolveCollaborationMode,
  activeTurnKey,
  parseActiveTurnKey,
  isReadableSessionPath,
  isNoActiveTurnToSteerError,
  isThreadQueueUnsupportedError,
  normalizeRequestedCollaborationMode,
  normalizeRequestedActiveTurnMessageMode,
  parsePositiveInt,
  parseReviewTarget,
  formatShortStatusError,
  formatLocalTimestamp,
  formatTokenCount,
  formatCodexTokenCountWithMetric,
  formatCompactNumber,
  formatWatchCallbackText,
  isThreadNewCwdCreateConfirmation,
  isThreadNewCwdCancelConfirmation,
  turnHasRelayableOutcome,
  isTelegramMessageTooLong,
  firstLine,
} from './shared_helpers.js';
import {
  formatCodexAuthPoolSummary,
  formatRemoteStatusMessage,
  isInvalidCodexAuthDeleteReason,
  formatRichInternalMessage,
  formatGoalMessage,
  formatHistoryMessage,
  formatFuzzyFilesMessage,
  formatSelfUpdateBroadcastLine,
  formatSelfUpdateVersionTransition,
  formatCodexUpdateState,
  renderTelegramTable,
  formatRichDemoMessage,
  formatRichDemoFallbackMessage,
  formatRichDiffMessage,
  formatDiffMessage,
} from './native_panels.js';
import {
  formatAuthProactiveRefreshStatus,
  selectCodexRateLimitSnapshot,
  parseCodexAuthListRequest,
  createPendingAuthChoiceList,
  renderAuthListMessage,
  authChoiceKeyboard,
  formatAuthSyncStatus,
  formatAuthSyncEvents,
  formatAuthSyncTrace,
  formatAuthClusterAuditResult,
  authRefreshAllConfirmKeyboard,
  formatAuthRefreshAllResult,
  formatCodexAccountLabel,
  formatPlanTypeLabel,
  clampCodexAuthListOffset,
  formatCodexAuthCandidateDisplayName,
  authRepairKeyboard,
  chatGptAuthMetadataCompatible,
  formatRateLimitWindowLabel,
  formatRemainingUsagePercent,
} from './auth_presentation.js';
import {
  mapApprovalDecision,
  parseStoredServerRequestId,
  renderApprovalMessage,
  approvalKeyboard,
  resolveScopeMessageTarget,
  parseServerRequestId,
  stringifyServerRequestId,
  sameServerRequestId,
  renderUserInputMessage,
  parseUserInputQuestions,
  serializePendingUserInput,
  userInputKeyboard,
  stringifyPendingUserInputAnswers,
  pendingUserInputCurrentQuestionIndex,
  parseStoredPendingUserInput,
  renderPlanImplementationPrompt,
  planImplementationKeyboard,
  renderMcpElicitationMessage,
  mcpElicitationKeyboard,
  findReusableStandaloneAttachmentBatch,
  parseStagedTelegramAttachments,
  mergeAttachmentBatchCaption,
  summarizeStagedAttachmentInput,
  shortId,
  renderAttachmentBatchMessage,
  attachmentBatchKeyboard,
  observerCursorFromActiveTurn,
  parseStoredTurnInput,
  threadNewCwdCreateKeyboard,
  whereKeyboard,
  restartPreviewRecoveryKey,
  seedObservedTurnCursor,
  activeTurnKeyboard,
} from './interactions.js';
import {
  isRetryableCodexTransportError,
  formatCodexNotificationError,
  classifyCodexAuthRotationError,
  isCodexAuthInvalidError,
  isCodexQuotaLimitError,
} from './auth_errors.js';
import {
  truncateInline,
  ensureTurnSegment,
  extractLatestPlanMarkdown,
  extractLatestProposedPlanMarkdown,
  renderCollapsedCommentary,
  formatToolBatchStatus,
  createToolBatchState,
  describeExecCommand,
  incrementToolBatchCount,
  renderArchivedToolBatchStatus,
} from './turn_rendering.js';
import {
  pointCodexAuthAtTarget,
  restoreCodexAuthTarget,
  codexAuthCandidateNameFromAddName,
  authPathDisplayLabel,
  listCodexAuthState,
  switchCodexAuth,
  isCodexApiKeyAuthCandidate,
} from './auth_files.js';
export type { CoreCoordinator } from './state_types.js';

export class BridgeSessionCore {
  private readonly listeners = new ListenerScope();
  private readonly controlOperations = new Set<Promise<void>>();
  private controlPlaneStarted = false;
  private recoverExecution = true;
  private executionHost: { ownsScope(scopeId: string): boolean; hasExecutingTasks(): boolean } | null = null;
  private readonly localUsage: CodexLocalUsageService;
  private readonly authQuota: CodexAuthQuotaService;
  private readonly nativePanels: CodexNativePanelService;

  private activeTurns = new Map<string, ActiveTurn>();
  private activeTurnsByTurnId = new Map<string, Set<string>>();
  private observedThreadWatchers = new Map<string, ObservedThreadWatcher>();
  private pendingTurnErrors = new Map<string, string>();
  private pendingUserInputs = new Map<string, PendingUserInputRequest>();
  private pendingMcpElicitations = new Map<string, PendingMcpElicitation>();
  private pendingLoginsByScope = new Map<string, string>();
  private externalWriterControl = externalWriterControl;
  private forceTakeoversInProgress = new Set<string>();
  private pendingForceTakeovers = new Map<string, {
    id: string; expiresAt: number; event: TelegramTextEvent;
    threadId: string; home: string; prompt: string; writer: ExternalWriterIdentity;
  }>();
  private pendingLoginScopesById = new Map<string, string>();
  private pendingAuthAddsByLoginId = new Map<string, PendingAuthAdd>();
  private authLoginRecoveryTimers = new Map<string, NodeJS.Timeout>();
  private latestTurnDiffs = new Map<string, { scopeId: string; threadId: string; turnId: string; diff: string; updatedAt: number }>();
  private threadTokenUsageAlerts = new Map<string, { turnId: string | null; bucket: number; limit: number }>();
  private pendingAuthChoiceLists = new Map<string, PendingAuthChoiceList>();
  private pendingApprovalMessages = new Map<string, Map<string, number>>();
  private pendingAuthRotation: PendingAuthRotation | null = null;
  private authRotationInProgress = false;
  private authRefreshAllInProgress = false;
  private externalAuthValidationInProgress = false;
  private turnStartInProgress = 0;
  private authRotationFailedTargets = new Set<string>();





  private lastRemoteControlStatus: RemoteControlStatusState | null = null;
  private pendingThreadRenames = new Map<string, PendingThreadRename>();
  private pendingThreadNewCwds = new Map<string, PendingThreadNewCwd>();
  private recentCommandUsageByScope = new Map<string, Map<string, number>>();
  private commandUsageSequence = 0;
  private locks = new Map<string, Promise<void>>();
  private approvalTimers = new Map<string, NodeJS.Timeout>();
  private submittedUserInputTimers = new Map<string, NodeJS.Timeout>();
  private restartPreviewRecoveryTimers = new Map<string, NodeJS.Timeout>();
  private voiceSnippets = new Map<string, { scopeId: string; text: string; createdAt: number }>();
  private latestVoiceSnippetByScope = new Map<string, string>();
  private selfUpdatePollTimer: NodeJS.Timeout | null = null;
  private proactiveAuthRefreshTimer: NodeJS.Timeout | null = null;
  private proactiveAuthRefreshInProgress = false;
  private proactiveAuthRefreshStatus: AuthProactiveRefreshStatus | null = null;
  private stalePanelDeleteTimers = new Map<string, NodeJS.Timeout>();
  private attachedThreads = new Set<string>();
  private codexReconnectPending = false;
  private codexReconnectRecovery: Promise<void> | null = null;
  private stopping = false;
  private botUsername: string | null = null;
  private lastError: string | null = null;
  /** Last threads-panel pagination state per scope (Telegram inline nav + /open index alignment). */
  private threadListPresentationState = new Map<string, ThreadListPresentationState>();
  private readonly messaging: BridgeMessagingRouter;

  constructor(
    private readonly config: AppConfig,
    private readonly store: BridgeStore,
    private readonly logger: Logger,
    private readonly bot: TelegramGateway,
    private readonly app: CodexAppClient,
    outbound: BridgeMessagingRouter,
    private readonly selfUpdater: SelfUpdateRuntime | null = null,
    private readonly coordinator: CoreCoordinator | null = null,
    private readonly ownsTelegramRuntime = true,
  ) {
    this.messaging = outbound;
    this.localUsage = new CodexLocalUsageService(config, store);
    this.authQuota = new CodexAuthQuotaService(config, store, logger, app, name => this.syncCodexAuthCandidate(name));
    this.nativePanels = new CodexNativePanelService(config, store, logger, app, { sendMessage: (scope, text, keyboard) => this.sendMessage(scope, text, keyboard), editMessage: (scope, id, text, keyboard) => this.editMessage(scope, id, text, keyboard), scheduleStalePanelDeletion: (scope, id) => this.scheduleStalePanelDeletion(scope, id), answerCallback: (id, text) => this.messaging.answerCallback(id, text) });

  }

  attachExecutionHost(host: { ownsScope(scopeId: string): boolean; hasExecutingTasks(): boolean }): void { this.executionHost = host; }
  async startControlPlane(): Promise<void> { await this.startCodexApp({ recoverExecution: false }); }
  async stopControlPlane(): Promise<void> { await this.stop({ keepTransports: true }); }
  getPendingApprovalCount(): number { return this.pendingApprovalMessages.size; }
  async dispatchBackendCommand(event: TelegramTextEvent): Promise<void> { await this.withLock(event.scopeId, () => this.handleText(event)); }

  /** Wire Telegram inbound events. Call before {@link startCodexApp}. */
  registerTelegramInboundHandlers(): void {
    this.bot.on('remoteReady', () => {
      this.botUsername = this.bot.username;
      this.updateStatus();
    });
    this.bot.on('text', (event: TelegramTextEvent) => {
      this.dispatchInboundLikeTelegramText(event);
    });
    this.bot.on('callback', (event: TelegramCallbackEvent) => {
      void this.handleCallback(event).catch((error) => {
        void this.handleAsyncError('telegram.callback', error, event.scopeId);
      });
    });
  }

  /**
   * Deliver an inbound user message through the same pipeline as Telegram `text` events
   * (used by the Weixin adapter).
   */
  dispatchInboundLikeTelegramText(event: TelegramTextEvent): void {
    const command = event.attachments.length === 0 ? parseCommand(event.text) : null;
    const name = command?.name;
    // Recovery commands must remain reachable while a normal command is waiting.
    // handleText still performs normal addressing and authorization checks.
    const urgent = name && (['status', 'cli', 'login_cancel', 'interrupt'].includes(name)
      || (name === 'auth' && command?.args[0] === 'sync' && ['status', 'events', 'trace'].includes(command.args[1] ?? 'status')));
    const task = urgent ? this.handleText(event) : this.withLock(event.scopeId, async () => this.handleText(event));
    void task.catch((error) => {
      void this.handleAsyncError('channel.text', error, event.scopeId);
    });
  }

  hasPendingInteraction(scopeId: string): boolean {
    return this.pendingThreadRenames.has(scopeId)
      || this.pendingThreadNewCwds.has(scopeId)
      || this.pendingUserInputs.has(scopeId)
      || this.pendingForceTakeovers.has(scopeId);
  }

  /** Start Codex app-server transport and attach RPC listeners. */
  async startCodexApp(options?: { recoverExecution?: boolean }): Promise<void> {
    if (this.controlPlaneStarted) return;
    this.controlPlaneStarted = true;
    this.recoverExecution = options?.recoverExecution !== false;
    this.stopping = false;
    this.listeners.listen(this.app, 'notification', (msg: JsonRpcNotification) => {
      this.trackControlOperation(this.handleNotification(msg).catch(error => this.handleAsyncError('codex.notification', error)));
    });
    this.listeners.listen(this.app, 'serverRequest', (msg: JsonRpcServerRequest) => {
      this.trackControlOperation(this.handleServerRequest(msg).catch(error => this.handleAsyncError('codex.server_request', error)));
    });
    this.listeners.listen(this.app, 'connected', () => {
      this.attachedThreads.clear();
      this.lastError = null;
      this.updateStatus();
    });
    this.listeners.listen(this.app, 'ready', () => {
      if (!this.recoverExecution) return;
      if (!this.codexReconnectPending || this.stopping) {
        return;
      }
      this.codexReconnectPending = false;
      this.scheduleCodexReconnectRecovery();
    });
    this.listeners.listen(this.app, 'disconnected', () => {
      this.attachedThreads.clear();
      this.threadTokenUsageAlerts.clear();
      if (!this.stopping) {
        if (!this.codexReconnectPending) {
          for (const scopeId of new Set([...this.activeTurns.values()].filter(active => !active.isObserved).map(active => active.scopeId))) {
            const locale = this.localeForChat(scopeId);
            void this.sendMessage(scopeId, locale === 'zh'
              ? 'Codex 连接中断，正在重连。任务结果尚未确认，请先用 /status 检查；也可用 /cli 从本机继续。'
              : 'Codex disconnected; reconnecting. The task result is unconfirmed. Check /status or use /cli locally.')
              .catch(error => this.logger.warn('codex.disconnect_notice_failed', { scopeId, error: toErrorMeta(error) }));
          }
        }
        this.codexReconnectPending = true;
        this.pauseAppSnapshotWatchers();
      }
      this.updateStatus();
    });

    if (typeof this.app.isConnected !== 'function' || !this.app.isConnected()) await this.app.start();
    if (options?.recoverExecution !== false) {
    this.store.requeueInterruptedQueuedTurnInputs();
    await this.restorePendingUserInputs();
    await this.restoreGuidedPlanSessions();
    await this.cleanupStaleTurnPreviews();
    void this.recoverQueuedTurns().catch((error) => {
      this.logger.warn('codex.queued_turn_recovery_failed', { error: toErrorMeta(error) });
    });
    }
    void this.refreshCodexLocalUsageIfNeeded().catch((error) => {
      this.logger.warn('codex.local_usage_background_refresh_failed', { error: formatUserError(error) });
    });
    this.updateStatus();
    this.scheduleSelfUpdateStatusPoll(0);
    this.scheduleProactiveAuthRefresh(CODEX_AUTH_PROACTIVE_REFRESH_INITIAL_DELAY_MS);
  }

  /** Begin Telegram Bot API long-polling after handlers and Codex are ready. */
  async startTelegramPolling(): Promise<void> {
    await this.bot.start();
    this.botUsername = this.bot.username;
    this.updateStatus();
  }

  /** Telegram-only default startup (single channel). */
  async start(): Promise<void> {
    this.registerTelegramInboundHandlers();
    await this.startCodexApp();
    await this.startTelegramPolling();
  }

  async stop(options?: { keepTransports?: boolean }): Promise<void> {
    this.stopping = true;
    this.controlPlaneStarted = false;
    this.listeners.clear();
    this.clearObservedThreadWatchers();
    this.clearSelfUpdateStatusPoll();
    this.clearProactiveAuthRefreshTimer();
    while (this.controlOperations.size) await Promise.allSettled([...this.controlOperations]);
    await this.localUsage.stop();
    this.codexReconnectPending = false;
    this.pendingTurnErrors.clear();
    this.pendingUserInputs.clear();
    this.pendingMcpElicitations.clear();
    this.pendingLoginsByScope.clear();
    this.pendingLoginScopesById.clear();
    this.pendingAuthAddsByLoginId.clear();
    for (const timer of this.authLoginRecoveryTimers.values()) clearTimeout(timer);
    this.authLoginRecoveryTimers.clear();
    this.latestTurnDiffs.clear();
    this.threadTokenUsageAlerts.clear();
    this.pendingAuthChoiceLists.clear();
    this.pendingThreadRenames.clear();
    this.pendingThreadNewCwds.clear();
    this.recentCommandUsageByScope.clear();
    this.commandUsageSequence = 0;
    this.pendingAuthRotation = null;
    this.authRefreshAllInProgress = false;
    this.externalAuthValidationInProgress = false;
    this.turnStartInProgress = 0;
    this.clearObservedThreadWatchers();
    this.releaseActiveTurnsForBridgeShutdown();
    if (!options?.keepTransports && this.ownsTelegramRuntime) await this.bot.stop();
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
    for (const timer of this.submittedUserInputTimers.values()) {
      clearTimeout(timer);
    }
    this.submittedUserInputTimers.clear();
    this.clearRestartPreviewRecoveryTimers();
    this.clearSelfUpdateStatusPoll();
    this.clearProactiveAuthRefreshTimer();
    for (const timer of this.stalePanelDeleteTimers.values()) {
      clearTimeout(timer);
    }
    this.stalePanelDeleteTimers.clear();
    if (!options?.keepTransports) await this.app.stop({ terminateServer: false });
    this.updateStatus();
  }

  getRuntimeStatus(): RuntimeStatus {
    const appServer = typeof this.app.getServerStatus === 'function' ? this.app.getServerStatus() : null;
    return {
      running: true,
      connected: typeof this.app.isConnected === 'function' ? this.app.isConnected() : false,
      userAgent: typeof this.app.getUserAgent === 'function' ? this.app.getUserAgent() : null,
      codexHome: this.config.codexHome ?? path.join(os.homedir(), '.codex'),
      ...(appServer ? { codexAppServer: appServer } : {}),
      botUsername: this.botUsername,
      currentBindings: this.store.countBindings(),
      pendingApprovals: this.store.countPendingApprovals(),
      pendingUserInputs: this.store.countPendingUserInputs(),
      queuedTurns: this.store.countQueuedTurnInputs(),
      activeTurns: this.activeTurns.size,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
      channels: {
        telegram: this.ownsTelegramRuntime,
        weixin: Boolean(this.config.wxEnabled && this.messaging.hasWeixinTransport),
      },
      authProactiveRefresh: this.proactiveAuthRefreshStatus,
    };
  }

  private async handleText(event: TelegramTextEvent): Promise<void> {
    const action = this.messaging.resolveAction(event);
    if (action) { await this.handleCallback(action); return; }
    const scopeId = event.scopeId;
    const locale = this.localeForChat(scopeId, event.languageCode);
    if (scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      this.store.insertAudit('inbound', scopeId, 'weixin.message', summarizeTelegramInput(event.text, event.attachments));
      const command = event.attachments.length === 0 ? parseCommand(event.text) : null;
      if (event.attachments.length === 0 && this.pendingThreadNewCwds.has(scopeId)) {
        await this.handleThreadNewCwdTextReply(event, locale);
        return;
      }
      if (command) {
        await this.handleCommand(event, locale, command.name, command.args);
        return;
      }
      if (event.attachments.length === 0 && this.hasPendingMcpElicitation(scopeId)) {
        await this.handleMcpElicitationTextReply(event, locale);
        return;
      }
      if (event.attachments.length === 0 && this.hasPendingUserInput(scopeId)) {
        await this.handleUserInputTextReply(event, locale);
        return;
      }
      if (!command && event.attachments.length === 0 && this.pendingThreadRenames.has(scopeId)) {
        await this.handleThreadRenameTextReply(event, locale);
        return;
      }
      if (this.findActiveTurn(scopeId)) {
        await this.handleActiveTurnInboundMessage(event, locale, event.text.trim());
        return;
      }
      if (this.externalAuthValidationInProgress) {
        await this.sendMessage(scopeId, t(locale, 'auth_sync_validation_busy'));
        return;
      }
      if (await this.queueObservedThreadMessage(event, locale, event.text.trim())) {
        return;
      }
      await this.startBoundTurnFromEvent(event, locale, event.text.trim());
      return;
    }
    this.store.insertAudit('inbound', scopeId, 'telegram.message', summarizeTelegramInput(event.text, event.attachments));
    const command = event.attachments.length === 0 ? parseCommand(event.text) : null;
    if (!command && event.attachments.length === 0 && this.hasPendingUserInput(scopeId)) {
      await this.handleUserInputTextReply(event, locale);
      return;
    }
    if (!command && event.attachments.length === 0 && this.hasPendingMcpElicitation(scopeId)) {
      await this.handleMcpElicitationTextReply(event, locale);
      return;
    }
    if (event.attachments.length === 0 && this.pendingThreadNewCwds.has(scopeId)) {
      await this.handleThreadNewCwdTextReply(event, locale);
      return;
    }
    if (!command && event.attachments.length === 0 && this.pendingThreadRenames.has(scopeId)) {
      await this.handleThreadRenameTextReply(event, locale);
      return;
    }
    const decision = resolveTelegramAddressing({
      text: event.text,
      attachmentsCount: event.attachments.length,
      entities: event.entities,
      command,
      botUsername: this.botUsername,
      isDefaultTopic: isDefaultTelegramScope({
        chatType: event.chatType,
        allowedChatId: this.config.tgAllowedChatId,
        allowedTopicId: this.config.tgAllowedTopicId,
        topicId: event.topicId,
        requireExplicitGroupAddressing: this.config.tgRequireExplicitGroupAddressing,
      }),
      replyToBot: event.replyToBot,
    });
    if (decision.kind === 'ignore') {
      return;
    }
    if (decision.kind === 'command') {
      await this.handleCommand(event, locale, decision.command.name, decision.command.args);
      return;
    }

    if (event.attachments.length > 0) {
      await this.handleTelegramAttachmentBatch(event, locale, decision.text);
      return;
    }

    if (await this.consumePendingAttachmentBatchWithText(event, locale, decision.text)) {
      return;
    }

    if (this.findActiveTurn(scopeId)) {
      await this.handleActiveTurnInboundMessage(event, locale, decision.text);
      return;
    }
    if (this.externalAuthValidationInProgress) {
      await this.sendMessage(scopeId, t(locale, 'auth_sync_validation_busy'));
      return;
    }
    if (await this.queueObservedThreadMessage(event, locale, decision.text)) {
      return;
    }

    await this.startBoundTurnFromEvent(event, locale, decision.text);
  }

  private async handleCommand(event: TelegramTextEvent, locale: AppLocale, name: string, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    this.rememberCommandUsage(scopeId, name);
    switch (name) {
      case 'start':
      case 'help': {
        const weixinNote = scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX) ? t(locale, 'help_weixin_note') : '';
        const lines = this.buildHelpLines(scopeId, locale);
        if (weixinNote) {
          lines.push('', weixinNote);
        }
        await this.sendMessage(scopeId, lines.join('\n'));
        return;
      }
      case 'status': {
        const binding = this.store.getBinding(scopeId);
        const settings = this.store.getChatSettings(scopeId);
        const access = this.resolveEffectiveAccess(scopeId, settings);
        const [fastStatus, codexUsageLines, codexLocalUsageLines, serviceStatus] = await Promise.all([
          this.resolveFastStatusLabel(locale, settings),
          this.buildCodexUsageStatusLines(locale),
          this.buildCodexLocalUsageStatusLines(locale),
          this.config.tgMultiBotMode
            ? (this.coordinator?.getServiceStatus?.() ?? Promise.resolve(null))
            : Promise.resolve(null),
        ]);
        const appServer = this.app.getServerStatus();
        const appServerLabel = appServer.pid && appServer.port
          ? `${appServer.running ? t(locale, 'status_app_server_running') : t(locale, 'status_app_server_stale')} pid=${appServer.pid} port=${appServer.port}`
          : t(locale, 'none');
        const cwd = binding?.cwd ?? this.config.defaultCwd;
        const lines = [
          t(locale, 'status_connected', { value: t(locale, this.app.isConnected() ? 'yes' : 'no') }),
          t(locale, 'status_app_server', { value: appServerLabel }),
          t(locale, 'status_user_agent', { value: this.app.getUserAgent() ?? t(locale, 'unknown') }),
          t(locale, 'status_current_thread', { value: binding?.threadId ?? t(locale, 'none') }),
          t(locale, 'line_cwd', { value: cwd }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
          t(locale, 'status_fast', { value: fastStatus }),
          t(locale, 'status_collaboration_mode', { value: formatCollaborationModeLabel(locale, settings?.collaborationMode ?? null) }),
          t(locale, 'active_current', {
            value: formatActiveTurnMessageModeLabel(locale, settings?.activeTurnMessageMode ?? null),
          }),
          t(locale, 'status_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }),
          t(locale, 'status_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }),
          t(locale, 'status_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }),
          t(locale, 'status_sync_on_open', { value: t(locale, this.config.codexAppSyncOnOpen ? 'yes' : 'no') }),
          t(locale, 'status_sync_on_turn_complete', { value: t(locale, this.config.codexAppSyncOnTurnComplete ? 'yes' : 'no') }),
          t(locale, 'status_pending_approvals', { value: this.store.countPendingApprovals() }),
          t(locale, 'status_pending_user_inputs', { value: this.store.countPendingUserInputs() }),
          t(locale, 'status_queued_turns', { value: this.store.countQueuedTurnInputs(scopeId) }),
          t(locale, 'status_active_turns', { value: this.activeTurns.size }),
          formatCodexAuthPoolSummary(locale, this.store.getCodexAuthPoolStats()),
        ];
        if (serviceStatus) {
          lines.push('', t(locale, 'status_runtime_overview'));
          for (const runtime of serviceStatus.bots) {
            lines.push(t(locale, 'status_runtime_bot', {
              bot: runtime.username ? `@${runtime.username}` : runtime.id,
              connected: t(locale, runtime.connected ? 'yes' : 'no'),
              runtime: t(locale, runtime.runtimeKind === 'default' ? 'status_runtime_kind_default' : 'status_runtime_kind_isolated'),
              auth: runtime.currentAuth ?? t(locale, 'none'),
              turns: runtime.activeTurns,
            }));
          }
          if (serviceStatus.weixinRuntime) {
            lines.push(t(locale, 'status_runtime_weixin', {
              connected: t(locale, serviceStatus.weixinRuntime.connected ? 'yes' : 'no'),
              turns: serviceStatus.weixinRuntime.activeTurns,
            }));
          }
          lines.push(serviceStatus.authMirror
            ? t(locale, 'status_auth_mirror_synced', {
              candidate: serviceStatus.authMirror.candidateName,
              source: serviceStatus.authMirror.sourceLabel,
              time: serviceStatus.authMirror.syncedAt,
            })
            : t(locale, 'status_auth_mirror_none'));
          if (serviceStatus.authSync?.enabled) {
            lines.push(t(locale, 'status_auth_sync', {
              node: serviceStatus.authSync.nodeId ?? t(locale, 'unknown'),
              contact: serviceStatus.authSync.transportLabel ?? t(locale, 'unknown'),
              peers: serviceStatus.authSync.peers.length,
              pending: serviceStatus.authSync.pendingImports,
            }));
            if (serviceStatus.authSync.lastError) {
              lines.push(t(locale, 'status_auth_sync_error', { value: serviceStatus.authSync.lastError }));
            }
            if (serviceStatus.authSync.candidateFailures?.length) {
              lines.push(t(locale, 'status_auth_sync_candidate_failures', {
                value: serviceStatus.authSync.candidateFailures
                  .slice(0, 3)
                  .map((failure) => `${failure.candidateName}: ${failure.reason}`)
                  .join('; '),
              }));
            }
          }
          if (serviceStatus.authProactiveRefresh) {
            lines.push(t(locale, 'status_auth_proactive_refresh', {
              value: formatAuthProactiveRefreshStatus(locale, serviceStatus.authProactiveRefresh),
            }));
          }
          if (shouldShowRuntimeLastUpdate(serviceStatus)) {
            const lastUpdate = serviceStatus.lastUpdate!;
            lines.push(t(locale, 'status_last_update', {
              from: lastUpdate.fromVersion,
              to: lastUpdate.toVersion ?? t(locale, 'unknown'),
              time: lastUpdate.updatedAt,
            }));
            const codexUpdateLine = this.formatCodexUpdateResult(lastUpdate);
            if (codexUpdateLine) {
              lines.push(t(locale, 'status_last_codex_update', { value: codexUpdateLine }));
            }
            if (lastUpdate.agyUpdate) {
              lines.push(locale === 'zh' ? `Antigravity CLI：${lastUpdate.agyUpdate}` : `Antigravity CLI: ${lastUpdate.agyUpdate}`);
            }
          } else {
            lines.push(t(locale, 'status_last_update_none'));
          }
        }
        lines.push(...codexUsageLines);
        lines.push(...codexLocalUsageLines);
        lines.splice(5, 0, t(locale, 'status_codex_home', {
          value: this.config.codexHome ?? path.join(os.homedir(), '.codex'),
        }));
        const messageId = await this.sendRichInternalMessage(scopeId, '/status', lines.join('\n'));
        this.scheduleStalePanelDeletion(scopeId, messageId);
        return;
      }
      case 'account': {
        await this.handleAccountCommand(scopeId, locale);
        return;
      }
      case 'quota': {
        await this.handleQuotaCommand(scopeId, locale);
        return;
      }
      case 'update': {
        await this.handleSelfUpdateCommand(scopeId, locale);
        return;
      }
      case 'quota_nudge': {
        await this.handleQuotaNudgeCommand(scopeId, locale, args);
        return;
      }
      case 'voice': {
        await this.handleVoiceCommand(scopeId, locale, args);
        return;
      }
      case 'login':
      case 'login_device': {
        await this.handleLoginDeviceCommand(scopeId, locale);
        return;
      }
      case 'login_cancel': {
        await this.handleLoginCancelCommand(scopeId, locale, args);
        return;
      }
      case 'cli': {
        const binding = this.store.getBinding(scopeId);
        const server = this.app.getServerStatus();
        if (!server.running || !server.port) {
          await this.sendMessage(scopeId, locale === 'zh' ? 'Codex 服务不可用，请在本机检查 foxclaw status。' : 'Codex server unavailable. Check foxclaw status locally.');
          return;
        }
        const threadArg = binding ? ` ${JSON.stringify(binding.threadId)}` : '';
        await this.sendMessage(scopeId, (locale === 'zh'
          ? '在运行桥的这台机器上执行，进入同一个 Codex 服务后可中断或继续会话：\n'
          : 'Run on the bridge host to interrupt or continue in the same Codex server:\n')
          + `codex resume --remote ws://127.0.0.1:${server.port}${threadArg}`);
        return;
      }
      case 'logout': {
        await this.handleLogoutCommand(scopeId, locale, args);
        return;
      }
      case 'auth_reload':
      case 'codex_restart': {
        await this.handleAuthReloadCommand(scopeId, locale);
        return;
      }
      case 'auth': {
        await this.handleAuthCommand(scopeId, locale, args);
        return;
      }
      case 'setup': {
        await this.showSetupPanel(scopeId, 'overview', undefined, locale);
        return;
      }
      case 'fast': {
        await this.handleFastCommand(scopeId, locale, args);
        return;
      }
      case 'active':
      case 'followup': {
        await this.handleActiveTurnMessageModeCommand(scopeId, locale, args);
        return;
      }
      case 'where': {
        await this.showWherePanel(scopeId, undefined, locale);
        return;
      }
      case 'goal': {
        await this.handleGoalCommand(scopeId, locale, args);
        return;
      }
      case 'goal_pause': {
        await this.handleGoalCommand(scopeId, locale, ['pause', ...args]);
        return;
      }
      case 'goal_resume': {
        await this.handleGoalCommand(scopeId, locale, ['resume', ...args]);
        return;
      }
      case 'goal_done': {
        await this.handleGoalCommand(scopeId, locale, ['done', ...args]);
        return;
      }
      case 'goal_clear': {
        await this.handleGoalCommand(scopeId, locale, ['clear', ...args]);
        return;
      }
      case 'history': {
        await this.handleHistoryCommand(scopeId, locale, args);
        return;
      }
      case 'files':
      case 'file': {
        await this.handleFilesCommand(scopeId, locale, args);
        return;
      }
      case 'remote': {
        await this.handleRemoteCommand(scopeId, locale);
        return;
      }
      case 'threads': {
        const archived = args[0]?.toLowerCase() === 'archived';
        const searchTerm = (archived ? args.slice(1) : args).join(' ').trim() || null;
        await this.showThreadsPanel(scopeId, undefined, searchTerm, locale, {}, archived);
        return;
      }
      case 'open': {
        const target = Number.parseInt(args[0] || '', 10);
        if (!Number.isFinite(target)) {
          await this.sendMessage(scopeId, t(locale, 'usage_open'));
          return;
        }
        const thread = this.store.getCachedThread(scopeId, target);
        if (!thread) {
          await this.sendMessage(scopeId, t(locale, 'unknown_cached_thread'));
          return;
        }
        if (thread.archived) {
          await this.sendMessage(scopeId, t(locale, 'thread_is_archived_use_unarchive'));
          return;
        }
        this.store.cancelQueuedTurnInputs(scopeId);
        await this.stopWatchingScopeThread(scopeId, thread.threadId);
        let binding: ThreadBinding;
        let readOnly = false;
        try {
          binding = await this.bindCachedThread(scopeId, thread.threadId);
        } catch (error) {
          if (isThreadNotFoundError(error)) {
            await this.sendMessage(scopeId, t(locale, 'cached_thread_unavailable'));
            return;
          }
          if (!isThreadActiveWriterError(error)) throw error;
          binding = this.bindCachedThreadReadOnly(scopeId, thread);
          readOnly = true;
        }
        const settings = this.store.getChatSettings(scopeId);
        const lines = [
          t(locale, 'bound_to_thread', { threadId: binding.threadId }),
          t(locale, 'line_title', { value: thread.name || thread.preview || t(locale, 'empty') }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
          t(locale, 'line_cwd', { value: binding.cwd ?? this.config.defaultCwd }),
        ];
        if (readOnly) {
          lines.push(t(locale, 'thread_active_writer_read_only'));
        }
        if (!readOnly && this.config.codexAppSyncOnOpen) {
          const revealError = await this.tryRevealThread(scopeId, binding.threadId, 'open');
          lines.push(revealError ? t(locale, 'codex_sync_failed', { error: revealError }) : t(locale, 'opened_in_codex'));
        }
        await this.sendMessage(scopeId, lines.join('\n'));
        await this.sendThreadContextSummary(scopeId, locale, binding.threadId);
        return;
      }
      case 'watch': {
        await this.handleWatchCommand(event, locale, args);
        return;
      }
      case 'unwatch': {
        const watchedThreadId = await this.unwatchThread(scopeId);
        if (!watchedThreadId) {
          await this.sendMessage(scopeId, t(locale, 'watch_not_enabled'));
          return;
        }
        await this.sendMessage(scopeId, t(locale, 'watch_stopped', { threadId: watchedThreadId }));
        return;
      }
      case 'steer': {
        await this.handleSteerCommand(event, locale, args);
        return;
      }
      case 'takeover': {
        await this.handleTakeoverCommand(event, locale, args);
        return;
      }
      case 'queue': {
        await this.handleQueueCommand(event, locale, args);
        return;
      }
      case 'new': {
        const cwd = args.join(' ').trim() || this.config.defaultCwd;
        this.pendingThreadRenames.delete(scopeId);
        await this.startNewThreadForRequestedCwd(scopeId, locale, cwd, null);
        return;
      }
      case 'fork': {
        await this.handleForkCommand(scopeId, locale, args);
        return;
      }
      case 'undo':
      case 'rollback': {
        await this.handleRollbackCommand(scopeId, locale, args);
        return;
      }
      case 'rename': {
        await this.handleRenameCommand(scopeId, locale, args);
        return;
      }
      case 'compact': {
        await this.handleCompactCommand(event, locale);
        return;
      }
      case 'archive': {
        await this.handleArchiveCommand(scopeId, locale);
        return;
      }
      case 'unarchive': {
        await this.handleUnarchiveCommand(scopeId, locale, args);
        return;
      }
      case 'thread_archive': {
        await this.handleThreadArchiveIndexCommand(scopeId, locale, args);
        return;
      }
      case 'thread_unarchive': {
        await this.handleUnarchiveCommand(scopeId, locale, args);
        return;
      }
      case 'thread_rename': {
        await this.handleThreadRenameIndexCommand(scopeId, locale, args);
        return;
      }
      case 'review': {
        await this.handleReviewCommand(event, locale, args);
        return;
      }
      case 'rich': {
        await this.handleRichCommand(scopeId, locale);
        return;
      }
      case 'diff': {
        await this.handleDiffCommand(scopeId, locale);
        return;
      }
      case 'loaded': {
        await this.handleLoadedCommand(scopeId, locale);
        return;
      }
      case 'skills': {
        await this.handleSkillsCommand(scopeId, locale, args);
        return;
      }
      case 'skill': {
        await this.handleSkillCommand(scopeId, locale, args);
        return;
      }
      case 'skill_enable': {
        await this.handleSkillConfigCommand(scopeId, locale, args, true);
        return;
      }
      case 'skill_disable': {
        await this.handleSkillConfigCommand(scopeId, locale, args, false);
        return;
      }
      case 'hooks': {
        await this.handleHooksCommand(scopeId, locale);
        return;
      }
      case 'plugins': {
        await this.handlePluginsCommand(scopeId, locale, args);
        return;
      }
      case 'plugin': {
        await this.handlePluginCommand(scopeId, locale, args);
        return;
      }
      case 'plugin_skill': {
        await this.handlePluginSkillCommand(scopeId, locale, args);
        return;
      }
      case 'apps': {
        await this.handleAppsCommand(scopeId, locale, args);
        return;
      }
      case 'features': {
        await this.handleFeaturesCommand(scopeId, locale);
        return;
      }
      case 'config': {
        await this.handleConfigCommand(scopeId, locale, args);
        return;
      }
      case 'requirements': {
        await this.handleRequirementsCommand(scopeId, locale);
        return;
      }
      case 'provider': {
        await this.handleProviderCommand(scopeId, locale);
        return;
      }
      case 'mcp': {
        await this.handleMcpCommand(scopeId, locale, args);
        return;
      }
      case 'mcp_reload': {
        await this.handleMcpReloadCommand(scopeId, locale);
        return;
      }
      case 'mcp_login': {
        await this.handleMcpLoginCommand(scopeId, locale, args);
        return;
      }
      case 'mcp_resource': {
        await this.handleMcpResourceCommand(scopeId, locale, args);
        return;
      }
      case 'mode': {
        if (args.length === 0) {
          await this.showSetupPanel(scopeId, 'mode', undefined, locale);
          return;
        }
        await this.handleModeCommand(scopeId, locale, args);
        return;
      }
      case 'plan': {
        await this.setCollaborationMode(scopeId, locale, 'plan');
        return;
      }
      case 'agent': {
        await this.setCollaborationMode(scopeId, locale, DEFAULT_COLLABORATION_MODE);
        return;
      }
      case 'model': {
        await this.handleModelCommand(event, locale, args);
        return;
      }
      case 'models': {
        await this.showSetupPanel(scopeId, 'model', undefined, locale);
        return;
      }
      case 'permissions':
      case 'access': {
        const accessArg = args.join(' ').trim();
        if (accessArg) {
          const preset = normalizeAccessPreset(accessArg);
          if (!preset) {
            await this.sendMessage(
              scopeId,
              t(locale, 'usage_access_preset', { value: accessArg }),
            );
            return;
          }
          this.setChatAccessPreset(scopeId, preset);
          await this.sendMessage(
            scopeId,
            t(locale, 'access_preset_configured', { value: formatAccessPresetLabel(locale, preset) }),
          );
          return;
        }
        await this.showSetupPanel(scopeId, 'access', undefined, locale);
        return;
      }
      case 'effort': {
        await this.handleEffortCommand(event, locale, args);
        return;
      }
      case 'reveal':
      case 'focus': {
        const binding = this.store.getBinding(scopeId);
        if (!binding) {
          await this.sendMessage(scopeId, t(locale, 'no_thread_bound_reveal'));
          return;
        }
        const readyBinding = await this.ensureThreadReady(scopeId, binding);
        const revealError = await this.tryRevealThread(scopeId, readyBinding.threadId, 'reveal');
        if (revealError) {
          await this.sendMessage(scopeId, t(locale, 'failed_open_codex', { error: revealError }));
          return;
        }
        await this.sendMessage(scopeId, t(locale, 'opened_thread_in_codex', { threadId: readyBinding.threadId }));
        return;
      }
      case 'interrupt': {
        const active = this.findActiveTurn(scopeId);
        if (!active) {
          await this.sendMessage(scopeId, t(locale, 'no_active_turn'));
          return;
        }
        if (active.isObserved) {
          await this.sendMessage(scopeId, t(locale, 'watch_read_only_active'));
          return;
        }
        await this.requestInterrupt(active);
        await this.sendMessage(scopeId, t(locale, 'interrupt_requested_for', { turnId: active.turnId }));
        return;
      }
      case 'approve': {
        await this.handleApprovalTextCommand(scopeId, locale, args);
        return;
      }
      case 'answer': {
        await this.handleUserInputAnswerCommand(scopeId, locale, args);
        return;
      }
      case 'planimpl': {
        await this.handlePlanImplementationTextCommand(scopeId, locale, args);
        return;
      }
      case 'mcpel': {
        await this.handleMcpElicitationTextCommand(scopeId, locale, args);
        return;
      }
      default: {
        await this.sendMessage(scopeId, t(locale, 'unknown_command', { name }));
      }
    }
  }

  private buildHelpLines(scopeId: string, locale: AppLocale): string[] {
    const recent = this.recentCommandUsageByScope.get(scopeId) ?? new Map<string, number>();
    const dynamic = DYNAMIC_HELP_COMMANDS
      .map((entry, index) => ({ entry, index, usedAt: recent.get(entry.key) ?? 0 }))
      .sort((a, b) => {
        if (a.usedAt !== b.usedAt) {
          return b.usedAt - a.usedAt;
        }
        return a.index - b.index;
      })
      .map(({ entry }) => entry.line);
    return [
      t(locale, 'help_commands_title'),
      ...PINNED_HELP_COMMANDS.map(entry => entry.line),
      ...dynamic,
      t(locale, 'help_advanced_aliases'),
      t(locale, 'help_plain_text_hint'),
    ];
  }

  private rememberCommandUsage(scopeId: string, name: string): void {
    const key = normalizeHelpUsageKey(name);
    if (!key) {
      return;
    }
    let recent = this.recentCommandUsageByScope.get(scopeId);
    if (!recent) {
      recent = new Map<string, number>();
      this.recentCommandUsageByScope.set(scopeId, recent);
    }
    recent.set(key, ++this.commandUsageSequence);
  }

  private async sendNewThreadStartedMessage(
    scopeId: string,
    locale: AppLocale,
    binding: ThreadBinding,
    requestedCwd: string,
  ): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    await this.sendMessage(scopeId, [
      t(locale, 'started_new_thread', { threadId: binding.threadId }),
      t(locale, 'line_cwd', { value: binding.cwd ?? requestedCwd }),
      t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
      t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
    ].join('\n'));
  }

  private async handleWatchCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    let binding: ThreadBinding | null;
    if (args.length > 0) {
      const index = Number.parseInt(args[0] || '', 10);
      if (!Number.isFinite(index)) {
        await this.sendMessage(scopeId, t(locale, 'usage_watch'));
        return;
      }
      const cached = this.store.getCachedThread(scopeId, index);
      if (!cached) {
        await this.sendMessage(scopeId, t(locale, 'unknown_cached_thread'));
        return;
      }
      if (cached.archived) {
        await this.sendMessage(scopeId, t(locale, 'thread_is_archived_use_unarchive'));
        return;
      }
      binding = this.bindCachedThreadReadOnly(scopeId, cached);
    } else {
      binding = this.store.getBinding(scopeId);
    }
    if (!binding) {
      await this.sendMessage(scopeId, t(locale, 'watch_no_thread_bound'));
      return;
    }
    const watch = await this.watchThread(scopeId, event.chatId, event.chatType, event.topicId, binding);
    const watchedThreadId = watch.threadId;
    const mode = watch.mode;
    if (mode === 'already') {
      await this.sendMessage(scopeId, t(locale, 'watch_already_enabled', { threadId: watchedThreadId }));
      await this.sendThreadContextSummary(scopeId, locale, watchedThreadId);
      return;
    }
    if (mode === 'active') {
      await this.sendMessage(scopeId, t(locale, 'watch_started_active', { threadId: watchedThreadId }));
      await this.sendThreadContextSummary(scopeId, locale, watchedThreadId);
      return;
    }
    await this.sendMessage(scopeId, t(locale, 'watch_started_idle', { threadId: watchedThreadId }));
    await this.sendThreadContextSummary(scopeId, locale, watchedThreadId);
  }

  private async handleThreadArchiveIndexCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const index = Number.parseInt(args[0] || '', 10);
    if (!Number.isFinite(index)) {
      await this.sendMessage(scopeId, t(locale, 'usage_thread_archive'));
      return;
    }
    const cached = this.store.getCachedThread(scopeId, index);
    if (!cached) {
      await this.sendMessage(scopeId, t(locale, 'unknown_cached_thread'));
      return;
    }
    if (cached.archived) {
      await this.sendMessage(scopeId, t(locale, 'thread_is_archived_use_unarchive'));
      return;
    }
    await this.archiveThreadFromPanel(scopeId, cached.threadId);
    await this.sendMessage(scopeId, t(locale, 'archive_done', { threadId: cached.threadId }));
  }

  private async handleThreadRenameIndexCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const index = Number.parseInt(args[0] || '', 10);
    const name = args.slice(1).join(' ').trim();
    if (!Number.isFinite(index) || !name) {
      await this.sendMessage(scopeId, t(locale, 'usage_thread_rename'));
      return;
    }
    const cached = this.store.getCachedThread(scopeId, index);
    if (!cached) {
      await this.sendMessage(scopeId, t(locale, 'unknown_cached_thread'));
      return;
    }
    if (cached.archived) {
      await this.sendMessage(scopeId, t(locale, 'thread_is_archived_use_unarchive'));
      return;
    }
    await this.app.setThreadName(cached.threadId, name);
    await this.sendMessage(scopeId, t(locale, 'rename_done', { name }));
  }

  async handleCallback(event: TelegramCallbackEvent): Promise<void> {
    const scopeId = event.scopeId;
    const locale = this.localeForChat(scopeId, event.languageCode);
    if (this.forceTakeoversInProgress.has(scopeId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'force_takeover_busy'));
      return;
    }
    const forceTakeoverMatch = /^takeover:(confirm|cancel):([a-f0-9]+)$/.exec(event.data);
    if (forceTakeoverMatch) {
      await this.handleForceTakeoverCallback(event, locale, forceTakeoverMatch[1]!, forceTakeoverMatch[2]!);
      return;
    }
    const loginCancelMatch = /^login:cancel:(.+)$/.exec(event.data);
    if (loginCancelMatch) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'button_cancel'));
      await this.handleLoginCancelCommand(scopeId, locale, [loginCancelMatch[1]!]);
      return;
    }
    const interruptMatch = /^turn:interrupt:(.+)$/.exec(event.data);
    if (interruptMatch) {
      await this.handleTurnInterruptCallback(event, interruptMatch[1]!, locale);
      return;
    }
    const listNavMatch = /^thread:list:(prev|next|clear|archived|recent)$/.exec(event.data);
    if (listNavMatch) {
      await this.handleThreadListNavigationCallback(event, listNavMatch[1]! as 'prev' | 'next' | 'clear' | 'archived' | 'recent', locale);
      return;
    }
    if (event.data === 'thread:new') {
      await this.handleThreadNewCallback(event, locale);
      return;
    }
    const threadNewMatch = /^thread:new:(.+)$/.exec(event.data);
    if (threadNewMatch) {
      await this.handleThreadNewFromThreadCallback(event, threadNewMatch[1]!, locale);
      return;
    }
    const newCwdMatch = /^thread:newcwd:(create|cancel)$/.exec(event.data);
    if (newCwdMatch) {
      await this.handleThreadNewCwdCallback(event, newCwdMatch[1]! as 'create' | 'cancel', locale);
      return;
    }
    const threadActionMatch = /^thread:(rename|watch|archive|unarchive):(.+)$/.exec(event.data);
    if (threadActionMatch) {
      await this.handleThreadActionCallback(
        event,
        threadActionMatch[1]! as 'rename' | 'watch' | 'archive' | 'unarchive',
        threadActionMatch[2]!,
        locale,
      );
      return;
    }
    const threadMatch = /^thread:open:(.+)$/.exec(event.data);
    if (threadMatch) {
      await this.handleThreadOpenCallback(event, threadMatch[1]!, locale);
      return;
    }
    const navMatch = /^nav:(models|threads|reveal|permissions)$/.exec(event.data);
    if (navMatch) {
      await this.handleNavigationCallback(event, navMatch[1]! as 'models' | 'threads' | 'reveal' | 'permissions', locale);
      return;
    }
    const setupMatch = /^setup:(model|effort|fast|access|mode|active):(.+)$/.exec(event.data);
    if (setupMatch) {
      await this.handleSetupCallback(
        event,
        setupMatch[1]! as 'model' | 'effort' | 'fast' | 'access' | 'mode' | 'active',
        setupMatch[2]!,
        locale,
      );
      return;
    }
    const configMatch = /^config:(auth_auto_delete|delete_tool_details):(on|off)$/.exec(event.data);
    if (configMatch) {
      await this.handleConfigToggleCallback(
        event,
        configMatch[1]! as 'auth_auto_delete' | 'delete_tool_details',
        configMatch[2] === 'on',
        locale,
      );
      return;
    }
    const voiceMatch = /^voice:([a-f0-9]+)$/.exec(event.data);
    if (voiceMatch) {
      await this.handleVoiceCallback(event, voiceMatch[1]!, locale);
      return;
    }
    const settingsMatch = /^settings:(model|effort|access):(.+)$/.exec(event.data);
    if (settingsMatch) {
      await this.handleSettingsCallback(event, settingsMatch[1]! as 'model' | 'effort' | 'access', settingsMatch[2]!, locale);
      return;
    }
    const authRepairActionMatch = /^auth:([a-f0-9]+):repair_(login|delete|cancel):(\d+)$/.exec(event.data);
    if (authRepairActionMatch) {
      await this.handleAuthRepairActionCallback(
        event,
        authRepairActionMatch[1]!,
        authRepairActionMatch[2]! as 'login' | 'delete' | 'cancel',
        Number.parseInt(authRepairActionMatch[3]!, 10),
        locale,
      );
      return;
    }
    const authRepairMatch = /^auth:([a-f0-9]+):repair:(\d+)$/.exec(event.data);
    if (authRepairMatch) {
      await this.handleAuthRepairMenuCallback(
        event,
        authRepairMatch[1]!,
        Number.parseInt(authRepairMatch[2]!, 10),
        locale,
      );
      return;
    }
    const authToggleMatch = /^auth:([a-f0-9]+):toggle:(\d+)$/.exec(event.data);
    if (authToggleMatch) {
      await this.handleAuthToggleCallback(
        event,
        authToggleMatch[1]!,
        Number.parseInt(authToggleMatch[2]!, 10),
        locale,
      );
      return;
    }
    const authPageMatch = /^auth:([a-f0-9]+):page:(prev|next)$/.exec(event.data);
    if (authPageMatch) {
      await this.handleAuthListViewCallback(
        event,
        authPageMatch[1]!,
        authPageMatch[2]! as 'prev' | 'next',
        locale,
      );
      return;
    }
    const authFilterMatch = /^auth:([a-f0-9]+):filter:(all|enabled|attention)$/.exec(event.data);
    if (authFilterMatch) {
      await this.handleAuthListViewCallback(
        event,
        authFilterMatch[1]!,
        authFilterMatch[2]! as CodexAuthListFilter,
        locale,
      );
      return;
    }
    const authClearSearchMatch = /^auth:([a-f0-9]+):clear_search$/.exec(event.data);
    if (authClearSearchMatch) {
      await this.handleAuthListViewCallback(event, authClearSearchMatch[1]!, 'clear_search', locale);
      return;
    }
    const authActionMatch = /^auth:([a-f0-9]+):(login_device|reload|safe_sync|cluster_audit|refresh_all_confirm|refresh_all_cancel|refresh_all)$/.exec(event.data);
    if (authActionMatch) {
      await this.handleAuthPanelActionCallback(
        event,
        authActionMatch[1]!,
        authActionMatch[2]! as 'login_device' | 'reload' | 'safe_sync' | 'cluster_audit' | 'refresh_all' | 'refresh_all_confirm' | 'refresh_all_cancel',
        locale,
      );
      return;
    }
    const authMatch = /^auth:([a-f0-9]+):(\d+)$/.exec(event.data);
    if (authMatch) {
      await this.handleAuthSwitchCallback(
        event,
        authMatch[1]!,
        Number.parseInt(authMatch[2]!, 10),
        locale,
      );
      return;
    }
    const userInputMatch = /^ui:([a-f0-9]+):(\d+):(\d+)$/.exec(event.data);
    if (userInputMatch) {
      await this.handleUserInputCallback(
        event,
        userInputMatch[1]!,
        Number.parseInt(userInputMatch[2]!, 10),
        Number.parseInt(userInputMatch[3]!, 10),
        locale,
      );
      return;
    }
    const planImplMatch = /^planimpl:([a-f0-9]+):(run|fresh|stay)$/.exec(event.data);
    if (planImplMatch) {
      await this.handlePlanImplementationCallback(
        event,
        planImplMatch[1]!,
        planImplMatch[2]! as 'run' | 'fresh' | 'stay',
        locale,
      );
      return;
    }
    const attachmentBatchMatch = /^attach:([a-f0-9]+):(analyze|clear)$/.exec(event.data);
    if (attachmentBatchMatch) {
      await this.handleAttachmentBatchCallback(
        event,
        attachmentBatchMatch[1]!,
        attachmentBatchMatch[2]! as 'analyze' | 'clear',
        locale,
      );
      return;
    }
    const mcpElicitationMatch = /^mcpel:([a-f0-9]+):(accept|decline|cancel)$/.exec(event.data);
    if (mcpElicitationMatch) {
      await this.handleMcpElicitationCallback(
        event,
        mcpElicitationMatch[1]!,
        mcpElicitationMatch[2]! as McpElicitationAction,
        locale,
      );
      return;
    }
    const match = /^approval:([a-f0-9]+):(accept|session|deny)$/.exec(event.data);
    if (!match) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    const localId = match[1]!;
    const action = match[2]! as ApprovalAction;
    const approval = this.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'approval_already_resolved'));
      return;
    }
    const scopedMessageId = this.pendingApprovalMessages.get(localId)?.get(scopeId) ?? (
      approval.chatId === scopeId ? approval.messageId : null
    );
    if (!this.scopeCanApproveThread(scopeId, approval.threadId) || (scopedMessageId !== null && scopedMessageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'approval_mismatch'));
      return;
    }

    const result = mapApprovalDecision(approval, action);
    await this.app.respond(parseStoredServerRequestId(approval.serverRequestId), result);
    await this.markApprovalResolvedForAllScopes(approval, action, scopeId);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
  }

  private async handleApprovalTextCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const localId = args[0]?.trim() ?? '';
    const action = normalizeApprovalTextAction(args[1] ?? '');
    if (!localId || !action) {
      await this.sendMessage(scopeId, t(locale, 'usage_approve'));
      return;
    }
    const approval = this.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      await this.sendMessage(scopeId, t(locale, 'approval_already_resolved'));
      return;
    }
    if (!this.scopeCanApproveThread(scopeId, approval.threadId)) {
      await this.sendMessage(scopeId, t(locale, 'approval_mismatch'));
      return;
    }

    const result = mapApprovalDecision(approval, action);
    await this.app.respond(parseStoredServerRequestId(approval.serverRequestId), result);
    await this.markApprovalResolvedForAllScopes(approval, action, scopeId);
  }

  private trackControlOperation(operation: Promise<void>): void {
    this.controlOperations.add(operation);
    void operation.catch(error => this.logger.warn('codex.control_operation_failed', { error: toErrorMeta(error) }))
      .finally(() => this.controlOperations.delete(operation));
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (this.stopping) return;
    const activity = normalizeTurnActivityEvent(notification);
    if (activity) {
      await this.handleTurnActivityEvent(activity);
      return;
    }

    switch (notification.method) {
      case 'sessionConfigured': {
        if (!this.recoverExecution) return;
        const params = notification.params as any;
        const threadId = String(params.session_id || '');
        if (!threadId) return;
        const scopeId = this.findChatByThread(threadId);
        if (!scopeId) return;
        const binding = this.store.getBinding(scopeId);
        const cwd = params.cwd ? String(params.cwd) : binding?.cwd ?? null;
        this.store.setBinding(scopeId, threadId, cwd);
        const current = this.store.getChatSettings(scopeId);
        const preserveDefaultModel = current !== null && current.model === null;
        const preserveDefaultEffort = current !== null && current.reasoningEffort === null;
        this.store.setChatSettings(
          scopeId,
          preserveDefaultModel
            ? null
            : params.model
              ? String(params.model)
              : current?.model ?? null,
          preserveDefaultEffort
            ? null
            : params.reasoning_effort === undefined
              ? current?.reasoningEffort ?? null
              : params.reasoning_effort === null
                ? null
                : String(params.reasoning_effort) as ReasoningEffortValue,
        );
        this.updateStatus();
        return;
      }
      case 'error': {
        await this.handleCodexErrorNotification(notification.params);
        return;
      }
      case 'turn/started': {
        await this.handleTurnStartedNotification(notification.params);
        return;
      }
      case 'turn/diff/updated': {
        await this.handleTurnDiffUpdated(notification.params);
        return;
      }
      case 'thread/status/changed': {
        await this.handleThreadStatusChanged(notification.params);
        return;
      }
      case 'thread/tokenUsage/updated': {
        await this.handleThreadTokenUsageUpdated(notification.params);
        return;
      }
      case 'thread/goal/updated':
      case 'thread/goal/cleared': {
        await this.handleThreadGoalNotification(notification.method, notification.params);
        return;
      }
      case 'item/mcpToolCall/progress': {
        await this.handleMcpToolCallProgress(notification.params);
        return;
      }
      case 'model/rerouted':
      case 'model/verification': {
        await this.handleModelNotification(notification.method, notification.params);
        return;
      }
      case 'remoteControl/status/changed': {
        await this.handleRemoteControlStatusChanged(notification.params);
        return;
      }
      case 'thread/name/updated':
      case 'thread/archived':
      case 'thread/unarchived':
      case 'thread/closed': {
        await this.handleThreadLifecycleNotification(notification.method, notification.params);
        return;
      }
      case 'serverRequest/resolved': {
        await this.handleServerRequestResolved(notification.params);
        return;
      }
      case 'account/login/completed': {
        await this.handleAccountLoginCompleted(notification.params);
        return;
      }
      case 'account/updated': {
        await this.handleAccountUpdated(notification.params);
        return;
      }
      case 'account/rateLimits/updated': {
        await this.handleRateLimitsUpdated();
        return;
      }
      case 'skills/changed': {
        await this.handleSkillsChangedNotification();
        return;
      }
      case 'app/list/updated': {
        await this.handleAppListUpdated(notification.params);
        return;
      }
      case 'mcpServer/startupStatus/updated': {
        await this.handleMcpStartupStatusUpdated(notification.params);
        return;
      }
      case 'mcpServer/oauthLogin/completed': {
        await this.handleMcpOauthLoginCompleted(notification.params);
        return;
      }
      case 'warning':
      case 'guardianWarning':
      case 'deprecationNotice':
      case 'configWarning': {
        await this.handleBridgeWarningNotification(notification.method, notification.params);
        return;
      }
      default:
        return;
    }
  }

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    if (this.stopping) return;
    const threadId = (request.params as { threadId?: unknown } | null)?.threadId;
    if (this.executionHost && typeof threadId === 'string' && !this.findChatByThread(threadId)) return;
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const params = request.params as any;
        const approval = this.createApprovalRecord('command', request.id, params);
        await this.notePendingApprovalStatus(approval.threadId, approval.kind);
        await this.sendApprovalRequestToThreadScopes(approval);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/fileChange/requestApproval': {
        const params = request.params as any;
        const approval = this.createApprovalRecord('fileChange', request.id, params);
        await this.notePendingApprovalStatus(approval.threadId, approval.kind);
        await this.sendApprovalRequestToThreadScopes(approval);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/permissions/requestApproval': {
        const params = request.params as any;
        const approval = this.createPermissionApprovalRecord(request.id, params);
        await this.notePendingApprovalStatus(approval.threadId, approval.kind);
        await this.sendApprovalRequestToThreadScopes(approval);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/tool/requestUserInput': {
        const params = request.params as any;
        await this.handleUserInputRequest(request.id, params);
        return;
      }
      case 'mcpServer/elicitation/request': {
        await this.handleMcpElicitationRequest(request.id, request.params as any);
        return;
      }
      default: {
        await this.app.respondError(request.id, `Unsupported server request: ${request.method}`);
      }
    }
  }

  private async sendApprovalRequestToThreadScopes(approval: PendingApprovalRecord): Promise<void> {
    const scopes = this.findAllChatsByThread(approval.threadId);
    if (!scopes.includes(approval.chatId)) {
      scopes.unshift(approval.chatId);
    }
    const messages = new Map<string, number>();
    for (const scopeId of scopes) {
      const locale = this.localeForChat(scopeId);
      const messageId = await this.sendMessage(
        scopeId,
        renderApprovalMessage(locale, approval, undefined, scopeId),
        approvalKeyboard(locale, approval.localId),
      );
      messages.set(scopeId, messageId);
      if (scopeId === approval.chatId) {
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
      }
    }
    this.pendingApprovalMessages.set(approval.localId, messages);
  }

  private async markApprovalResolvedForAllScopes(
    approval: PendingApprovalRecord,
    action: ApprovalAction,
    resolvedByScopeId: string,
  ): Promise<void> {
    this.store.markApprovalResolved(approval.localId);
    this.clearApprovalTimer(approval.localId);
    await this.clearPendingApprovalStatus(approval.threadId, approval.kind);
    const messages = this.pendingApprovalMessages.get(approval.localId) ?? new Map<string, number>();
    if (approval.messageId !== null && !messages.has(approval.chatId)) {
      messages.set(approval.chatId, approval.messageId);
    }
    for (const [scopeId, messageId] of messages) {
      const locale = this.localeForChat(scopeId);
      try {
        await this.editMessage(scopeId, messageId, renderApprovalMessage(locale, approval, action, scopeId), []);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('approval.resolve_edit_failed', {
            localId: approval.localId,
            scopeId,
            messageId,
            error: toErrorMeta(error),
          });
        }
      }
    }
    if (!messages.has(resolvedByScopeId)) {
      await this.sendMessage(resolvedByScopeId, t(this.localeForChat(resolvedByScopeId), 'decision_recorded'));
    }
    this.pendingApprovalMessages.delete(approval.localId);
    this.updateStatus();
  }

  private async handleCodexErrorNotification(params: any): Promise<void> {
    if (isRetryableCodexTransportError(params)) {
      this.logger.info('codex.transport.retrying', {
        message: stringOrNull(params?.error?.message),
        threadId: stringOrNull(params?.threadId),
        turnId: stringOrNull(params?.turnId),
      });
      return;
    }
    const message = formatCodexNotificationError(params);
    this.lastError = message;
    this.logger.error('codex.notification.error', params);

    const turnId = stringOrNull(params?.turnId);
    const threadId = stringOrNull(params?.threadId);
    const activeTurns = turnId
      ? this.getActiveTurnsForTurn(turnId)
      : threadId
        ? this.findActiveTurnsByThreadId(threadId)
        : [];
    const authRotationReason = classifyCodexAuthRotationError(params);
    const isAuthRotationError = authRotationReason !== null;
    const willRetry = params?.willRetry === true;
    const active = isAuthRotationError
      ? activeTurns.find(turn => turn.authRetry !== null) ?? activeTurns.find(turn => !turn.isObserved) ?? activeTurns[0] ?? null
      : activeTurns.find(turn => !turn.isObserved) ?? activeTurns[0] ?? null;

    if (activeTurns.length > 0) {
      for (const turn of activeTurns) {
        await this.recordActiveTurnError(turn, message);
      }
    } else if (turnId) {
      this.pendingTurnErrors.set(turnId, message);
    }
    if (authRotationReason && !willRetry && active?.authRetry) {
      const scopeId = active.scopeId;
      if (scopeId) {
        this.pendingAuthRotation = {
          scopeId,
          reason: message,
          reasonKind: authRotationReason,
          retry: cloneAuthRetryContext(active.authRetry),
        };
      }
    }
    if (isAuthRotationError && !willRetry && activeTurns.length > 0) {
      for (const turn of activeTurns) {
        await this.finishTerminalErroredActiveTurn(turn);
      }
    }
    this.updateStatus();
    await this.maybeRunPendingAuthRotation();
  }

  private async handleTurnStartedNotification(params: any): Promise<void> {
    const turnId = stringOrNull(params?.turn?.id);
    const threadId = stringOrNull(params?.threadId);
    if (!turnId || !threadId) {
      return;
    }
    if (!this.recoverExecution) {
      for (const watcher of this.observedThreadWatchers.values()) {
        if (!watcher.stopped && watcher.threadId === threadId) await this.ensureObservedActiveTurnState(watcher, turnId);
      }
      return;
    }
    for (const scopeId of this.findAllChatsByThread(threadId)) {
      if (this.getActiveTurn(scopeId, turnId) || this.findActiveTurn(scopeId)) {
        continue;
      }
      const target = resolveScopeMessageTarget(scopeId);
      if (!target) {
        continue;
      }
      await this.registerActiveTurn(scopeId, target.chatId, target.chatType, target.topicId, threadId, turnId, 0);
    }
  }

  private async handleTurnDiffUpdated(params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    const turnId = stringOrNull(params?.turnId);
    const diff = typeof params?.diff === 'string' ? params.diff : '';
    if (!threadId || !turnId) {
      return;
    }
    for (const scopeId of this.findAllChatsByThread(threadId)) {
      this.latestTurnDiffs.set(scopeId, { scopeId, threadId, turnId, diff, updatedAt: Date.now() });
    }
  }

  private async handleThreadStatusChanged(params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    if (!threadId) {
      return;
    }
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      return;
    }
    const status = normalizeThreadStatusLabel(params?.status);
    if (status === 'idle') {
      return;
    }
    if (status === 'active' || status === 'running') {
      return;
    }
    const locale = this.localeForChat(scopeId);
    await this.sendMessage(scopeId, t(locale, 'thread_status_changed', { threadId, status }));
  }

  private async handleThreadTokenUsageUpdated(params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    if (!threadId) {
      return;
    }
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      return;
    }
    const usage = formatThreadTokenUsage(params?.tokenUsage);
    if (!usage) {
      return;
    }
    const turnId = stringOrNull(params?.turnId);
    if (!this.shouldNotifyThreadTokenUsage(threadId, turnId, usage)) {
      return;
    }
    const locale = this.localeForChat(scopeId);
    await this.sendMessage(scopeId, t(locale, 'thread_token_usage_high', {
      threadId,
      percent: usage.percent,
      total: usage.total,
      limit: usage.limit,
    }));
  }

  private async handleThreadGoalNotification(method: string, params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    if (!threadId) {
      return;
    }
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      return;
    }
    const locale = this.localeForChat(scopeId);
    if (method === 'thread/goal/cleared') {
      return;
    }
    const goal = mapGoalNotification(params?.goal);
    if (!goal) {
      return;
    }
    await this.sendMessage(scopeId, t(locale, 'goal_updated_notification', {
      status: goal.status,
      objective: truncateInline(goal.objective, 180),
    }));
  }

  private async handleMcpToolCallProgress(params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    const message = stringOrNull(params?.message);
    if (!threadId || !message) {
      return;
    }
    const activeTurns = this.findActiveTurnsByThreadId(threadId);
    if (activeTurns.length === 0) {
      for (const scopeId of this.findAllChatsByThread(threadId)) {
        await this.sendMessage(scopeId, t(this.localeForChat(scopeId), 'mcp_tool_progress', {
          message: truncateInline(message, 220),
        }));
      }
      return;
    }
    for (const active of activeTurns) {
      active.pendingArchivedStatus = {
        text: t(this.localeForChat(active.scopeId), 'mcp_tool_progress', {
          message: truncateInline(message, 220),
        }),
        html: null,
      };
      await this.queueTurnRender(active, { forceStatus: true });
    }
  }

  private async handleModelNotification(method: string, params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    if (!threadId) {
      return;
    }
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      return;
    }
    const locale = this.localeForChat(scopeId);
    if (method === 'model/rerouted') {
      await this.sendMessage(scopeId, t(locale, 'model_rerouted_notification', {
        from: String(params?.fromModel ?? t(locale, 'unknown')),
        to: String(params?.toModel ?? t(locale, 'unknown')),
        reason: formatRawLabel(params?.reason),
      }));
      return;
    }
    const verifications = Array.isArray(params?.verifications)
      ? params.verifications.map((entry: unknown) => formatRawLabel(entry)).join(', ')
      : t(locale, 'unknown');
    await this.sendMessage(scopeId, t(locale, 'model_verification_notification', { value: verifications }));
  }

  private async handleRemoteControlStatusChanged(params: any): Promise<void> {
    const next: RemoteControlStatusState = {
      status: formatRawLabel(params?.status),
      installationId: stringOrNull(params?.installationId),
      environmentId: stringOrNull(params?.environmentId),
    };
    const previous = this.lastRemoteControlStatus;
    this.lastRemoteControlStatus = next;
    const changed = !previous
      || previous.status !== next.status
      || previous.environmentId !== next.environmentId
      || previous.installationId !== next.installationId;
    if (!changed || (!previous && next.status === 'disabled' && !next.environmentId)) {
      return;
    }
    const seen = new Set<string>();
    for (const turn of this.activeTurns.values()) {
      if (seen.has(turn.scopeId)) continue;
      seen.add(turn.scopeId);
      await this.sendMessage(turn.scopeId, formatRemoteStatusMessage(this.localeForChat(turn.scopeId), next));
    }
  }

  private shouldNotifyThreadTokenUsage(
    threadId: string,
    turnId: string | null,
    usage: { percent: number; limit: number },
  ): boolean {
    const bucket = usage.percent >= 99
      ? 99
      : usage.percent >= 95
        ? 95
        : usage.percent >= 90
          ? 90
          : 85;
    const previous = this.threadTokenUsageAlerts.get(threadId);
    if (previous && previous.turnId === turnId && previous.bucket === bucket && previous.limit === usage.limit) {
      return false;
    }
    this.threadTokenUsageAlerts.set(threadId, { turnId, bucket, limit: usage.limit });
    return true;
  }

  private async handleThreadLifecycleNotification(method: string, params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    if (!threadId) {
      return;
    }
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      return;
    }
    const locale = this.localeForChat(scopeId);
    if (method === 'thread/name/updated') {
      await this.sendMessage(scopeId, t(locale, 'thread_name_updated', { name: params?.threadName ?? t(locale, 'untitled') }));
      return;
    }
    if (method === 'thread/archived') {
      await this.sendMessage(scopeId, t(locale, 'thread_archived_notification', { threadId }));
      return;
    }
    if (method === 'thread/unarchived') {
      await this.sendMessage(scopeId, t(locale, 'thread_unarchived_notification', { threadId }));
      return;
    }
    if (method === 'thread/closed') {
      this.attachedThreads.delete(attachedThreadKey(scopeId, threadId));
    }
  }

  private async handleServerRequestResolved(params: any): Promise<void> {
    const requestId = parseServerRequestId(params?.requestId);
    if (requestId === null) {
      return;
    }
    const storedRequestId = stringifyServerRequestId(requestId);

    const approval = this.store.getPendingApprovalByServerRequestId(storedRequestId);
    if (approval) {
      this.store.markApprovalResolved(approval.localId);
      this.clearApprovalTimer(approval.localId);
      await this.clearPendingApprovalStatus(approval.threadId, approval.kind);
      this.pendingApprovalMessages.delete(approval.localId);
    }

    const userInput = [...this.pendingUserInputs.values()].find(record => sameServerRequestId(record.serverRequestId, requestId)) ?? null;
    if (userInput) {
      this.logger.info('codex.user_input_resolved', {
        localId: userInput.localId,
        serverRequestId: stringifyServerRequestId(userInput.serverRequestId),
        threadId: userInput.threadId,
        turnId: userInput.turnId,
        itemId: userInput.itemId,
      });
      this.clearSubmittedUserInputTimer(userInput.localId);
      this.pendingUserInputs.delete(userInput.localId);
      userInput.status = 'resolved';
      this.store.markPendingUserInputResolved(userInput.localId);
      if (userInput.messageId !== null) {
        const locale = this.localeForChat(userInput.chatId);
        await this.editMessage(
          userInput.chatId,
          userInput.messageId,
          renderUserInputMessage(locale, userInput),
          [],
        ).catch((error) => {
          if (!isTelegramMessageGone(error)) {
            this.logger.warn('telegram.user_input_resolved_edit_failed', {
              localId: userInput.localId,
              chatId: userInput.chatId,
              messageId: userInput.messageId,
              error: toErrorMeta(error),
            });
          }
        });
      }
    }

    this.updateStatus();
  }

  private async handleAccountLoginCompleted(params: any): Promise<void> {
    const loginId = params?.loginId === null ? null : stringOrNull(params?.loginId);
    const scopeId = loginId ? this.pendingLoginScopesById.get(loginId) ?? null : null;
    if (!scopeId) {
      return;
    }
    const pendingAuthAdd = loginId ? this.pendingAuthAddsByLoginId.get(loginId) ?? null : null;
    if (params?.success && pendingAuthAdd) await this.reconcileAuthLoginCredential(pendingAuthAdd);
    // A recovery check and the server notification may complete concurrently.
    if (this.pendingLoginScopesById.get(loginId!) !== scopeId) return;
    const timer = this.authLoginRecoveryTimers.get(loginId!);
    if (timer) clearTimeout(timer);
    this.authLoginRecoveryTimers.delete(loginId!);
    this.pendingLoginScopesById.delete(loginId!);
    if (this.pendingLoginsByScope.get(scopeId) === loginId) {
      this.pendingLoginsByScope.delete(scopeId);
    }
    if (loginId) {
      this.pendingAuthAddsByLoginId.delete(loginId);
    }
    const locale = this.localeForChat(scopeId);
    const success = Boolean(params?.success);
    if (pendingAuthAdd) {
      if (!success) {
        await this.restorePendingAuthAdd(pendingAuthAdd);
        await this.sendMessage(scopeId, [
          t(locale, pendingAuthAdd.mode === 'repair' ? 'auth_repair_failed' : 'auth_add_failed', {
            value: pendingAuthAdd.name,
            error: params?.error ?? t(locale, 'unknown'),
          }),
          t(locale, pendingAuthAdd.mode === 'repair' ? 'auth_repair_reverted' : 'auth_add_reverted'),
        ].join('\n'));
        return;
      }
      const stat = await fs.stat(pendingAuthAdd.path).catch(() => null);
      if (!stat?.isFile()) {
        await this.restorePendingAuthAdd(pendingAuthAdd);
        await this.sendMessage(scopeId, [
          t(locale, pendingAuthAdd.mode === 'repair' ? 'auth_repair_missing_file' : 'auth_add_missing_file', { value: pendingAuthAdd.name }),
          t(locale, pendingAuthAdd.mode === 'repair' ? 'auth_repair_reverted' : 'auth_add_reverted'),
        ].join('\n'));
        return;
      }
      if (pendingAuthAdd.mode === 'repair') {
        const metadata = await readChatGptAuthMetadata(pendingAuthAdd.path);
        if (!metadata || !chatGptAuthMetadataMatchesCandidateName(pendingAuthAdd.name, metadata)) {
          await this.restorePendingAuthAdd(pendingAuthAdd);
          await this.sendMessage(scopeId, [
            t(locale, 'auth_repair_identity_mismatch', { value: pendingAuthAdd.name }),
            t(locale, 'auth_repair_reverted'),
          ].join('\n'));
          return;
        }
        this.markCodexAuthCandidateActive(pendingAuthAdd.name);
        this.store.setCodexAuthCandidateDisabled(pendingAuthAdd.name, false);
        this.store.setCodexAuthCandidateDisabled(pendingAuthAdd.name, false, this.authRuntimeId());
      }
      const lines = [t(locale, pendingAuthAdd.mode === 'repair' ? 'auth_repair_done' : 'auth_add_done', { value: pendingAuthAdd.name })];
      try {
        await this.coordinator?.authCandidateUpdated?.(this.authRuntimeId(), pendingAuthAdd.name);
      } catch (error) {
        this.logger.warn('codex.auth_candidate_sync_failed', {
          candidate: pendingAuthAdd.name,
          runtimeId: this.authRuntimeId(),
          error: toErrorMeta(error),
        });
      }
      lines.push(...await this.buildCodexUsageStatusLines(locale));
      await this.sendMessage(scopeId, lines.join('\n'));
      return;
    }
    if (!success) {
      await this.sendMessage(scopeId, t(locale, 'login_failed', { error: params?.error ?? t(locale, 'unknown') }));
      return;
    }
    const currentCandidate = (await this.listCodexAuthState()).candidates.find(candidate => candidate.isCurrent) ?? null;
    if (currentCandidate) {
      this.markCodexAuthCandidateActive(currentCandidate.name);
      await this.syncCodexAuthCandidate(currentCandidate.name);
    }
    await this.sendMessage(scopeId, t(locale, 'login_completed'));
  }

  private async restorePendingAuthAdd(record: PendingAuthAdd): Promise<void> {
    const state = await this.listCodexAuthState();
    await this.restoreAuthAfterAddFailure(state.authDir, state.authPath, record.previousTargetPath);
  }

  private scheduleAuthLoginRecovery(loginId: string): void {
    if (this.stopping) return;
    const timer = setTimeout(() => {
      this.authLoginRecoveryTimers.delete(loginId);
      this.trackControlOperation(this.recoverAuthLogin(loginId).catch(error => {
        this.logger.warn('codex.auth_login_recovery_failed', { error: toErrorMeta(error) });
      }).finally(() => {
        if (!this.stopping && this.pendingAuthAddsByLoginId.has(loginId)) {
          this.scheduleAuthLoginRecovery(loginId);
        }
      }));
    }, 5_000);
    timer.unref();
    this.authLoginRecoveryTimers.set(loginId, timer);
  }

  private async recoverAuthLogin(loginId: string): Promise<void> {
    const record = this.pendingAuthAddsByLoginId.get(loginId);
    if (!record) return;
    if (Date.now() - record.createdAt >= 15 * 60_000) {
      await this.handleAccountLoginCompleted({ loginId, success: false, error: 'Device login timed out; completion was not confirmed.' });
      return;
    }
    await this.reconcileAuthLoginCredential(record);
    const metadata = await readChatGptAuthMetadata(record.path);
    if (!metadata || metadata.lastRefreshMs < record.createdAt
      || !chatGptAuthMetadataMatchesCandidateName(record.name, metadata)) return;
    const account = await this.app.readAccount(true);
    const limits = await this.app.readAccountRateLimits();
    if (!account || !limits || !selectCodexRateLimitSnapshot(limits)
      || (metadata.email && account.email !== metadata.email)) return;
    if (!this.pendingAuthAddsByLoginId.has(loginId)) return;
    this.logger.info('codex.auth_login_recovered', { candidate: record.name });
    await this.handleAccountLoginCompleted({ loginId, success: true });
  }

  private async reconcileAuthLoginCredential(record: PendingAuthAdd): Promise<void> {
    const authPath = path.join(this.resolveAuthDir(), 'auth.json');
    const [target, current] = await Promise.all([
      readChatGptAuthRecord(record.path), readChatGptAuthRecord(authPath),
    ]);
    // Codex can replace auth.json atomically, breaking our candidate symlink.
    // Only adopt a newly written credential for the same account identity.
    if (target && current && current.lastRefreshMs >= record.createdAt
      && current.quotaIdentityId === target.quotaIdentityId
      && current.lastRefreshMs > target.lastRefreshMs
      && chatGptAuthMetadataMatchesCandidateName(record.name, current)) {
      if (!this.pendingAuthAddsByLoginId.has(record.loginId)) return;
      const temporary = `${record.path}.${process.pid}.tmp`;
      await fs.writeFile(temporary, current.raw, { mode: 0o600 });
      await fs.rename(temporary, record.path);
      await pointCodexAuthAtTarget(this.resolveAuthDir(), authPath, record.path);
    }
  }

  private async restoreAuthAfterAddFailure(authDir: string, authPath: string, previousTargetPath: string | null): Promise<void> {
    if (previousTargetPath) {
      await pointCodexAuthAtTarget(authDir, authPath, previousTargetPath);
    } else {
      await fs.unlink(authPath).catch((error) => {
        if (!isFileMissingError(error)) {
          throw error;
        }
      });
    }
    this.pendingTurnErrors.clear();
    this.attachedThreads.clear();
    await this.app.restart();
  }

  private async handleAccountUpdated(params: any): Promise<void> {
    if (this.pendingLoginScopesById.size > 0) {
      return;
    }
    const scopeId = [...this.pendingLoginsByScope.keys()][0];
    if (!scopeId) {
      return;
    }
    const locale = this.localeForChat(scopeId);
    await this.sendMessage(scopeId, t(locale, 'account_updated', {
      value: [params?.authMode ?? t(locale, 'none'), params?.planType ?? null].filter(Boolean).join(' · '),
    }));
  }

  private async handleRateLimitsUpdated(): Promise<void> {
    this.localUsage.invalidate();
  }

  private async handleSkillsChangedNotification(): Promise<void> {
    this.logger.info('codex.skills_changed');
  }

  private async handleAppListUpdated(params: any): Promise<void> {
    const count = Array.isArray(params?.data) ? params.data.length : 0;
    await this.notifyBoundScopes(`Apps list updated${count ? ` (${count})` : ''}.`);
  }

  private async handleMcpStartupStatusUpdated(params: any): Promise<void> {
    const name = stringOrNull(params?.name);
    const status = stringOrNull(params?.status);
    if (!name || !status) {
      return;
    }
    const message = params?.error
      ? `MCP ${name}: ${status} (${String(params.error)})`
      : `MCP ${name}: ${status}`;
    const normalized = status.toLowerCase();
    if (!params?.error && ['ready', 'running', 'starting', 'connected'].includes(normalized)) {
      return;
    }
    await this.notifyBoundScopes(message);
  }

  private async handleMcpOauthLoginCompleted(params: any): Promise<void> {
    const name = stringOrNull(params?.name) ?? 'MCP';
    const success = Boolean(params?.success);
    const message = success
      ? `MCP ${name} OAuth login completed.`
      : `MCP ${name} OAuth login failed: ${String(params?.error ?? 'unknown')}`;
    await this.notifyBoundScopes(message);
  }

  private async handleBridgeWarningNotification(method: string, params: any): Promise<void> {
    if (isCodexTransportFallbackWarning(method, params)) {
      this.logger.info('codex.transport.fallback', {
        message: stringOrNull(params?.message),
        threadId: stringOrNull(params?.threadId),
      });
      return;
    }
    const threadId = stringOrNull(params?.threadId);
    const scopeId = threadId ? this.findChatByThread(threadId) : null;
    const locale = scopeId ? this.localeForChat(scopeId) : 'en';
    const message = formatWarningNotification(locale, method, params);
    if (scopeId) {
      await this.sendMessage(scopeId, message);
      return;
    }
    await this.notifyBoundScopes(message);
  }

  private async notifyBoundScopes(message: string): Promise<void> {
    const seen = new Set<string>();
    for (const turn of this.activeTurns.values()) {
      if (seen.has(turn.scopeId)) continue;
      if (!this.messaging.canSendToScope(turn.scopeId)) continue;
      seen.add(turn.scopeId);
      await this.sendMessage(turn.scopeId, message);
    }
  }

  private async recordActiveTurnError(active: ActiveTurn, message: string): Promise<void> {
    const locale = this.localeForChat(active.scopeId);
    const text = t(locale, 'codex_turn_error', { error: message });
    active.finalText = text;
    active.buffer = text;
    const segment = ensureTurnSegment(active, `${active.turnId}:codex-error`, 'final_answer', 'final_answer', false);
    segment.text = text;
    segment.completed = true;
    segment.completedAtMs = Date.now();
    await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
  }

  private async finishTerminalErroredActiveTurn(active: ActiveTurn): Promise<void> {
    if (!this.getActiveTurn(active.scopeId, active.turnId)) {
      return;
    }
    try {
      await this.completeTurn(active);
      await this.cleanupTransientProgressMessages(active);
      await this.finalizeUserInputsForTurn(active, 'resolved');
      this.markQueuedTurnCompleted(active);
    } finally {
      if (active.isObserved) {
        this.clearObservedTurnWatcher(active.turnId, active.scopeId);
      }
      active.resolver();
      this.deleteActiveTurnRecord(active);
      this.updateStatus();
    }
  }

  private async handleUserInputRequest(serverRequestId: string | number, params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    const scopeId = threadId ? this.findChatByThread(threadId) : null;
    if (!threadId || !scopeId) {
      await this.app.respondError(serverRequestId, `No chat binding found for thread ${threadId ?? '(unknown)'}`);
      return;
    }

    const questions = parseUserInputQuestions(params);
    if (questions.length === 0) {
      await this.app.respond(serverRequestId, { answers: {} });
      return;
    }

    const record: PendingUserInputRequest = {
      localId: crypto.randomBytes(8).toString('hex'),
      serverRequestId,
      chatId: scopeId,
      threadId,
      turnId: stringOrNull(params?.turnId),
      itemId: stringOrNull(params?.itemId) ?? stringOrNull(params?.item?.id) ?? '',
      questions,
      answers: new Map(),
      messageId: null,
      status: 'pending',
      createdAt: Date.now(),
      submittedAt: null,
    };
    this.logger.info('codex.user_input_requested', {
      localId: record.localId,
      serverRequestId: stringifyServerRequestId(record.serverRequestId),
      threadId: record.threadId,
      turnId: record.turnId,
      itemId: record.itemId,
      questions: questions.length,
    });
    this.pendingUserInputs.set(record.localId, record);
    this.store.savePendingUserInput(serializePendingUserInput(record));
    const locale = this.localeForChat(scopeId);
    const messageId = await this.sendMessage(
      scopeId,
      renderUserInputMessage(locale, record),
      userInputKeyboard(record),
    );
    record.messageId = messageId;
    this.store.updatePendingUserInputMessage(record.localId, messageId);
  }

  private hasPendingUserInput(scopeId: string): boolean {
    return this.findPendingUserInputForScope(scopeId) !== null;
  }

  private findPendingUserInputForScope(scopeId: string): PendingUserInputRequest | null {
    for (const record of this.pendingUserInputs.values()) {
      if (record.chatId === scopeId && record.status === 'pending') {
        return record;
      }
    }
    return null;
  }

  private async handleUserInputCallback(
    event: TelegramCallbackEvent,
    localId: string,
    questionIndex: number,
    optionIndex: number,
    locale: AppLocale,
  ): Promise<void> {
    const record = this.pendingUserInputs.get(localId);
    if (!record) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'user_input_expired'));
      return;
    }
    if (record.status !== 'pending') {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'user_input_already_submitted'));
      return;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'user_input_mismatch'));
      return;
    }
    const question = record.questions[questionIndex];
    const option = question?.options[optionIndex];
    if (!question || !option) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    record.answers.set(question.id, option.label);
    this.persistPendingUserInputAnswers(record);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'user_input_recorded'));
    await this.refreshOrFinishUserInput(record, locale);
  }

  private async handleUserInputTextReply(event: TelegramTextEvent, locale: AppLocale): Promise<void> {
    const record = this.findPendingUserInputForScope(event.scopeId);
    if (!record) {
      return;
    }
    const answer = event.text.trim();
    if (!answer) {
      await this.sendMessage(event.scopeId, t(locale, 'user_input_empty_answer'));
      return;
    }
    const unanswered = record.questions.filter(question => !record.answers.has(question.id));
    if (unanswered.length !== 1) {
      await this.sendMessage(event.scopeId, t(locale, 'user_input_use_buttons'));
      return;
    }
    record.answers.set(unanswered[0]!.id, answer);
    this.persistPendingUserInputAnswers(record);
    await this.refreshOrFinishUserInput(record, locale);
  }

  private async handleUserInputAnswerCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const localId = args[0]?.trim() ?? '';
    const questionNumber = Number.parseInt(args[1] || '', 10);
    const rawAnswer = args.slice(2).join(' ').trim();
    if (!localId || !Number.isFinite(questionNumber) || questionNumber < 1 || !rawAnswer) {
      await this.sendMessage(scopeId, t(locale, 'usage_answer'));
      return;
    }
    const record = this.pendingUserInputs.get(localId);
    if (!record) {
      await this.sendMessage(scopeId, t(locale, 'user_input_expired'));
      return;
    }
    if (record.status !== 'pending') {
      await this.sendMessage(scopeId, t(locale, 'user_input_already_submitted'));
      return;
    }
    if (record.chatId !== scopeId) {
      await this.sendMessage(scopeId, t(locale, 'user_input_mismatch'));
      return;
    }
    const question = record.questions[questionNumber - 1];
    if (!question) {
      await this.sendMessage(scopeId, t(locale, 'unsupported_action'));
      return;
    }
    let answer = rawAnswer;
    if (question.options.length > 0 && /^(0|[1-9]\d*)$/.test(rawAnswer)) {
      const option = question.options[Number.parseInt(rawAnswer, 10) - 1];
      if (!option) {
        await this.sendMessage(scopeId, t(locale, 'unsupported_action'));
        return;
      }
      answer = option.label;
    }
    record.answers.set(question.id, answer);
    this.persistPendingUserInputAnswers(record);
    await this.sendMessage(scopeId, t(locale, 'user_input_recorded'));
    await this.refreshOrFinishUserInput(record, locale);
  }

  private async refreshOrFinishUserInput(record: PendingUserInputRequest, locale: AppLocale): Promise<void> {
    const completed = record.questions.every(question => record.answers.has(question.id));
    if (completed) {
      await this.submitPendingUserInput(record);
      record.status = 'submitted';
      record.submittedAt = Date.now();
      this.store.markPendingUserInputSubmitted(record.localId);
      this.armSubmittedUserInputTimer(record.localId);
      this.logger.info('codex.user_input_submitted', {
        localId: record.localId,
        serverRequestId: stringifyServerRequestId(record.serverRequestId),
        threadId: record.threadId,
        turnId: record.turnId,
        itemId: record.itemId,
      });
    }

    if (record.messageId === null) {
      return;
    }
    await this.editMessage(
      record.chatId,
      record.messageId,
      renderUserInputMessage(locale, record),
      record.status === 'pending' ? userInputKeyboard(record) : [],
    );
  }

  private async submitPendingUserInput(record: PendingUserInputRequest): Promise<void> {
    await this.app.respond(record.serverRequestId, {
      answers: Object.fromEntries(
        [...record.answers.entries()].map(([id, answer]) => [id, { answers: [answer] }]),
      ),
    });
  }

  private persistPendingUserInputAnswers(record: PendingUserInputRequest): void {
    this.store.updatePendingUserInputAnswers(
      record.localId,
      stringifyPendingUserInputAnswers(record.answers),
      pendingUserInputCurrentQuestionIndex(record),
    );
  }

  private async restorePendingUserInputs(): Promise<void> {
    for (const stored of this.store.listPendingUserInputs()) {
      if (!this.ownsScope(stored.chatId)) {
        continue;
      }
      const record = parseStoredPendingUserInput(stored);
      if (!record) {
        this.store.markPendingUserInputResolved(stored.localId);
        continue;
      }
      let live = false;
      try {
        live = await this.isPendingUserInputTurnLive(record);
      } catch (error) {
        this.logger.warn('codex.user_input_restore_status_failed', {
          localId: record.localId,
          threadId: record.threadId,
          turnId: record.turnId,
          error: toErrorMeta(error),
        });
        continue;
      }
      if (!live) {
        await this.retireStalePendingUserInput(record);
        continue;
      }
      this.pendingUserInputs.set(record.localId, record);
      if (record.status === 'submitted') {
        await this.submitPendingUserInput(record).catch((error) => {
          this.logger.warn('codex.user_input_restore_resubmit_failed', {
            localId: record.localId,
            serverRequestId: stringifyServerRequestId(record.serverRequestId),
            threadId: record.threadId,
            turnId: record.turnId,
            error: toErrorMeta(error),
          });
        });
        this.armSubmittedUserInputTimer(record.localId);
      }
      try {
        await this.restorePendingUserInputMessage(record);
      } catch (error) {
        this.pendingUserInputs.delete(record.localId);
        this.logger.warn('telegram.user_input_restore_failed', {
          localId: record.localId,
          chatId: record.chatId,
          threadId: record.threadId,
          turnId: record.turnId,
          error: toErrorMeta(error),
        });
      }
    }
  }

  private async restorePendingUserInputMessage(record: PendingUserInputRequest): Promise<void> {
    const locale = this.localeForChat(record.chatId);
    if (record.messageId !== null) {
      try {
        await this.editMessage(
          record.chatId,
          record.messageId,
          renderUserInputMessage(locale, record),
          record.status === 'pending' ? userInputKeyboard(record) : [],
        );
        return;
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.user_input_restore_edit_failed', {
            localId: record.localId,
            chatId: record.chatId,
            messageId: record.messageId,
            error: toErrorMeta(error),
          });
        }
      }
    }
    const messageId = await this.sendMessage(
      record.chatId,
      renderUserInputMessage(locale, record),
      record.status === 'pending' ? userInputKeyboard(record) : [],
    );
    record.messageId = messageId;
    this.store.updatePendingUserInputMessage(record.localId, messageId);
  }

  private async retireStalePendingUserInput(record: PendingUserInputRequest): Promise<void> {
    record.status = record.status === 'submitted' ? 'resolved' : 'interrupted';
    if (record.status === 'resolved') {
      this.store.markPendingUserInputResolved(record.localId);
    } else {
      this.store.markPendingUserInputInterrupted(record.localId);
    }
    if (record.messageId === null) {
      return;
    }
    const locale = this.localeForChat(record.chatId);
    await this.editMessage(record.chatId, record.messageId, renderUserInputMessage(locale, record), []).catch((error) => {
      if (!isTelegramMessageGone(error)) {
        this.logger.warn('telegram.user_input_stale_edit_failed', {
          localId: record.localId,
          chatId: record.chatId,
          messageId: record.messageId,
          error: toErrorMeta(error),
        });
      }
    });
  }

  private async isPendingUserInputTurnLive(record: PendingUserInputRequest): Promise<boolean> {
    const snapshot = await this.app.readThreadSnapshot(record.threadId);
    if (!snapshot || snapshot.status !== 'active') {
      return false;
    }
    if (record.status === 'submitted') {
      if (!record.turnId) {
        return snapshot.activeFlags.includes('waitingOnUserInput');
      }
      const turn = snapshot.turns.find((entry) => entry.turnId === record.turnId);
      return turn?.status === 'inProgress' && snapshot.activeFlags.includes('waitingOnUserInput');
    }
    if (!record.turnId) {
      return snapshot.activeFlags.includes('waitingOnUserInput');
    }
    const turn = snapshot.turns.find((entry) => entry.turnId === record.turnId);
    return turn?.status === 'inProgress' && snapshot.activeFlags.includes('waitingOnUserInput');
  }

  private async maybeSendPlanImplementationPrompt(active: ActiveTurn): Promise<boolean> {
    if (active.interruptRequested || this.store.countQueuedTurnInputs(active.scopeId) > 0) {
      return false;
    }
    if (this.hasPendingUserInputForTurn(active.scopeId, active.turnId)) {
      return false;
    }
    if (this.findPendingPlanImplementation(active.scopeId, active.turnId)) {
      return false;
    }
    const planMarkdown = active.collaborationMode === 'plan'
      ? extractLatestPlanMarkdown(active)
      : extractLatestProposedPlanMarkdown(active);
    if (!planMarkdown) {
      return false;
    }

    const binding = this.store.getBinding(active.scopeId);
    const session: GuidedPlanSessionRecord = {
      sessionId: crypto.randomBytes(8).toString('hex'),
      scopeId: active.scopeId,
      chatId: active.chatId,
      chatType: active.chatType,
      topicId: active.topicId,
      threadId: active.threadId,
      turnId: active.turnId,
      cwd: binding?.cwd ?? null,
      planMarkdown,
      messageId: null,
      state: 'awaiting_confirmation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
    };
    this.store.saveGuidedPlanSession(session);
    const record = this.pendingPlanImplementationFromSession(session);
    const locale = this.localeForChat(active.scopeId);
    const messageId = await this.sendMessage(
      active.scopeId,
      renderPlanImplementationPrompt(locale, record),
      planImplementationKeyboard(locale, record.localId),
    );
    this.store.updateGuidedPlanSessionMessage(session.sessionId, messageId);
    return true;
  }

  private findPendingPlanImplementation(scopeId: string, turnId?: string): PendingPlanImplementation | null {
    const session = this.store.findOpenGuidedPlanSession(scopeId, turnId);
    return session ? this.pendingPlanImplementationFromSession(session) : null;
  }

  private clearPlanImplementationPromptsForScope(scopeId: string): void {
    const record = this.store.findOpenGuidedPlanSession(scopeId);
    if (record) {
      this.store.updateGuidedPlanSessionState(record.sessionId, 'cancelled');
    }
  }

  private pendingPlanImplementationFromSession(session: GuidedPlanSessionRecord): PendingPlanImplementation {
    return {
      localId: session.sessionId,
      scopeId: session.scopeId,
      chatId: session.chatId,
      chatType: session.chatType,
      topicId: session.topicId,
      threadId: session.threadId,
      turnId: session.turnId,
      cwd: session.cwd,
      planMarkdown: session.planMarkdown,
      messageId: session.messageId,
      createdAt: session.createdAt,
    };
  }

  private async restoreGuidedPlanSessions(): Promise<void> {
    for (const session of this.store.listOpenGuidedPlanSessions()) {
      if (!this.messaging.canSendToScope(session.scopeId)) {
        continue;
      }
      const locale = this.localeForChat(session.scopeId);
      const record = this.pendingPlanImplementationFromSession(session);
      if (session.messageId !== null) {
        try {
          await this.editMessage(
            session.scopeId,
            session.messageId,
            renderPlanImplementationPrompt(locale, record),
            planImplementationKeyboard(locale, record.localId),
          );
          continue;
        } catch (error) {
          if (!isTelegramMessageGone(error)) {
            this.logger.warn('telegram.plan_impl_restore_edit_failed', {
              sessionId: session.sessionId,
              scopeId: session.scopeId,
              messageId: session.messageId,
              error: toErrorMeta(error),
            });
          }
        }
      }
      const messageId = await this.sendMessage(
        session.scopeId,
        renderPlanImplementationPrompt(locale, record),
        planImplementationKeyboard(locale, record.localId),
      );
      this.store.updateGuidedPlanSessionMessage(session.sessionId, messageId);
    }
  }

  private hasPendingUserInputForTurn(scopeId: string, turnId: string): boolean {
    for (const record of this.pendingUserInputs.values()) {
      if (record.chatId === scopeId && (record.turnId === null || record.turnId === turnId)) {
        return true;
      }
    }
    return false;
  }

  private async finalizeUserInputsForTurn(active: ActiveTurn, terminalStatus: 'resolved' | 'interrupted'): Promise<void> {
    const records = [...this.pendingUserInputs.values()].filter((record) => (
      record.chatId === active.scopeId && (record.turnId === null || record.turnId === active.turnId)
    ));
    for (const record of records) {
      const finalStatus: PendingUserInputStatus = terminalStatus === 'interrupted'
        ? 'interrupted'
        : record.status === 'submitted'
          ? 'resolved'
          : 'interrupted';
      this.clearSubmittedUserInputTimer(record.localId);
      this.pendingUserInputs.delete(record.localId);
      record.status = finalStatus;
      if (finalStatus === 'resolved') {
        this.store.markPendingUserInputResolved(record.localId);
      } else {
        this.store.markPendingUserInputInterrupted(record.localId);
      }
      this.logger.info('codex.user_input_turn_terminal', {
        localId: record.localId,
        serverRequestId: stringifyServerRequestId(record.serverRequestId),
        threadId: record.threadId,
        turnId: record.turnId,
        itemId: record.itemId,
        status: finalStatus,
      });
      if (record.messageId === null) {
        continue;
      }
      const locale = this.localeForChat(record.chatId);
      await this.editMessage(record.chatId, record.messageId, renderUserInputMessage(locale, record), []).catch((error) => {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.user_input_terminal_edit_failed', {
            localId: record.localId,
            chatId: record.chatId,
            messageId: record.messageId,
            error: toErrorMeta(error),
          });
        }
      });
    }
  }

  private async handlePlanImplementationCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: 'run' | 'fresh' | 'stay',
    locale: AppLocale,
  ): Promise<void> {
    const session = this.store.getGuidedPlanSession(localId);
    if (!session || session.state !== 'awaiting_confirmation') {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'plan_impl_expired'));
      return;
    }
    const record = this.pendingPlanImplementationFromSession(session);
    if (record.scopeId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'plan_impl_mismatch'));
      return;
    }
    if (action === 'stay') {
      this.store.updateGuidedPlanSessionState(localId, 'cancelled');
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
      if (record.messageId !== null) {
        await this.editMessage(record.scopeId, record.messageId, t(locale, 'plan_impl_staying'), []);
      }
      return;
    }
    if (this.findActiveTurn(record.scopeId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
      return;
    }

    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    const turn = await this.startPlanImplementationTurn(record, action === 'fresh');
    this.store.updateGuidedPlanSessionState(localId, 'completed');
    if (record.messageId !== null) {
      await this.editMessage(
        record.scopeId,
        record.messageId,
        t(locale, action === 'fresh' ? 'plan_impl_started_fresh' : 'plan_impl_started', {
          threadId: turn.threadId,
          turnId: turn.turnId,
        }),
        [],
      );
    }
  }

  private async handlePlanImplementationTextCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const localId = args[0]?.trim() ?? '';
    const action = normalizePlanImplementationTextAction(args[1] ?? '');
    if (!localId || !action) {
      await this.sendMessage(scopeId, t(locale, 'usage_planimpl'));
      return;
    }
    const session = this.store.getGuidedPlanSession(localId);
    if (!session || session.state !== 'awaiting_confirmation') {
      await this.sendMessage(scopeId, t(locale, 'plan_impl_expired'));
      return;
    }
    const record = this.pendingPlanImplementationFromSession(session);
    if (record.scopeId !== scopeId) {
      await this.sendMessage(scopeId, t(locale, 'plan_impl_mismatch'));
      return;
    }
    if (action === 'stay') {
      this.store.updateGuidedPlanSessionState(localId, 'cancelled');
      if (record.messageId !== null) {
        await this.editMessage(record.scopeId, record.messageId, t(locale, 'plan_impl_staying'), []);
      } else {
        await this.sendMessage(scopeId, t(locale, 'plan_impl_staying'));
      }
      return;
    }
    if (this.findActiveTurn(record.scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'wait_current_turn'));
      return;
    }

    const turn = await this.startPlanImplementationTurn(record, action === 'fresh');
    this.store.updateGuidedPlanSessionState(localId, 'completed');
    const message = t(locale, action === 'fresh' ? 'plan_impl_started_fresh' : 'plan_impl_started', {
      threadId: turn.threadId,
      turnId: turn.turnId,
    });
    if (record.messageId !== null) {
      await this.editMessage(record.scopeId, record.messageId, message, []);
      return;
    }
    await this.sendMessage(scopeId, message);
  }

  private async startPlanImplementationTurn(
    record: PendingPlanImplementation,
    freshContext: boolean,
  ): Promise<{ threadId: string; turnId: string; collaborationMode: CollaborationModeValue }> {
    await this.stopWatchingScopeThread(record.scopeId, freshContext ? undefined : record.threadId);
    const binding = freshContext
      ? await this.createBinding(record.scopeId, record.cwd ?? this.config.defaultCwd)
      : await this.ensureThreadReady(record.scopeId, {
          chatId: record.scopeId,
          threadId: record.threadId,
          cwd: record.cwd,
          updatedAt: Date.now(),
        });
    if (!freshContext) {
      this.store.setBinding(record.scopeId, binding.threadId, binding.cwd);
    }
    await this.sendTyping(record.scopeId);
    const text = freshContext
      ? `${PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n${record.planMarkdown}`
      : PLAN_IMPLEMENTATION_CODING_MESSAGE;
    const input: TurnInput[] = [{
      type: 'text',
      text,
      text_elements: [],
    }];
    const turn = await this.startTurnWithRecovery(record.scopeId, binding, input, {
      collaborationMode: DEFAULT_COLLABORATION_MODE,
    });
    await this.registerActiveTurn(
      record.scopeId,
      record.chatId,
      record.chatType,
      record.topicId,
      turn.threadId,
      turn.turnId,
      0,
      {
        input,
        threadId: turn.threadId,
        cwd: this.store.getBinding(record.scopeId)?.cwd ?? binding.cwd ?? this.config.defaultCwd,
        chatId: record.chatId,
        chatType: record.chatType,
        topicId: record.topicId,
        collaborationMode: DEFAULT_COLLABORATION_MODE,
        failedAuthTargets: new Set(),
      },
      turn.collaborationMode,
    );
    return turn;
  }

  private async handleMcpElicitationRequest(serverRequestId: string | number, params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    const scopeId = threadId ? this.findChatByThread(threadId) : null;
    if (!threadId || !scopeId) {
      await this.app.respondError(serverRequestId, `No chat binding found for thread ${threadId ?? '(unknown)'}`);
      return;
    }
    const mode = params?.mode === 'url' ? 'url' : 'form';
    const record: PendingMcpElicitation = {
      localId: crypto.randomBytes(8).toString('hex'),
      serverRequestId,
      chatId: scopeId,
      threadId,
      turnId: stringOrNull(params?.turnId),
      serverName: String(params?.serverName ?? ''),
      mode,
      message: String(params?.message ?? ''),
      url: mode === 'url' ? stringOrNull(params?.url) : null,
      requestedSchema: mode === 'form' ? params?.requestedSchema ?? null : null,
      content: null,
      messageId: null,
      createdAt: Date.now(),
    };
    this.pendingMcpElicitations.set(record.localId, record);
    const locale = this.localeForChat(scopeId);
    const messageId = await this.sendMessage(
      scopeId,
      renderMcpElicitationMessage(locale, record),
      mcpElicitationKeyboard(locale, record),
    );
    record.messageId = messageId;
  }

  private hasPendingMcpElicitation(scopeId: string): boolean {
    return this.findPendingMcpElicitationForScope(scopeId) !== null;
  }

  private findPendingMcpElicitationForScope(scopeId: string): PendingMcpElicitation | null {
    for (const record of this.pendingMcpElicitations.values()) {
      if (record.chatId === scopeId) {
        return record;
      }
    }
    return null;
  }

  private async handleMcpElicitationTextReply(event: TelegramTextEvent, locale: AppLocale): Promise<void> {
    const record = this.findPendingMcpElicitationForScope(event.scopeId);
    if (!record) {
      return;
    }
    if (record.mode !== 'form') {
      await this.sendMessage(event.scopeId, t(locale, 'mcp_elicitation_use_buttons'));
      return;
    }
    try {
      record.content = JSON.parse(event.text);
    } catch {
      await this.sendMessage(event.scopeId, t(locale, 'mcp_elicitation_invalid_json'));
      return;
    }
    if (record.messageId !== null) {
      await this.editMessage(
        record.chatId,
        record.messageId,
        renderMcpElicitationMessage(locale, record),
        mcpElicitationKeyboard(locale, record),
      );
    }
    await this.sendMessage(event.scopeId, t(locale, 'mcp_elicitation_json_recorded'));
  }

  private async handleMcpElicitationCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: McpElicitationAction,
    locale: AppLocale,
  ): Promise<void> {
    const record = this.pendingMcpElicitations.get(localId);
    if (!record) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'mcp_elicitation_expired'));
      return;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'mcp_elicitation_mismatch'));
      return;
    }
    if (action === 'accept' && record.mode === 'form' && record.content === null) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'mcp_elicitation_json_required'));
      return;
    }
    const response = {
      action,
      content: action === 'accept' ? record.content : null,
      _meta: null,
    };
    await this.app.respond(record.serverRequestId, response);
    this.pendingMcpElicitations.delete(localId);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    if (record.messageId !== null) {
      await this.editMessage(
        record.chatId,
        record.messageId,
        renderMcpElicitationMessage(locale, record, action),
        [],
      );
    }
  }

  private async handleMcpElicitationTextCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const localId = args[0]?.trim() ?? '';
    const action = normalizeMcpElicitationTextAction(args[1] ?? '');
    if (!localId || !action) {
      await this.sendMessage(scopeId, t(locale, 'usage_mcpel'));
      return;
    }
    const record = this.pendingMcpElicitations.get(localId);
    if (!record) {
      await this.sendMessage(scopeId, t(locale, 'mcp_elicitation_expired'));
      return;
    }
    if (record.chatId !== scopeId) {
      await this.sendMessage(scopeId, t(locale, 'mcp_elicitation_mismatch'));
      return;
    }
    if (action === 'accept' && record.mode === 'form' && record.content === null) {
      await this.sendMessage(scopeId, t(locale, 'mcp_elicitation_json_required'));
      return;
    }
    const response = {
      action,
      content: action === 'accept' ? record.content : null,
      _meta: null,
    };
    await this.app.respond(record.serverRequestId, response);
    this.pendingMcpElicitations.delete(localId);
    if (record.messageId !== null) {
      await this.editMessage(
        record.chatId,
        record.messageId,
        renderMcpElicitationMessage(locale, record, action),
        [],
      );
      return;
    }
    await this.sendMessage(scopeId, t(locale, 'decision_recorded'));
  }

  private async createBinding(scopeId: string, requestedCwd: string | null): Promise<ThreadBinding> {
    const cwd = requestedCwd || this.config.defaultCwd;
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    const session = await this.app.startThread({
      cwd,
      approvalPolicy: access.approvalPolicy,
      sandboxMode: access.sandboxMode,
      model: settings?.model ?? null,
    });
    return this.storeThreadSession(scopeId, session, 'seed');
  }

  private async startTurnWithRecovery(
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    input: TurnInput[],
    overrides: {
      collaborationMode?: CollaborationModeValue | null | undefined;
      recoverMissingThread?: boolean | undefined;
    } = {},
  ): Promise<{ threadId: string; turnId: string; collaborationMode: CollaborationModeValue }> {
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    const cwd = binding.cwd ?? this.config.defaultCwd;
    const requestedCollaborationMode = resolveCollaborationMode(
      overrides.collaborationMode === undefined ? settings?.collaborationMode ?? null : overrides.collaborationMode,
    );
    const collaborationMode = await this.buildNativeCollaborationMode(settings, cwd, requestedCollaborationMode);
    const serviceTier = await this.resolveServiceTierForTurn(scopeId, settings);
    try {
      const turn = await this.app.startTurn({
        threadId: binding.threadId,
        input,
        approvalPolicy: access.approvalPolicy,
        sandboxMode: access.sandboxMode,
        cwd,
        model: settings?.model ?? null,
        effort: normalizeRequestedEffort(settings?.reasoningEffort ?? ''),
        serviceTier,
        collaborationMode,
      });
      return { threadId: binding.threadId, turnId: turn.id, collaborationMode: requestedCollaborationMode };
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      if (overrides.recoverMissingThread === false) {
        throw error;
      }
      this.logger.warn('codex.turn_thread_not_found', { scopeId, threadId: binding.threadId });
      const replacement = await this.createBinding(scopeId, binding.cwd ?? this.config.defaultCwd);
      await this.sendMessage(scopeId, t(this.localeForChat(scopeId), 'current_thread_unavailable_continued', { threadId: replacement.threadId }));
      const nextSettings = this.store.getChatSettings(scopeId);
      const nextAccess = this.resolveEffectiveAccess(scopeId, nextSettings);
      const replacementCwd = replacement.cwd ?? this.config.defaultCwd;
      const replacementCollaborationMode = await this.buildNativeCollaborationMode(
        nextSettings,
        replacementCwd,
        requestedCollaborationMode,
      );
      const replacementServiceTier = await this.resolveServiceTierForTurn(scopeId, nextSettings);
      const turn = await this.app.startTurn({
        threadId: replacement.threadId,
        input,
        approvalPolicy: nextAccess.approvalPolicy,
        sandboxMode: nextAccess.sandboxMode,
        cwd: replacementCwd,
        model: nextSettings?.model ?? null,
        effort: normalizeRequestedEffort(nextSettings?.reasoningEffort ?? ''),
        serviceTier: replacementServiceTier,
        collaborationMode: replacementCollaborationMode,
      });
      return { threadId: replacement.threadId, turnId: turn.id, collaborationMode: requestedCollaborationMode };
    }
  }

  private async buildTurnInput(
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    event: TelegramTextEvent,
    locale: AppLocale,
  ): Promise<TurnInput[]> {
    if (event.attachments.length === 0) {
      return [{
        type: 'text',
        text: event.text,
        text_elements: [],
      }];
    }

    const cwd = binding.cwd ?? this.config.defaultCwd;
    const stagedAttachments = await this.stageAttachments(cwd, binding.threadId, event.attachments, locale);
    const prompt = buildAttachmentPrompt(event.text, stagedAttachments);
    const input: TurnInput[] = [{
      type: 'text',
      text: prompt,
      text_elements: [],
    }];
    for (const attachment of stagedAttachments) {
      if (!attachment.nativeImage) continue;
      input.push({
        type: 'localImage',
        path: attachment.localPath,
      });
    }
    return input;
  }

  private buildTurnInputFromStagedAttachments(
    text: string,
    attachments: readonly StagedTelegramAttachment[],
  ): TurnInput[] {
    const input: TurnInput[] = [{
      type: 'text',
      text: buildAttachmentPrompt(text, attachments),
      text_elements: [],
    }];
    for (const attachment of attachments) {
      if (!attachment.nativeImage) continue;
      input.push({
        type: 'localImage',
        path: attachment.localPath,
      });
    }
    return input;
  }

  private async resolveServiceTierForTurn(
    scopeId: string,
    settings: ChatSessionSettings | null,
  ): Promise<string | null | undefined> {
    if (!settings) {
      return undefined;
    }
    if (!settings.serviceTier) {
      return null;
    }
    const models = await this.app.listModels();
    const currentModel = resolveCurrentModel(models, settings.model);
    const nextTier = clampServiceTierToModel(currentModel, settings.serviceTier);
    if (nextTier.adjusted) {
      this.store.setChatServiceTier(scopeId, null);
      await this.sendMessage(
        scopeId,
        t(this.localeForChat(scopeId), 'service_tier_cleared_due_to_model_switch'),
      );
    }
    return nextTier.tier;
  }

  private async stageAttachments(
    cwd: string,
    threadId: string,
    attachments: readonly TelegramInboundAttachment[],
    locale: AppLocale,
  ): Promise<StagedTelegramAttachment[]> {
    const staged: StagedTelegramAttachment[] = [];
    for (const attachment of attachments) {
      try {
        if (attachment.localPath) {
          const planned = planAttachmentStoragePath(
            cwd,
            threadId,
            attachment,
            path.basename(attachment.localPath),
          );
          await fs.mkdir(path.dirname(planned.localPath), { recursive: true });
          await fs.copyFile(attachment.localPath, planned.localPath);
          const stat = await fs.stat(planned.localPath);
          const resolvedSize = stat.size;
          if (resolvedSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES) {
            throw new UserFacingError(t(locale, 'attachment_too_large', {
              name: attachment.fileName ?? attachment.fileUniqueId,
              size: resolvedSize,
            }));
          }
          const resolvedAttachment: TelegramInboundAttachment = {
            ...attachment,
            fileName: planned.fileName,
            fileSize: resolvedSize,
          };
          staged.push({
            ...resolvedAttachment,
            fileName: planned.fileName,
            localPath: planned.localPath,
            relativePath: planned.relativePath,
            nativeImage: isNativeImageAttachment(resolvedAttachment),
          });
          continue;
        }
        const remoteFile = await this.messaging.getFile(attachment.fileId);
        const resolvedSize = attachment.fileSize ?? remoteFile.file_size ?? null;
        if (resolvedSize !== null && resolvedSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES) {
          throw new UserFacingError(t(locale, 'attachment_too_large', {
            name: attachment.fileName ?? attachment.fileUniqueId,
            size: resolvedSize,
          }));
        }
        if (!remoteFile.file_path) {
          throw new Error('Telegram file path is missing');
        }
        const planned = planAttachmentStoragePath(cwd, threadId, attachment, remoteFile.file_path);
        await fs.mkdir(path.dirname(planned.localPath), { recursive: true });
        await this.messaging.downloadResolvedFile(remoteFile.file_path, planned.localPath);
        const resolvedAttachment: TelegramInboundAttachment = {
          ...attachment,
          fileName: planned.fileName,
          fileSize: resolvedSize,
        };
        staged.push({
          ...resolvedAttachment,
          fileName: planned.fileName,
          localPath: planned.localPath,
          relativePath: planned.relativePath,
          nativeImage: isNativeImageAttachment(resolvedAttachment),
        });
      } catch (error) {
        if (error instanceof UserFacingError) {
          throw error;
        }
        throw new Error(t(locale, 'attachment_download_failed', {
          name: attachment.fileName ?? attachment.fileUniqueId,
          error: formatUserError(error),
        }));
      }
    }
    return staged;
  }

  private async handleTelegramAttachmentBatch(
    event: TelegramTextEvent,
    locale: AppLocale,
    text: string,
  ): Promise<void> {
    const active = this.findActiveTurn(event.scopeId);
    if (active?.isObserved) {
      await this.sendMessage(event.scopeId, t(locale, 'watch_read_only_active'));
      return;
    }

    const existingBinding = this.store.getBinding(event.scopeId);
    const binding = active
      ? {
          threadId: active.threadId,
          cwd: existingBinding?.cwd ?? this.config.defaultCwd,
        }
      : existingBinding
        ? await this.ensureThreadReady(event.scopeId, existingBinding)
        : await this.createBinding(event.scopeId, null);
    const cwd = binding.cwd ?? this.config.defaultCwd;
    const stagedAttachments = await this.stageAttachments(cwd, binding.threadId, event.attachments, locale);
    const mediaGroupId = event.mediaGroupId ?? null;
    const now = Date.now();
    const existingBatch = mediaGroupId
      ? this.store.findPendingAttachmentBatchByMediaGroup(event.scopeId, mediaGroupId)
      : findReusableStandaloneAttachmentBatch(this.store.getLatestPendingAttachmentBatch(event.scopeId), now);
    const existingAttachments = existingBatch ? parseStagedTelegramAttachments(existingBatch.attachmentsJson) : [];
    const record: PendingAttachmentBatchRecord = {
      batchId: existingBatch?.batchId ?? crypto.randomBytes(8).toString('hex'),
      scopeId: event.scopeId,
      chatId: event.chatId,
      chatType: event.chatType,
      topicId: event.topicId,
      threadId: binding.threadId,
      cwd,
      mediaGroupId,
      attachmentsJson: JSON.stringify([...existingAttachments, ...stagedAttachments]),
      caption: mergeAttachmentBatchCaption(existingBatch?.caption ?? '', text.trim()),
      messageId: existingBatch?.messageId ?? null,
      status: 'pending',
      createdAt: existingBatch?.createdAt ?? now,
      updatedAt: now,
      resolvedAt: null,
    };
    this.store.savePendingAttachmentBatch(record);
    await this.renderAttachmentBatchCard(record, locale);
  }

  private async consumePendingAttachmentBatchWithText(
    event: TelegramTextEvent,
    locale: AppLocale,
    text: string,
  ): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt) {
      return false;
    }
    const batch = this.store.getLatestPendingAttachmentBatch(event.scopeId);
    if (!batch) {
      return false;
    }
    await this.consumePendingAttachmentBatch(batch, locale, prompt, event.messageId);
    return true;
  }

  private async handleAttachmentBatchCallback(
    event: TelegramCallbackEvent,
    batchId: string,
    action: 'analyze' | 'clear',
    locale: AppLocale,
  ): Promise<void> {
    const batch = this.store.getPendingAttachmentBatch(batchId);
    if (!batch || batch.status !== 'pending') {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'attachment_batch_missing'));
      return;
    }
    if (batch.scopeId !== event.scopeId || (batch.messageId !== null && batch.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'attachment_batch_mismatch'));
      return;
    }
    if (action === 'clear') {
      this.store.resolvePendingAttachmentBatch(batch.batchId, 'cleared');
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
      if (batch.messageId !== null) {
        await this.editMessage(batch.scopeId, batch.messageId, t(locale, 'attachment_batch_cleared'), []);
      }
      return;
    }
    const prompt = batch.caption.trim() || t(locale, 'attachment_batch_default_prompt');
    await this.consumePendingAttachmentBatch(batch, locale, prompt, batch.messageId);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
  }

  private async consumePendingAttachmentBatch(
    batch: PendingAttachmentBatchRecord,
    locale: AppLocale,
    prompt: string,
    sourceMessageId: number | null,
  ): Promise<void> {
    const active = this.findActiveTurn(batch.scopeId);
    if (active?.isObserved) {
      await this.sendMessage(batch.scopeId, t(locale, 'watch_read_only_active'));
      return;
    }
    const attachments = parseStagedTelegramAttachments(batch.attachmentsJson);
    const input = this.buildTurnInputFromStagedAttachments(prompt, attachments);
    if (active) {
      const queueId = this.enqueuePreparedTurnInput({
        scopeId: batch.scopeId,
        chatId: batch.chatId,
        chatType: batch.chatType,
        topicId: batch.topicId,
        threadId: active.threadId,
        input,
        sourceSummary: summarizeStagedAttachmentInput(prompt, attachments),
        messageId: sourceMessageId,
      });
      this.store.resolvePendingAttachmentBatch(batch.batchId, 'consumed');
      if (batch.messageId !== null) {
        await this.editMessage(batch.scopeId, batch.messageId, t(locale, 'attachment_batch_queued', {
          id: shortId(queueId),
          position: this.store.countQueuedTurnInputs(batch.scopeId),
        }), []);
      } else {
        await this.sendMessage(batch.scopeId, t(locale, 'attachment_batch_queued', {
          id: shortId(queueId),
          position: this.store.countQueuedTurnInputs(batch.scopeId),
        }));
      }
      return;
    }

    this.store.resolvePendingAttachmentBatch(batch.batchId, 'consumed');
    if (batch.messageId !== null) {
      await this.editMessage(batch.scopeId, batch.messageId, t(locale, 'attachment_batch_consumed'), []);
    }
    await this.startTurnFromPreparedAttachmentBatch(batch, input);
  }

  private async startTurnFromPreparedAttachmentBatch(
    batch: PendingAttachmentBatchRecord,
    input: TurnInput[],
  ): Promise<void> {
    this.clearPlanImplementationPromptsForScope(batch.scopeId);
    await this.stopWatchingScopeThread(batch.scopeId);
    const existingBinding = this.store.getBinding(batch.scopeId);
    const binding = await this.ensureThreadReady(batch.scopeId, {
      chatId: batch.scopeId,
      threadId: batch.threadId,
      cwd: existingBinding?.cwd ?? batch.cwd,
      updatedAt: Date.now(),
    });
    this.store.setBinding(batch.scopeId, binding.threadId, binding.cwd);
    await this.sendTyping(batch.scopeId);
    const turnState = await this.startTurnWithRecovery(batch.scopeId, binding, input);
    if (turnState.collaborationMode === 'plan') {
      this.store.setChatCollaborationMode(batch.scopeId, DEFAULT_COLLABORATION_MODE);
    }
    await this.registerActiveTurn(
      batch.scopeId,
      batch.chatId,
      batch.chatType,
      batch.topicId,
      turnState.threadId,
      turnState.turnId,
      0,
      {
        input,
        threadId: turnState.threadId,
        cwd: this.store.getBinding(batch.scopeId)?.cwd ?? binding.cwd ?? this.config.defaultCwd,
        chatId: batch.chatId,
        chatType: batch.chatType,
        topicId: batch.topicId,
        collaborationMode: turnState.collaborationMode,
        failedAuthTargets: new Set(),
      },
      turnState.collaborationMode,
    );
  }

  private async renderAttachmentBatchCard(record: PendingAttachmentBatchRecord, locale: AppLocale): Promise<void> {
    const text = renderAttachmentBatchMessage(locale, record);
    const keyboard = attachmentBatchKeyboard(locale, record.batchId);
    if (record.messageId !== null) {
      try {
        await this.editMessage(record.scopeId, record.messageId, text, keyboard);
        return;
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.attachment_batch_edit_failed', {
            batchId: record.batchId,
            scopeId: record.scopeId,
            messageId: record.messageId,
            error: toErrorMeta(error),
          });
        }
      }
    }
    const messageId = await this.sendMessage(record.scopeId, text, keyboard);
    this.store.updatePendingAttachmentBatchMessage(record.batchId, messageId);
  }

  private async registerActiveTurn(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    threadId: string,
    turnId: string,
    previewMessageId: number,
    authRetry: AuthRetryContext | null = null,
    collaborationMode: CollaborationModeValue = DEFAULT_COLLABORATION_MODE,
    queuedInputId: string | null = null,
    archivedMessageIds: number[] = [],
  ): Promise<void> {
    const active = this.createActiveTurnState(
      scopeId,
      chatId,
      chatType,
      topicId,
      threadId,
      turnId,
      previewMessageId,
      false,
      collaborationMode,
      queuedInputId,
    );
    active.archivedMessageIds = [...archivedMessageIds];
    active.authRetry = authRetry;
    this.setActiveTurn(scopeId, turnId, active);
    const pendingError = this.pendingTurnErrors.get(turnId);
    if (pendingError) {
      this.pendingTurnErrors.delete(turnId);
      await this.recordActiveTurnError(active, pendingError);
    }
    if (previewMessageId > 0) {
      this.store.saveActiveTurnPreview({
        turnId,
        scopeId,
        threadId,
        messageId: previewMessageId,
        isObserved: active.isObserved,
        archivedMessageIds: active.archivedMessageIds,
      });
    }
    this.updateStatus();
    try {
      await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    } catch (error) {
      this.logger.warn('telegram.preview_keyboard_attach_failed', { error: String(error), turnId });
    }
  }

  private createActiveTurnState(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    threadId: string,
    turnId: string,
    previewMessageId: number,
    isObserved = false,
    collaborationMode: CollaborationModeValue = DEFAULT_COLLABORATION_MODE,
    queuedInputId: string | null = null,
  ): ActiveTurn {
    let resolver: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    return {
      scopeId,
      chatId,
      chatType,
      topicId,
      renderRoute: resolveTelegramRenderRoute(chatType, topicId),
      isObserved,
      threadId,
      turnId,
      queuedInputId,
      previewMessageId,
      previewActive: previewMessageId > 0,
      draftId: null,
      draftText: null,
      richDraftDisabled: false,
      buffer: '',
      finalText: null,
      interruptRequested: false,
      authRetry: null,
      collaborationMode,
      statusMessageText: null,
      statusNeedsRebase: false,
      segments: [],
      reasoningActiveCount: 0,
      pendingApprovalKinds: new Set(),
      toolBatch: null,
      pendingArchivedStatus: null,
      renderRetryTimer: null,
      lastStreamFlushAt: 0,
      renderRequested: false,
      forceStatusFlush: false,
      forceStreamFlush: false,
      renderTask: null,
      completion,
      archivedMessageIds: [],
      resolver,
    };
  }

  async getCurrentAuthLabel(): Promise<string | null> {
    return (await this.listCodexAuthState()).currentLabel;
  }

  async handleExternalCodexAuthCandidateDeleted(candidateName: string, reason: string | null = null): Promise<void> {
    this.store.deleteCodexAuthCandidate(candidateName);
    if (isInvalidCodexAuthDeleteReason(reason)) {
      this.store.recordCodexAuthCandidateInvalidDelete(candidateName, reason);
    } else {
      this.store.recordCodexAuthCandidateRemoved(candidateName, reason);
    }
    this.authRotationFailedTargets.delete(path.join(this.resolveAuthDir(), candidateName));
    this.pendingTurnErrors.clear();
    this.attachedThreads.clear();
    await this.app.restart();
  }

  async validateExternalCodexAuthCandidate(
    candidateName: string,
    rawAuth: string,
    expectedAccountId: string,
  ): Promise<{ ok: boolean; reason?: string | null }> {
    if (this.externalAuthValidationInProgress) {
      return { ok: false, reason: 'runtime is not idle' };
    }
    if (!this.isIdleForServiceUpdate()) {
      return { ok: false, reason: 'runtime is not idle' };
    }
    this.externalAuthValidationInProgress = true;
    try {
      const metadata = parseChatGptAuthMetadata(rawAuth);
      if (!metadata || metadata.accountId !== expectedAccountId) {
        return { ok: false, reason: 'remote auth account id mismatch' };
      }
      const state = await this.listCodexAuthState();
      const existing = state.candidates.find(candidate => candidate.name === candidateName) ?? null;
      if (existing) {
        const existingMetadata = await readChatGptAuthMetadata(existing.path);
        if (existingMetadata && existingMetadata.accountId !== expectedAccountId) {
          return { ok: false, reason: 'same candidate belongs to a different account' };
        }
      }
      const authStat = await fs.lstat(state.authPath).catch(() => null);
      const originalRegularAuth = authStat?.isFile()
        ? await fs.readFile(state.authPath, 'utf8').catch(() => null)
        : null;
      const tempPath = path.join(state.authDir, `.auth-sync-validate-${process.pid}-${Date.now()}.json`);
      try {
        await fs.writeFile(tempPath, rawAuth, { encoding: 'utf8', mode: 0o600 });
        await pointCodexAuthAtTarget(state.authDir, state.authPath, tempPath);
        this.pendingTurnErrors.clear();
        this.attachedThreads.clear();
        await this.app.restart();
        const account = await this.app.readAccount(false);
        const rateLimits = await this.app.readAccountRateLimits();
        if (!account || !rateLimits || !selectCodexRateLimitSnapshot(rateLimits)) {
          return { ok: false, reason: 'Codex did not validate ChatGPT usage for remote auth' };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: formatUserError(error) };
      } finally {
        await restoreCodexAuthTarget(state.authDir, state.authPath, state.currentTargetPath, originalRegularAuth).catch((error) => {
          this.logger.warn('codex.auth_sync_restore_failed', { error: toErrorMeta(error) });
        });
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        this.pendingTurnErrors.clear();
        this.attachedThreads.clear();
        await this.app.restart().catch((error) => {
          this.logger.warn('codex.auth_sync_restart_restore_failed', { error: toErrorMeta(error) });
        });
      }
    } finally {
      this.externalAuthValidationInProgress = false;
    }
  }

  isIdleForServiceUpdate(): boolean {
    return !this.executionHost?.hasExecutingTasks() && this.activeTurns.size === 0
      && this.pendingApprovalMessages.size === 0
      && this.pendingUserInputs.size === 0
      && this.pendingMcpElicitations.size === 0
      && this.pendingLoginsByScope.size === 0
      && !this.authRotationInProgress
      && !this.authRefreshAllInProgress
      && !this.externalAuthValidationInProgress
      && this.turnStartInProgress === 0;
  }

  private hasLocalBlockingActivity(): boolean {
    return !this.isIdleForServiceUpdate();
  }

  private authRuntimeId(): string {
    return this.config.tgScopeBotId ?? 'default';
  }

  private authDisplayBotLabel(): string | null {
    if (!this.config.tgScopeBotId) return null;
    return this.botUsername ? `@${this.botUsername} (${this.config.tgScopeBotId})` : this.config.tgScopeBotId;
  }

  private ownsScope(scopeId: string): boolean {
    if (this.executionHost) return this.executionHost.ownsScope(scopeId);
    if (scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      return this.messaging.hasWeixinTransport;
    }
    if (!this.ownsTelegramRuntime) {
      return false;
    }
    if (!this.config.tgScopeBotId) {
      return parseTelegramTargetFromBridgeScope(scopeId).botId === null;
    }
    try {
      return parseTelegramTargetFromBridgeScope(scopeId).botId === this.config.tgScopeBotId;
    } catch {
      return false;
    }
  }

  private setActiveTurn(scopeId: string, turnId: string, active: ActiveTurn): void {
    const key = activeTurnKey(scopeId, turnId);
    this.activeTurns.set(key, active);
    let keys = this.activeTurnsByTurnId.get(turnId);
    if (!keys) {
      keys = new Set<string>();
      this.activeTurnsByTurnId.set(turnId, keys);
    }
    keys.add(key);
  }

  private getActiveTurn(scopeId: string, turnId: string): ActiveTurn | null {
    return this.activeTurns.get(activeTurnKey(scopeId, turnId)) ?? null;
  }

  private getActiveTurnsForTurn(turnId: string): ActiveTurn[] {
    const keys = this.activeTurnsByTurnId.get(turnId);
    if (!keys) {
      return [];
    }
    const active: ActiveTurn[] = [];
    for (const key of keys) {
      const parsed = parseActiveTurnKey(key);
      if (!parsed || parsed.turnId !== turnId) {
        continue;
      }
      const turn = this.activeTurns.get(key);
      if (turn) {
        active.push(turn);
      }
    }
    return active;
  }

  private getPrimaryActiveTurnForTurn(turnId: string): ActiveTurn | null {
    const active = this.getActiveTurnsForTurn(turnId);
    return active.find(turn => !turn.isObserved) ?? active[0] ?? null;
  }

  private hasAnyActiveTurnForTurn(turnId: string): boolean {
    return this.getActiveTurnsForTurn(turnId).length > 0;
  }

  private deleteActiveTurn(scopeId: string, turnId: string): ActiveTurn | null {
    const key = activeTurnKey(scopeId, turnId);
    const active = this.activeTurns.get(key) ?? null;
    if (!active) {
      return null;
    }
    this.activeTurns.delete(key);
    const keys = this.activeTurnsByTurnId.get(turnId);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) {
        this.activeTurnsByTurnId.delete(turnId);
      }
    }
    return active;
  }

  private deleteActiveTurnRecord(active: ActiveTurn): void {
    this.deleteActiveTurn(active.scopeId, active.turnId);
  }

  private async completeTurn(active: ActiveTurn): Promise<void> {
    const locale = this.localeForChat(active.scopeId);
    let shouldMarkPartialOutput = false;
    try {
      await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
      await this.collapseTurnCommentary(active);
      const renderedMessages = active.segments.reduce((count, segment) => count + segment.messages.length, 0);
      if (renderedMessages === 0) {
        const fallbackKey = active.interruptRequested ? 'interrupted' : 'completed';
        const finalChunks = chunkTelegramMessage(active.finalText || active.buffer, undefined, t(locale, fallbackKey));
        for (const chunk of finalChunks) {
          await this.sendRichMarkdownMessage(active.scopeId, chunk);
        }
      }
      shouldMarkPartialOutput = active.interruptRequested
        && (renderedMessages > 0 || Boolean((active.finalText || active.buffer).trim()));
    } finally {
      this.clearRenderRetry(active);
      await this.cleanupFinishedPreview(active, locale);
    }
    if (shouldMarkPartialOutput) {
      await this.sendMessage(active.scopeId, t(locale, 'interrupted_partial_output'));
    }
  }

  private async handleTurnActivityEvent(activity: TurnActivityEvent, scopeId?: string): Promise<void> {
    const activeTurns = scopeId
      ? [this.getActiveTurn(scopeId, activity.turnId)].filter((active): active is ActiveTurn => active !== null)
      : this.getActiveTurnsForTurn(activity.turnId);
    for (const active of activeTurns) {
      await this.handleTurnActivityForActive(active, activity);
    }
  }

  private async handleTurnActivityForActive(active: ActiveTurn, activity: TurnActivityEvent): Promise<void> {
    switch (activity.kind) {
      case 'user_message': {
        await this.sendObservedCliUserMessage(active.scopeId, activity.text);
        return;
      }
      case 'agent_message_started': {
        this.promoteReadyToolBatch(active);
        ensureTurnSegment(active, activity.itemId, activity.phase, activity.outputKind, Boolean(activity.isPlan));
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'agent_message_delta': {
        const segment = ensureTurnSegment(active, activity.itemId, undefined, activity.outputKind, Boolean(activity.isPlan));
        segment.text += activity.delta;
        active.buffer += activity.delta;
        await this.queueTurnRender(active);
        return;
      }
      case 'agent_message_completed': {
        const segment = ensureTurnSegment(active, activity.itemId, activity.phase, activity.outputKind, Boolean(activity.isPlan));
        if (activity.text !== null) {
          segment.text = activity.text || segment.text;
          if (activity.outputKind === 'final_answer') {
            active.finalText = activity.text || active.buffer || t(this.localeForChat(active.scopeId), 'completed');
          }
        }
        segment.completed = true;
        segment.completedAtMs = Date.now();
        await this.queueTurnRender(active, { forceStream: true, forceStatus: true });
        return;
      }
      case 'reasoning_started': {
        this.promoteReadyToolBatch(active);
        active.reasoningActiveCount += 1;
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'reasoning_completed': {
        active.reasoningActiveCount = Math.max(0, active.reasoningActiveCount - 1);
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'tool_started': {
        this.noteToolCommandStart(active, activity.exec);
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'tool_completed': {
        this.noteToolCommandEnd(active, activity.exec);
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'turn_completed': {
        const scopeId = active.scopeId;
        if (activity.state === 'interrupted') {
          active.interruptRequested = true;
        }
        try {
          this.promoteReadyToolBatch(active);
          await this.completeTurn(active);
          await this.cleanupTransientProgressMessages(active);
          await this.finalizeUserInputsForTurn(active, active.interruptRequested ? 'interrupted' : 'resolved');
          await this.maybeSendPlanImplementationPrompt(active);
          this.markQueuedTurnCompleted(active);
          if (this.config.codexAppSyncOnTurnComplete) {
            const revealError = await this.tryRevealThread(active.scopeId, active.threadId, 'turn-complete');
            if (revealError) {
              this.logger.warn('codex.reveal_thread_failed', {
                scopeId: active.scopeId,
                threadId: active.threadId,
                reason: 'turn-complete',
                error: revealError,
              });
            }
          }
        } finally {
          if (active.isObserved) {
            this.clearObservedTurnWatcher(active.turnId, active.scopeId);
          }
          active.resolver();
          this.deleteActiveTurnRecord(active);
          this.updateStatus();
          const retriedAfterAuthRotation = await this.maybeRunPendingAuthRotation();
          if (!retriedAfterAuthRotation && active.authRetry) {
            this.authRotationFailedTargets.clear();
          }
          await this.withLock(scopeId, async () => this.startQueuedPromptIfPresent(scopeId));
        }
        return;
      }
    }
  }

  private createApprovalRecord(kind: PendingApprovalRecord['kind'], serverRequestId: string | number, params: any): PendingApprovalRecord {
    const threadId = String(params.threadId);
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      throw new Error(`No chat binding found for thread ${threadId}`);
    }
    const record: PendingApprovalRecord = {
      localId: crypto.randomBytes(8).toString('hex'),
      serverRequestId: String(serverRequestId),
      kind,
      chatId: scopeId,
      threadId,
      turnId: String(params.turnId),
      itemId: String(params.itemId),
      approvalId: params.approvalId ? String(params.approvalId) : null,
      reason: params.reason ? String(params.reason) : null,
      command: params.command ? String(params.command) : null,
      cwd: params.cwd ? String(params.cwd) : null,
      payloadJson: null,
      messageId: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.store.savePendingApproval(record);
    return record;
  }

  private createPermissionApprovalRecord(serverRequestId: string | number, params: any): PendingApprovalRecord {
    const threadId = String(params.threadId);
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      throw new Error(`No chat binding found for thread ${threadId}`);
    }
    const record: PendingApprovalRecord = {
      localId: crypto.randomBytes(8).toString('hex'),
      serverRequestId: String(serverRequestId),
      kind: 'permissions',
      chatId: scopeId,
      threadId,
      turnId: String(params.turnId ?? ''),
      itemId: String(params.itemId ?? ''),
      approvalId: null,
      reason: params.reason ? String(params.reason) : null,
      command: null,
      cwd: params.cwd ? String(params.cwd) : null,
      payloadJson: JSON.stringify({
        permissions: params.permissions ?? {},
        startedAtMs: params.startedAtMs ?? null,
      }),
      messageId: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.store.savePendingApproval(record);
    return record;
  }

  private findChatByThread(threadId: string): string | null {
    const active = this.findActiveTurnByThreadId(threadId);
    if (active && this.messaging.canSendToScope(active.scopeId)) return active.scopeId;
    return this.findAllChatsByThread(threadId)[0] ?? null;
  }

  private findAllChatsByThread(threadId: string): string[] {
    const scopes = new Set<string>();
    for (const turn of this.activeTurns.values()) {
      if (turn.threadId === threadId && this.messaging.canSendToScope(turn.scopeId)) {
        scopes.add(turn.scopeId);
      }
    }
    for (const scopeId of this.store.findAllChatIdsByThreadId(threadId)) {
      if (!this.ownsScope(scopeId) || !this.messaging.canSendToScope(scopeId)) {
        continue;
      }
      scopes.add(scopeId);
    }
    for (const watcher of this.observedThreadWatchers.values()) {
      if (!watcher.stopped && watcher.threadId === threadId && this.messaging.canSendToScope(watcher.scopeId)) {
        scopes.add(watcher.scopeId);
      }
    }
    return [...scopes];
  }

  private scopeCanApproveThread(scopeId: string, threadId: string): boolean {
    if (this.findActiveTurn(scopeId)?.threadId === threadId) {
      return true;
    }
    if (this.store.getBinding(scopeId)?.threadId === threadId) {
      return true;
    }
    const watcher = this.observedThreadWatchers.get(scopeId);
    return Boolean(watcher && !watcher.stopped && watcher.threadId === threadId);
  }

  private withLock(scopeId: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(scopeId) || Promise.resolve();
    const next = previous.then(fn, fn).finally(() => {
      if (this.locks.get(scopeId) === next) {
        this.locks.delete(scopeId);
      }
    });
    this.locks.set(scopeId, next);
    return next;
  }

  private updateStatus(): void {
    const status = this.getRuntimeStatus();
    if (this.coordinator?.statusUpdated) {
      this.coordinator.statusUpdated(status);
      return;
    }
    if (this.config.statusPath) {
      writeRuntimeStatus(this.config.statusPath, status);
    }
  }

  private async sendMessage(
    scopeId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    return this.sendRichMarkdownMessage(scopeId, text, inlineKeyboard);
  }

  private async sendHtmlMessage(
    scopeId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    return this.messaging.sendHtml(scopeId, text, inlineKeyboard);
  }

  private async sendRichHtmlMessage(
    scopeId: string,
    html: string,
    fallbackHtml: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    try {
      return await this.messaging.sendRichHtml(scopeId, html, fallbackHtml, inlineKeyboard);
    } catch (error) {
      this.logger.warn('telegram.rich_message_send_failed', { scopeId, error: toErrorMeta(error) });
      return this.sendHtmlMessage(scopeId, fallbackHtml, inlineKeyboard);
    }
  }

  private async sendRichMarkdownMessage(
    scopeId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    try {
      return await this.messaging.sendRichMarkdown(scopeId, text, text, inlineKeyboard);
    } catch (markdownError) {
      this.logger.warn('telegram.rich_markdown_send_failed', { scopeId, error: toErrorMeta(markdownError) });
      return this.sendRichHtmlMessage(
        scopeId,
        renderTelegramMarkdownRichHtml(text),
        escapeTelegramHtml(text),
        inlineKeyboard,
      );
    }
  }

  private async sendRichInternalMessage(
    scopeId: string,
    title: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    if (scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      return this.sendMessage(scopeId, text, inlineKeyboard);
    }
    return this.sendRichHtmlMessage(
      scopeId,
      formatRichInternalMessage(title, text),
      escapeTelegramHtml(text),
      inlineKeyboard,
    );
  }

  private async editMessage(
    scopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    await this.messaging.editPlain(scopeId, messageId, text, inlineKeyboard);
  }

  private async editHtmlMessage(
    scopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    await this.messaging.editHtml(scopeId, messageId, text, inlineKeyboard);
  }

  private async editRichHtmlMessage(
    scopeId: string,
    messageId: number,
    html: string,
    fallbackHtml: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    try {
      await this.messaging.editRichHtml(scopeId, messageId, html, fallbackHtml, inlineKeyboard);
    } catch (error) {
      this.logger.warn('telegram.rich_message_edit_failed', { scopeId, messageId, error: toErrorMeta(error) });
      await this.editHtmlMessage(scopeId, messageId, fallbackHtml, inlineKeyboard);
    }
  }

  private async editRichInternalMessage(
    scopeId: string,
    messageId: number,
    title: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    if (scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      await this.editMessage(scopeId, messageId, text, inlineKeyboard);
      return;
    }
    await this.editRichHtmlMessage(
      scopeId,
      messageId,
      formatRichInternalMessage(title, text),
      escapeTelegramHtml(text),
      inlineKeyboard,
    );
  }

  private async editAuthPanelMessage(
    scopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    await this.editRichInternalMessage(scopeId, messageId, '/auth', text, inlineKeyboard);
    this.scheduleStalePanelDeletion(scopeId, messageId);
  }

  private scheduleStalePanelDeletion(scopeId: string, messageId: number): void {
    if (this.stopping || this.config.telegramPanelTtlMs <= 0 || parseWeixinBridgeScope(scopeId)) {
      return;
    }
    const key = `${scopeId}:${messageId}`;
    const existing = this.stalePanelDeleteTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.stalePanelDeleteTimers.delete(key);
      this.trackControlOperation(this.deleteMessage(scopeId, messageId).catch(error => {
        this.logger.warn('telegram.stale_panel_delete_failed', { scopeId, messageId, error: toErrorMeta(error) });
      }));
    }, this.config.telegramPanelTtlMs);
    timer.unref();
    this.stalePanelDeleteTimers.set(key, timer);
  }

  private pauseStalePanelDeletion(scopeId: string, messageId: number): void {
    const key = `${scopeId}:${messageId}`;
    const timer = this.stalePanelDeleteTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.stalePanelDeleteTimers.delete(key);
  }

  private async deleteMessage(scopeId: string, messageId: number): Promise<void> {
    await this.messaging.deleteMessage(scopeId, messageId);
  }

  private async sendTyping(scopeId: string): Promise<void> {
    await this.messaging.sendTypingInScope(scopeId);
  }

  private async sendObservedCliUserMessage(scopeId: string, text: string): Promise<void> {
    const chunks = chunkTelegramMessage(text, TELEGRAM_MESSAGE_LIMIT - 64, '');
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const body = index === 0
        ? `${telegramBold(OBSERVED_CLI_USER_LABEL)}\n${telegramPre(chunk)}`
        : telegramPre(chunk);
      await this.sendHtmlMessage(scopeId, body);
    }
  }

  private async collapseTurnCommentary(active: ActiveTurn): Promise<void> {
    if (active.scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX) || !this.hasObservedPersistentReply(active)) {
      return;
    }
    const segments = active.segments.filter(segment => (
      segment.outputKind === 'commentary' && Boolean(segment.text.trim()) && segment.messages.length > 0
    ));
    const messages = segments.flatMap(segment => segment.messages);
    const firstMessage = messages[0];
    if (!firstMessage) {
      return;
    }

    const locale = this.localeForChat(active.scopeId);
    const html = renderCollapsedCommentary(locale, segments);
    const fallback = locale === 'zh'
      ? `过程汇报（${segments.length} 条，已折叠）`
      : `Progress updates (${segments.length}, collapsed)`;
    try {
      await this.messaging.editRichHtml(active.scopeId, firstMessage.messageId, html, fallback, []);
    } catch (error) {
      this.logger.warn('telegram.commentary_collapse_failed', {
        error: String(error),
        turnId: active.turnId,
        messageId: firstMessage.messageId,
      });
      return;
    }

    for (const message of messages.slice(1)) {
      try {
        await this.deleteMessage(active.scopeId, message.messageId);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.commentary_collapse_delete_failed', {
            error: String(error),
            turnId: active.turnId,
            messageId: message.messageId,
          });
        }
      }
    }
    for (const segment of segments) {
      segment.messages = [];
    }
  }

  private async cleanupTransientProgressMessages(active: ActiveTurn): Promise<void> {
    if (!this.hasObservedPersistentReply(active)) {
      return;
    }

    const messageIds = new Set<number>();
    if (active.isObserved) {
      for (const segment of active.segments) {
        if (segment.outputKind === 'final_answer') {
          continue;
        }
        for (const message of segment.messages) {
          messageIds.add(message.messageId);
        }
      }
    }
    if (this.config.telegramDeleteToolDetailsAfterFinal) {
      for (const messageId of active.archivedMessageIds) {
        messageIds.add(messageId);
      }
    }

    for (const messageId of messageIds) {
      try {
        await this.deleteMessage(active.scopeId, messageId);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.transient_progress_cleanup_delete_failed', {
            error: String(error),
            turnId: active.turnId,
            messageId,
          });
        }
      }
    }
  }

  private hasObservedPersistentReply(active: ActiveTurn): boolean {
    if (active.interruptRequested) {
      return true;
    }
    if ((active.finalText || '').trim()) {
      return true;
    }
    return active.segments.some((segment) => (
      segment.outputKind === 'final_answer' && ((segment.text || '').trim().length > 0 || segment.messages.length > 0)
    ));
  }

  private async ensureThreadReady(
    scopeId: string,
    binding: ThreadBinding,
    options: { recoverMissingThread?: boolean | undefined } = {},
  ): Promise<ThreadBinding> {
    const attachmentKey = attachedThreadKey(scopeId, binding.threadId);
    if (this.attachedThreads.has(attachmentKey)) {
      return binding;
    }
    try {
      const session = await this.resumeThreadForScope(scopeId, binding);
      return this.storeThreadSession(scopeId, session, 'seed');
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      if (options.recoverMissingThread === false) {
        throw error;
      }
      this.logger.warn('codex.thread_binding_stale', { scopeId, threadId: binding.threadId });
      const replacement = await this.createBinding(scopeId, binding.cwd ?? this.config.defaultCwd);
      await this.sendMessage(scopeId, t(this.localeForChat(scopeId), 'previous_thread_unavailable_started', { threadId: replacement.threadId }));
      return {
        chatId: scopeId,
        threadId: replacement.threadId,
        cwd: replacement.cwd,
        updatedAt: Date.now(),
      };
    }
  }

  private async handleAsyncError(source: string, error: unknown, scopeId?: string): Promise<void> {
    this.lastError = formatUserError(error);
    this.logger.error(`${source}.failed`, { error: toErrorMeta(error), scopeId: scopeId ?? null });
    this.updateStatus();
    if (!scopeId) return;
    try {
      const locale = this.localeForChat(scopeId);
      const hint = isThreadActiveWriterError(error) ? `\n${t(locale, 'force_takeover_hint')}` : '';
      await this.sendMessage(scopeId, t(locale, 'bridge_error', { error: formatUserError(error) }) + hint);
    } catch (notifyError) {
      this.logger.error('telegram.error_notification_failed', { error: toErrorMeta(notifyError), scopeId });
    }
  }

  private armApprovalTimer(localId: string): void {
    if (this.stopping) return;
    this.clearApprovalTimer(localId);
    const timer = setTimeout(() => {
      this.trackControlOperation(this.expireApproval(localId));
    }, 5 * 60 * 1000);
    this.approvalTimers.set(localId, timer);
  }

  private clearApprovalTimer(localId: string): void {
    const timer = this.approvalTimers.get(localId);
    if (!timer) return;
    clearTimeout(timer);
    this.approvalTimers.delete(localId);
  }

  private armSubmittedUserInputTimer(localId: string): void {
    if (this.stopping) return;
    this.clearSubmittedUserInputTimer(localId);
    const timer = setTimeout(() => {
      this.trackControlOperation(this.notifySubmittedUserInputStillWaiting(localId).catch((error) => {
        this.logger.warn('telegram.user_input_waiting_notice_failed', {
          localId,
          error: toErrorMeta(error),
        });
      }));
    }, USER_INPUT_SUBMITTED_NOTICE_MS);
    timer.unref?.();
    this.submittedUserInputTimers.set(localId, timer);
  }

  private clearSubmittedUserInputTimer(localId: string): void {
    const timer = this.submittedUserInputTimers.get(localId);
    if (!timer) return;
    clearTimeout(timer);
    this.submittedUserInputTimers.delete(localId);
  }

  private async notifySubmittedUserInputStillWaiting(localId: string): Promise<void> {
    this.submittedUserInputTimers.delete(localId);
    const record = this.pendingUserInputs.get(localId);
    if (!record || record.status !== 'submitted') {
      return;
    }
    await this.sendMessage(record.chatId, t(this.localeForChat(record.chatId), 'user_input_waiting_notice', {
      threadId: record.threadId,
      turnId: record.turnId ?? t(this.localeForChat(record.chatId), 'unknown'),
    }));
  }

  private async expireApproval(localId: string): Promise<void> {
    const approval = this.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      this.clearApprovalTimer(localId);
      return;
    }
    try {
      await this.app.respond(parseStoredServerRequestId(approval.serverRequestId), mapApprovalDecision(approval, 'deny'));
      await this.markApprovalResolvedForAllScopes(approval, 'deny', approval.chatId);
    } catch (error) {
      this.lastError = String(error);
      this.logger.error('approval.timeout_failed', { localId, error: String(error) });
    } finally {
      this.clearApprovalTimer(localId);
      this.updateStatus();
    }
  }

  private async tryRevealThread(scopeId: string, threadId: string, reason: 'open' | 'reveal' | 'turn-complete'): Promise<string | null> {
    try {
      await this.app.revealThread(threadId);
      this.store.insertAudit('outbound', scopeId, 'codex.app.reveal', `${reason}:${threadId}`);
      return null;
    } catch (error) {
      return formatUserError(error);
    }
  }

  private async bindCachedThread(scopeId: string, threadId: string): Promise<ThreadBinding> {
    const session = await this.resumeThreadForScope(scopeId, { threadId, cwd: null });
    return this.storeThreadSession(scopeId, session, 'replace');
  }

  private bindCachedThreadReadOnly(
    scopeId: string,
    thread: Pick<ThreadBinding, 'threadId' | 'cwd'>,
  ): ThreadBinding {
    const binding = {
      chatId: scopeId,
      threadId: thread.threadId,
      cwd: thread.cwd,
      updatedAt: Date.now(),
    };
    this.store.setBinding(scopeId, binding.threadId, binding.cwd);
    this.attachedThreads.delete(attachedThreadKey(scopeId, binding.threadId));
    this.updateStatus();
    return binding;
  }

  private async resumeThreadForScope(
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
  ): Promise<ThreadSessionState> {
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    return this.app.resumeThread({
      threadId: binding.threadId,
      cwd: binding.cwd ?? null,
      approvalPolicy: access.approvalPolicy,
      sandboxMode: access.sandboxMode,
      model: settings?.model ?? null,
    });
  }

  private setChatAccessPreset(scopeId: string, preset: AccessPresetValue | null): void {
    this.store.setChatAccessPreset(scopeId, preset);
    this.clearAttachedThreadsForScope(scopeId);
  }

  private clearAttachedThreadsForScope(scopeId: string): void {
    const prefix = `${scopeId}:`;
    for (const key of [...this.attachedThreads]) {
      if (key.startsWith(prefix)) {
        this.attachedThreads.delete(key);
      }
    }
  }

  private storeThreadSession(scopeId: string, session: ThreadSessionState, syncMode: 'replace' | 'seed'): ThreadBinding {
    const existing = this.store.getChatSettings(scopeId);
    const hasExisting = existing !== null;
    const model = syncMode === 'seed'
      ? hasExisting ? existing.model : session.model
      : session.model;
    const effort = syncMode === 'seed'
      ? hasExisting ? existing.reasoningEffort : session.reasoningEffort
      : session.reasoningEffort;
    const normalized: ThreadBinding = {
      chatId: scopeId,
      threadId: session.thread.threadId,
      cwd: session.cwd,
      updatedAt: Date.now(),
    };
    this.store.setBinding(scopeId, normalized.threadId, normalized.cwd);
    this.store.setChatSettings(scopeId, model, effort);
    this.attachedThreads.add(attachedThreadKey(scopeId, normalized.threadId));
    this.updateStatus();
    return normalized;
  }

  private resolveEffectiveAccess(scopeId: string, settings = this.store.getChatSettings(scopeId)) {
    return resolveAccessMode(this.config, settings);
  }

  private localeForChat(scopeId: string, languageCode?: string | null): AppLocale {
    if (languageCode) {
      const locale = normalizeLocale(languageCode);
      const current = this.store.getChatSettings(scopeId);
      if (current?.locale !== locale) {
        this.store.setChatLocale(scopeId, locale);
      }
      return locale;
    }
    return this.store.getChatSettings(scopeId)?.locale ?? 'en';
  }

  private findActiveTurn(scopeId: string): ActiveTurn | undefined {
    return [...this.activeTurns.values()].find(turn => turn.scopeId === scopeId);
  }

  private clearObservedThreadWatchers(): void {
    for (const watcher of this.observedThreadWatchers.values()) {
      watcher.stopped = true;
      if (watcher.timer) {
        clearTimeout(watcher.timer);
        watcher.timer = null;
      }
    }
    this.observedThreadWatchers.clear();
  }

  private pauseAppSnapshotWatchers(): void {
    for (const watcher of this.observedThreadWatchers.values()) {
      if (watcher.mode !== 'app_snapshot') {
        continue;
      }
      watcher.stopped = true;
      if (watcher.timer) {
        clearTimeout(watcher.timer);
        watcher.timer = null;
      }
    }
  }

  private scheduleCodexReconnectRecovery(): void {
    const previous = this.codexReconnectRecovery ?? Promise.resolve();
    const recovery = previous
      .catch(() => undefined)
      .then(async () => this.recoverAfterCodexReconnect());
    const trackedRecovery = recovery.finally(() => {
      if (this.codexReconnectRecovery === trackedRecovery) {
        this.codexReconnectRecovery = null;
      }
    });
    this.codexReconnectRecovery = trackedRecovery;
    this.trackControlOperation(this.codexReconnectRecovery.catch((error) => {
      this.logger.error('codex.reconnect_recovery_failed', { error: toErrorMeta(error) });
    }));
  }

  private async recoverAfterCodexReconnect(): Promise<void> {
    const recoveredScopes = new Set<string>();
    for (const watcher of [...this.observedThreadWatchers.values()]) {
      if (watcher.mode !== 'app_snapshot') {
        continue;
      }
      try {
        const binding = this.store.getBinding(watcher.scopeId);
        const session = await this.resumeThreadForScope(watcher.scopeId, {
          threadId: watcher.threadId,
          cwd: binding?.threadId === watcher.threadId ? binding.cwd : null,
        });
        this.storeThreadSession(watcher.scopeId, session, 'seed');
        watcher.stopped = false;
        const active = watcher.activeTurnId
          ? this.getActiveTurn(watcher.scopeId, watcher.activeTurnId)
          : null;
        if (active) {
          watcher.cursor = observerCursorFromActiveTurn(active);
        }
        await this.pollObservedThread(watcher);
        if (!watcher.stopped && this.observedThreadWatchers.get(watcher.scopeId) === watcher) {
          this.scheduleObservedThreadPoll(watcher);
        }
        recoveredScopes.add(watcher.scopeId);
      } catch (error) {
        watcher.stopped = false;
        if (this.observedThreadWatchers.get(watcher.scopeId) === watcher) {
          this.scheduleObservedThreadPoll(watcher);
        }
        this.logger.warn('codex.reconnect_watcher_recovery_failed', {
          scopeId: watcher.scopeId,
          threadId: watcher.threadId,
          error: toErrorMeta(error),
        });
      }
    }

    for (const active of [...this.activeTurns.values()]) {
      if (active.isObserved || recoveredScopes.has(active.scopeId) || !this.getActiveTurn(active.scopeId, active.turnId)) {
        continue;
      }
      try {
        await this.recoverActiveTurnAfterCodexReconnect(active);
      } catch (error) {
        this.logger.warn('codex.reconnect_turn_recovery_failed', {
          scopeId: active.scopeId,
          threadId: active.threadId,
          turnId: active.turnId,
          error: toErrorMeta(error),
        });
        await this.sendMessage(active.scopeId, this.localeForChat(active.scopeId) === 'zh'
          ? '连接已恢复，但无法确认原任务状态。任务未自动重发，请用 /cli 检查原会话后再继续。'
          : 'Connected again, but the original task state could not be confirmed. It was not resent. Use /cli to inspect the session.')
          .catch(notifyError => this.logger.warn('codex.recovery_notice_failed', { error: toErrorMeta(notifyError) }));
      }
    }

    await this.recoverQueuedTurns();
    this.updateStatus();
  }

  private async recoverActiveTurnAfterCodexReconnect(active: ActiveTurn): Promise<void> {
    const binding = this.store.getBinding(active.scopeId);
    const session = await this.resumeThreadForScope(active.scopeId, {
      threadId: active.threadId,
      cwd: binding?.threadId === active.threadId ? binding.cwd : null,
    });
    this.storeThreadSession(active.scopeId, session, 'seed');
    const snapshot = await this.app.readThreadSnapshot(active.threadId);
    const turn = snapshot?.turns.find(candidate => candidate.turnId === active.turnId) ?? null;
    if (!snapshot || !turn) {
      throw new Error(`Active turn ${active.turnId} was not found after reconnect`);
    }
    const diff = diffObservedTurn(
      observerCursorFromActiveTurn(active),
      turn,
      snapshot.activeFlags.includes('waitingOnApproval'),
    );
    for (const event of diff.events) {
      await this.handleTurnActivityEvent(event, active.scopeId);
    }
    if (diff.completed && this.getActiveTurn(active.scopeId, active.turnId)) {
      await this.handleTurnActivityEvent({
        kind: 'turn_completed',
        turnId: active.turnId,
        state: turn.status === 'interrupted' ? 'interrupted' : 'completed',
      }, active.scopeId);
    }
    this.logger.info('codex.reconnect_turn_recovered', {
      scopeId: active.scopeId,
      threadId: active.threadId,
      turnId: active.turnId,
      status: turn.status,
    });
  }

  private clearObservedTurnWatcher(turnId: string, scopeId?: string): void {
    for (const watcher of this.observedThreadWatchers.values()) {
      if (scopeId && watcher.scopeId !== scopeId) {
        continue;
      }
      if (watcher.activeTurnId === turnId) {
        watcher.activeTurnId = null;
        if (watcher.mode === 'app_snapshot') {
          watcher.cursor = null;
        }
        watcher.waitingOnApproval = false;
        watcher.sessionCursor = { activeTurnId: null, nextMessageIndex: 0 };
      }
    }
  }

  private async stopWatchingScopeThread(scopeId: string, nextThreadId?: string): Promise<void> {
    const watcher = this.observedThreadWatchers.get(scopeId);
    if (!watcher) {
      return;
    }
    if (nextThreadId && watcher.threadId === nextThreadId) {
      return;
    }
    watcher.stopped = true;
    if (watcher.timer) {
      clearTimeout(watcher.timer);
      watcher.timer = null;
    }
    this.observedThreadWatchers.delete(scopeId);

    if (!watcher.activeTurnId) {
      return;
    }
    const active = this.getActiveTurn(scopeId, watcher.activeTurnId);
    if (!active) {
      return;
    }
    this.clearToolBatchTimer(active.toolBatch);
    this.clearRenderRetry(active);
    if (active.previewActive) {
      await this.retirePreviewMessage(
        active.scopeId,
        active.previewMessageId,
        t(this.localeForChat(active.scopeId), 'stale_preview_expired'),
        active.turnId,
      );
    }
    active.resolver();
    this.deleteActiveTurnRecord(active);
    this.updateStatus();
  }

  private async forgetStaleActiveTurn(active: ActiveTurn, locale: AppLocale): Promise<void> {
    this.clearToolBatchTimer(active.toolBatch);
    this.clearRenderRetry(active);
    if (active.previewActive) {
      if (this.messaging.canSendToScope(active.scopeId)) {
        await this.retirePreviewMessage(
          active.scopeId,
          active.previewMessageId,
          t(locale, 'stale_preview_expired'),
          active.turnId,
        );
      } else {
        this.store.removeActiveTurnPreview(active.turnId);
      }
    }
    if (active.isObserved) {
      this.clearObservedTurnWatcher(active.turnId, active.scopeId);
    }
    active.resolver();
    this.deleteActiveTurnRecord(active);
    this.updateStatus();
  }

  private async unwatchThread(scopeId: string): Promise<string | null> {
    const watcher = this.observedThreadWatchers.get(scopeId);
    if (!watcher) {
      return null;
    }
    const threadId = watcher.threadId;
    await this.stopWatchingScopeThread(scopeId);
    return threadId;
  }

  private async watchThread(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    binding: ThreadBinding,
  ): Promise<{ mode: 'already' | 'active' | 'idle'; threadId: string }> {
    let thread = await this.app.readThread(binding.threadId, false);
    let threadId = binding.threadId;
    let watchMode: ObservedThreadWatcher['mode'] = 'session_file';
    let sessionPath: string | null = null;

    if (thread?.source !== 'app' && thread?.path && await isReadableSessionPath(thread.path)) {
      sessionPath = thread.path;
    } else {
      const readyBinding = await this.ensureThreadReady(scopeId, binding);
      threadId = readyBinding.threadId;
      thread = await this.app.readThread(threadId, false);
      watchMode = 'app_snapshot';
    }

    const existing = this.observedThreadWatchers.get(scopeId);
    if (existing && existing.threadId === threadId && existing.mode === watchMode && !existing.stopped) {
      return { mode: 'already', threadId };
    }
    await this.stopWatchingScopeThread(scopeId, threadId);
    const watcher: ObservedThreadWatcher = {
      scopeId,
      chatId,
      chatType,
      topicId,
      threadId,
      mode: watchMode,
      timer: null,
      cursor: null,
      activeTurnId: null,
      waitingOnApproval: false,
      sessionPath,
      sessionOffset: -1,
      sessionRemainder: '',
      sessionCursor: { activeTurnId: null, nextMessageIndex: 0 },
      stopped: false,
    };
    this.observedThreadWatchers.set(scopeId, watcher);
    const mode = await this.pollObservedThread(watcher);
    this.scheduleObservedThreadPoll(watcher);
    return { mode, threadId };
  }

  private scheduleObservedThreadPoll(watcher: ObservedThreadWatcher): void {
    if (watcher.stopped || this.stopping) {
      return;
    }
    watcher.timer = setTimeout(() => {
      watcher.timer = null;
      this.trackControlOperation(this.pollObservedThread(watcher).then(() => {}).catch((error) => {
        this.logger.error('codex.observe_thread_failed', {
          scopeId: watcher.scopeId,
          threadId: watcher.threadId,
          error: toErrorMeta(error),
        });
      }).finally(() => {
        if (!watcher.stopped && this.observedThreadWatchers.get(watcher.scopeId) === watcher) {
          this.scheduleObservedThreadPoll(watcher);
        }
      }));
    }, OBSERVED_THREAD_POLL_MS);
  }

  private async pollObservedThread(watcher: ObservedThreadWatcher): Promise<'active' | 'idle'> {
    if (watcher.stopped) {
      return 'idle';
    }
    if (watcher.mode === 'session_file') {
      return this.pollObservedSessionFile(watcher);
    }
    const snapshot = await this.app.readThreadSnapshot(watcher.threadId);
    if (!snapshot) {
      if (watcher.activeTurnId && this.getActiveTurn(watcher.scopeId, watcher.activeTurnId)) {
        return 'active';
      }
      await this.stopWatchingScopeThread(watcher.scopeId);
      return 'idle';
    }

    const liveTurn = findLiveTurn(snapshot);
    const latestTurn = findLatestTurn(snapshot);
    if (!liveTurn) {
      if (watcher.activeTurnId && latestTurn && latestTurn.turnId === watcher.activeTurnId) {
        const active = this.getActiveTurn(watcher.scopeId, watcher.activeTurnId);
        if (active) {
          await this.applyObservedTurnSnapshot(watcher, active, latestTurn, false);
          await this.handleTurnActivityEvent({
            kind: 'turn_completed',
            turnId: active.turnId,
            state: 'completed',
          }, watcher.scopeId);
        }
      }
      if (watcher.activeTurnId) {
        const staleActive = this.getActiveTurn(watcher.scopeId, watcher.activeTurnId);
        if (staleActive) {
          staleActive.resolver();
          this.deleteActiveTurnRecord(staleActive);
          this.updateStatus();
        }
      }
      watcher.activeTurnId = null;
      watcher.cursor = null;
      watcher.waitingOnApproval = false;
      return 'idle';
    }

    let active = watcher.activeTurnId ? this.getActiveTurn(watcher.scopeId, watcher.activeTurnId) : null;
    if (!active || watcher.activeTurnId !== liveTurn.turnId) {
      if (watcher.activeTurnId && watcher.activeTurnId !== liveTurn.turnId) {
        const staleActive = this.getActiveTurn(watcher.scopeId, watcher.activeTurnId);
        if (staleActive) {
          staleActive.resolver();
          this.deleteActiveTurnRecord(staleActive);
        }
      }
      active = this.createActiveTurnState(
        watcher.scopeId,
        watcher.chatId,
        watcher.chatType,
        watcher.topicId,
        watcher.threadId,
        liveTurn.turnId,
        0,
        true,
      );
      this.setActiveTurn(watcher.scopeId, liveTurn.turnId, active);
      watcher.activeTurnId = liveTurn.turnId;
      watcher.cursor = null;
      watcher.waitingOnApproval = false;
      this.updateStatus();
      await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    }

    await this.applyObservedTurnSnapshot(
      watcher,
      active,
      liveTurn,
      snapshot.activeFlags.includes('waitingOnApproval'),
    );
    return 'active';
  }

  private async pollObservedSessionFile(watcher: ObservedThreadWatcher): Promise<'active' | 'idle'> {
    if (!watcher.sessionPath) {
      return 'idle';
    }

    if (watcher.sessionOffset < 0) {
      let text: string;
      try {
        text = await fs.readFile(watcher.sessionPath, 'utf8');
      } catch (error) {
        if (isFileMissingError(error)) {
          await this.stopWatchingScopeThread(watcher.scopeId);
          return 'idle';
        }
        throw error;
      }
      const split = splitJsonlChunk('', text);
      const bootstrap = bootstrapSessionLog(split.lines);
      watcher.sessionOffset = Buffer.byteLength(text);
      watcher.sessionRemainder = split.remainder;
      watcher.sessionCursor = bootstrap.cursor;
      if (bootstrap.startedTurnId) {
        await this.ensureObservedActiveTurnState(watcher, bootstrap.startedTurnId);
      } else {
        watcher.activeTurnId = null;
      }
      await this.applyObservedSessionEvents(watcher, bootstrap.events);
      return watcher.sessionCursor.activeTurnId ? 'active' : 'idle';
    }

    const stats = await fs.stat(watcher.sessionPath).catch((error) => {
      if (isFileMissingError(error)) {
        return null;
      }
      throw error;
    });
    if (!stats) {
      await this.stopWatchingScopeThread(watcher.scopeId);
      return 'idle';
    }

    if (stats.size < watcher.sessionOffset) {
      watcher.sessionOffset = -1;
      watcher.sessionRemainder = '';
      watcher.sessionCursor = { activeTurnId: null, nextMessageIndex: 0 };
      return this.pollObservedSessionFile(watcher);
    }

    if (stats.size === watcher.sessionOffset) {
      return watcher.sessionCursor.activeTurnId ? 'active' : 'idle';
    }

    const handle = await fs.open(watcher.sessionPath, 'r');
    let chunk = '';
    try {
      const length = stats.size - watcher.sessionOffset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, watcher.sessionOffset);
      chunk = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }

    watcher.sessionOffset = stats.size;
    const split = splitJsonlChunk(watcher.sessionRemainder, chunk);
    watcher.sessionRemainder = split.remainder;
    const diff = applySessionLog(split.lines, watcher.sessionCursor);
    watcher.sessionCursor = diff.cursor;

    for (const turnId of diff.startedTurnIds) {
      await this.ensureObservedActiveTurnState(watcher, turnId);
    }
    await this.applyObservedSessionEvents(watcher, diff.events);
    return watcher.sessionCursor.activeTurnId ? 'active' : 'idle';
  }

  private async ensureObservedActiveTurnState(watcher: ObservedThreadWatcher, turnId: string): Promise<ActiveTurn> {
    const existing = this.getActiveTurn(watcher.scopeId, turnId);
    if (existing) {
      watcher.activeTurnId = turnId;
      return existing;
    }

    if (watcher.activeTurnId && watcher.activeTurnId !== turnId) {
      const staleActive = this.getActiveTurn(watcher.scopeId, watcher.activeTurnId);
      if (staleActive) {
        staleActive.resolver();
        this.deleteActiveTurnRecord(staleActive);
      }
    }

    const active = this.createActiveTurnState(
      watcher.scopeId,
      watcher.chatId,
      watcher.chatType,
      watcher.topicId,
      watcher.threadId,
      turnId,
      0,
      true,
    );
    this.setActiveTurn(watcher.scopeId, turnId, active);
    watcher.activeTurnId = turnId;
    this.updateStatus();
    await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    return active;
  }

  private async applyObservedSessionEvents(
    watcher: ObservedThreadWatcher,
    events: TurnActivityEvent[],
  ): Promise<void> {
    for (const event of events) {
      if (!this.getActiveTurn(watcher.scopeId, event.turnId)) {
        await this.ensureObservedActiveTurnState(watcher, event.turnId);
      }
      await this.handleTurnActivityEvent(event, watcher.scopeId);
    }
  }

  private async applyObservedTurnSnapshot(
    watcher: ObservedThreadWatcher,
    active: ActiveTurn,
    turn: { turnId: string; status: string; items: any[]; error: string | null },
    waitingOnApproval: boolean,
  ): Promise<void> {
    const diff = diffObservedTurn(watcher.cursor, turn, waitingOnApproval);
    watcher.cursor = diff.nextCursor;
    if (watcher.waitingOnApproval !== diff.waitingOnApproval) {
      watcher.waitingOnApproval = diff.waitingOnApproval;
      if (diff.waitingOnApproval) {
        active.pendingApprovalKinds.add('command');
      } else {
        active.pendingApprovalKinds.delete('command');
      }
      await this.queueTurnRender(active, { forceStatus: true });
    }
    for (const event of diff.events) {
      await this.handleTurnActivityEvent(event);
    }
  }

  private async handleTakeoverCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    if (args[0] === '--force') {
      await this.prepareForceTakeover(event, locale, args.slice(1).join(' ').trim());
      return;
    }
    const scopeId = event.scopeId;
    const nextPrompt = args.join(' ').trim();
    if (!nextPrompt) {
      await this.sendMessage(scopeId, t(locale, 'usage_takeover'));
      return;
    }

    this.store.cancelQueuedTurnInputs(scopeId);
    const active = this.findActiveTurn(scopeId);
    if (active) {
      if (active.isObserved) {
        await this.sendMessage(scopeId, t(locale, 'watch_read_only_active'));
        return;
      }
      if (!active.interruptRequested) {
        await this.requestInterrupt(active);
      }
      await this.sendMessage(scopeId, t(locale, 'interrupt_requested_waiting'));
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          active.completion,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(locale === 'zh'
              ? '等待中断完成超时，尚未发送新任务。请用 /status 检查，或用 /cli 从终端恢复。'
              : 'Interrupt confirmation timed out. No replacement task was sent. Check /status or use /cli to recover.')), 30_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    await this.startBoundTurnFromEvent(event, locale, nextPrompt);
  }

  private async prepareForceTakeover(event: TelegramTextEvent, locale: AppLocale, prompt: string): Promise<void> {
    const scopeId = event.scopeId;
    this.pendingForceTakeovers.delete(scopeId);
    if (!prompt) {
      await this.sendMessage(scopeId, t(locale, 'usage_takeover'));
      return;
    }
    if (!scopeId.startsWith('telegram:') || event.userId !== this.config.tgAllowedUserId) {
      await this.sendMessage(scopeId, t(locale, 'force_takeover_trusted_telegram_only'));
      return;
    }
    const binding = this.store.getBinding(scopeId);
    if (!binding) {
      await this.sendMessage(scopeId, t(locale, 'watch_no_thread_bound'));
      return;
    }
    const home = this.config.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    try {
      const writer = await this.externalWriterControl.inspect(home, binding.threadId);
      const id = crypto.randomBytes(8).toString('hex');
      this.pendingForceTakeovers.set(scopeId, {
        id, expiresAt: Date.now() + 60_000, event, threadId: binding.threadId, home, prompt, writer,
      });
      await this.sendMessage(scopeId, t(locale, 'force_takeover_confirm', {
        threadId: binding.threadId, pid: String(writer.pid), cwd: writer.cwd, prompt,
      }), [[
        { text: t(locale, 'button_force_takeover'), callback_data: `takeover:confirm:${id}` },
        { text: t(locale, 'button_cancel'), callback_data: `takeover:cancel:${id}` },
      ]]);
    } catch (error) {
      this.pendingForceTakeovers.delete(scopeId);
      await this.sendMessage(scopeId, t(locale, 'force_takeover_failed', { error: formatUserError(error) }));
    }
  }

  private async handleForceTakeoverCallback(
    event: TelegramCallbackEvent, locale: AppLocale, action: string, id: string,
  ): Promise<void> {
    const scopeId = event.scopeId;
    const pending = this.pendingForceTakeovers.get(scopeId);
    if (!pending || pending.id !== id || pending.event.userId !== event.userId
      || event.userId !== this.config.tgAllowedUserId || pending.expiresAt <= Date.now()) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'force_takeover_expired'));
      return;
    }
    // Claim before any await: duplicate callbacks cannot stop or submit twice.
    this.pendingForceTakeovers.delete(scopeId);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, action === 'cancel' ? 'button_cancel' : 'button_force_takeover'));
    if (action === 'cancel') {
      await this.sendMessage(scopeId, t(locale, 'force_takeover_cancelled'));
      return;
    }
    await this.withLock(scopeId, async () => {
      if (pending.expiresAt <= Date.now() || this.store.getBinding(scopeId)?.threadId !== pending.threadId) {
        await this.sendMessage(scopeId, t(locale, 'force_takeover_expired'));
        return;
      }
      if (this.externalAuthValidationInProgress) {
        await this.sendMessage(scopeId, t(locale, 'auth_sync_validation_busy'));
        return;
      }
      this.forceTakeoversInProgress.add(scopeId);
      this.turnStartInProgress += 1;
      try {
        try {
          await this.sendMessage(scopeId, t(locale, 'force_takeover_stopping', { pid: String(pending.writer.pid) }));
          await this.externalWriterControl.stop(pending.home, pending.threadId, pending.writer);
          this.logger.warn('codex.external_writer_stopped', { scopeId, threadId: pending.threadId, pid: pending.writer.pid });
          await this.stopWatchingScopeThread(scopeId);
          this.attachedThreads.delete(attachedThreadKey(scopeId, pending.threadId));
          // Never replace a missing thread with an unrelated new conversation.
          const binding = this.store.getBinding(scopeId);
          if (binding?.threadId !== pending.threadId) throw new Error(t(locale, 'force_takeover_expired'));
          await this.ensureThreadReady(scopeId, binding, { recoverMissingThread: false });
        } catch (error) {
          await this.sendMessage(scopeId, t(locale, 'force_takeover_failed', { error: formatUserError(error) }));
          return;
        }
        this.store.cancelQueuedTurnInputs(scopeId);
        await this.sendMessage(scopeId, t(locale, 'force_takeover_acquired', { threadId: pending.threadId }));
        // Normal turn-start error handling preserves ambiguous submission failures;
        // do not automatically retry a possibly accepted prompt.
        await this.startBoundTurnFromEvent(pending.event, locale, pending.prompt);
      } finally {
        this.forceTakeoversInProgress.delete(scopeId);
        this.turnStartInProgress -= 1;
      }
    });
  }

  private async handleQueueCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    const nextPrompt = args.join(' ').trim();
    if (!nextPrompt) {
      await this.sendMessage(scopeId, t(locale, 'usage_queue'));
      return;
    }

    const active = this.findActiveTurn(scopeId);
    const observedThreadId = active?.isObserved
      ? active.threadId
      : this.observedThreadWatchers.get(scopeId)?.threadId ?? null;
    if (observedThreadId) {
      await this.queueObservedThreadMessage(event, locale, nextPrompt, observedThreadId);
      return;
    }
    if (!active) {
      await this.startBoundTurnFromEvent(event, locale, nextPrompt);
      return;
    }

    await this.queuePromptAfterActiveTurn(event, locale, nextPrompt);
  }

  private async handleActiveTurnInboundMessage(
    event: TelegramTextEvent,
    locale: AppLocale,
    text: string,
  ): Promise<void> {
    const active = this.findActiveTurn(event.scopeId);
    if (!active) {
      return;
    }
    if (active.isObserved) {
      await this.queueObservedThreadMessage(event, locale, text, active.threadId);
      return;
    }
    const settings = this.store.getChatSettings(event.scopeId);
    const mode = resolveActiveTurnMessageMode(settings?.activeTurnMessageMode ?? null);
    if (mode === 'queue') {
      await this.queuePromptAfterActiveTurn(event, locale, text);
      return;
    }
    try {
      await this.steerActiveTurn(active, event, locale, text);
    } catch (error) {
      if (!isNoActiveTurnToSteerError(error)) {
        throw error;
      }
      this.logger.warn('codex.stale_active_turn_steer', {
        scopeId: event.scopeId,
        threadId: active.threadId,
        turnId: active.turnId,
        error: toErrorMeta(error),
      });
      await this.forgetStaleActiveTurn(active, locale);
      await this.startBoundTurnFromEvent(event, locale, text);
    }
  }

  private async queueObservedThreadMessage(
    event: TelegramTextEvent,
    locale: AppLocale,
    text: string,
    threadId = this.observedThreadWatchers.get(event.scopeId)?.threadId ?? null,
  ): Promise<boolean> {
    if (!threadId) {
      return false;
    }
    const input = await this.buildTurnInput({
      threadId,
      cwd: this.store.getBinding(event.scopeId)?.cwd ?? this.config.defaultCwd,
    }, { ...event, text }, locale);
    const clientUserMessageId = `foxclaw:${event.scopeId}:${event.messageId}`;
    try {
      const queued = await this.app.queueThreadInput(threadId, clientUserMessageId, input);
      await this.sendMessage(event.scopeId, t(locale, 'watch_prompt_queued', {
        id: shortId(queued.queuedSubmissionId),
      }));
    } catch (error) {
      if (!isThreadQueueUnsupportedError(error)) {
        throw error;
      }
      this.logger.warn('codex.observed_thread_queue_unsupported', {
        scopeId: event.scopeId,
        threadId,
        error: toErrorMeta(error),
      });
      await this.sendMessage(event.scopeId, t(locale, 'watch_queue_unsupported'));
    }
    return true;
  }

  private async queuePromptAfterActiveTurn(
    event: TelegramTextEvent,
    locale: AppLocale,
    text: string,
  ): Promise<void> {
    const active = this.findActiveTurn(event.scopeId);
    if (!active) {
      await this.startBoundTurnFromEvent(event, locale, text);
      return;
    }
    const input = await this.buildTurnInput({
      threadId: active.threadId,
      cwd: this.store.getBinding(event.scopeId)?.cwd ?? this.config.defaultCwd,
    }, { ...event, text }, locale);
    const queueId = this.enqueuePreparedTurnInput({
      scopeId: event.scopeId,
      chatId: event.chatId,
      chatType: event.chatType,
      topicId: event.topicId,
      threadId: active.threadId,
      input,
      sourceSummary: summarizeTelegramInput(text, event.attachments),
      messageId: event.messageId,
    });
    await this.sendMessage(event.scopeId, t(locale, 'queued_prompt_set', {
      id: shortId(queueId),
      position: this.store.countQueuedTurnInputs(event.scopeId),
    }));
  }

  private async steerActiveTurn(
    active: ActiveTurn,
    event: TelegramTextEvent,
    locale: AppLocale,
    text: string,
  ): Promise<void> {
    const binding = {
      threadId: active.threadId,
      cwd: this.store.getBinding(event.scopeId)?.cwd ?? this.config.defaultCwd,
    };
    await this.sendTyping(event.scopeId);
    const input = await this.buildTurnInput(binding, { ...event, text }, locale);
    await this.app.steerTurn(active.threadId, active.turnId, input);
    await this.queueTurnRender(active, { forceStatus: true });
    await this.sendMessage(event.scopeId, t(locale, 'steer_sent', { turnId: active.turnId }));
  }

  private enqueuePreparedTurnInput(params: {
    scopeId: string;
    chatId: string;
    chatType: string;
    topicId: number | null;
    threadId: string;
    input: TurnInput[];
    sourceSummary: string;
    messageId: number | null;
  }): string {
    const now = Date.now();
    const queueId = crypto.randomBytes(8).toString('hex');
    this.store.saveQueuedTurnInput({
      queueId,
      scopeId: params.scopeId,
      chatId: params.chatId,
      chatType: params.chatType,
      topicId: params.topicId,
      threadId: params.threadId,
      inputJson: JSON.stringify(params.input),
      sourceSummary: params.sourceSummary,
      messageId: params.messageId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    });
    return queueId;
  }

  private async startBoundTurnFromQueuedInput(record: QueuedTurnInputRecord): Promise<void> {
    const scopeId = record.scopeId;
    this.clearPlanImplementationPromptsForScope(scopeId);
    await this.stopWatchingScopeThread(scopeId);
    const existingBinding = this.store.getBinding(scopeId);
    const binding = await this.ensureThreadReady(scopeId, {
      chatId: scopeId,
      threadId: record.threadId,
      cwd: existingBinding?.cwd ?? null,
      updatedAt: Date.now(),
    });
    this.store.setBinding(scopeId, binding.threadId, binding.cwd);
    await this.sendTyping(scopeId);
    const input = parseStoredTurnInput(record.inputJson);
    const turnState = await this.startTurnWithRecovery(scopeId, binding, input);
    if (turnState.collaborationMode === 'plan') {
      this.store.setChatCollaborationMode(scopeId, DEFAULT_COLLABORATION_MODE);
    }
    await this.registerActiveTurn(
      scopeId,
      record.chatId,
      record.chatType,
      record.topicId,
      turnState.threadId,
      turnState.turnId,
      0,
      {
        input,
        threadId: turnState.threadId,
        cwd: this.store.getBinding(scopeId)?.cwd ?? binding.cwd ?? this.config.defaultCwd,
        chatId: record.chatId,
        chatType: record.chatType,
        topicId: record.topicId,
        collaborationMode: turnState.collaborationMode,
        failedAuthTargets: new Set(),
      },
      turnState.collaborationMode,
      record.queueId,
    );
  }

  private async startQueuedPromptIfPresent(scopeId: string): Promise<void> {
    if (this.findActiveTurn(scopeId)) {
      return;
    }
    const queued = this.store.peekQueuedTurnInput(scopeId);
    if (!queued) {
      return;
    }
    this.store.updateQueuedTurnInputStatus(queued.queueId, 'processing');
    try {
      await this.startBoundTurnFromQueuedInput(queued);
    } catch (error) {
      this.store.updateQueuedTurnInputStatus(queued.queueId, 'failed', formatUserError(error));
      throw error;
    }
  }

  private async recoverQueuedTurns(): Promise<void> {
    const scopeIds = new Set(this.store.listQueuedTurnInputs().map((record) => record.scopeId));
    for (const scopeId of scopeIds) {
      if (!this.messaging.canSendToScope(scopeId)) {
        continue;
      }
      await this.withLock(scopeId, async () => this.startQueuedPromptIfPresent(scopeId));
    }
  }

  private markQueuedTurnCompleted(active: ActiveTurn): void {
    if (!active.queuedInputId) {
      return;
    }
    this.store.updateQueuedTurnInputStatus(active.queuedInputId, 'completed');
  }

  private async handleModeCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const raw = args.join(' ').trim();
    if (!raw) {
      const settings = this.store.getChatSettings(scopeId);
      await this.sendMessage(scopeId, [
        t(locale, 'mode_current', { value: formatCollaborationModeLabel(locale, settings?.collaborationMode ?? null) }),
        t(locale, 'usage_mode'),
      ].join('\n'));
      return;
    }
    const mode = normalizeRequestedCollaborationMode(raw);
    if (!mode) {
      await this.sendMessage(scopeId, t(locale, 'usage_mode'));
      return;
    }
    await this.setCollaborationMode(scopeId, locale, mode);
  }

  private async handleActiveTurnMessageModeCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const raw = args.join(' ').trim();
    if (!raw) {
      await this.showSetupPanel(scopeId, 'active', undefined, locale);
      return;
    }
    const mode = normalizeRequestedActiveTurnMessageMode(raw);
    if (!mode) {
      await this.sendMessage(scopeId, t(locale, 'usage_active'));
      return;
    }
    this.store.setChatActiveTurnMessageMode(scopeId, mode);
    await this.sendMessage(scopeId, t(locale, 'active_configured', {
      value: formatActiveTurnMessageModeLabel(locale, mode),
    }));
  }

  private async handleGoalCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    if (!binding) {
      await this.sendMessage(scopeId, t(locale, 'goal_no_thread_bound'));
      return;
    }
    const command = args[0]?.toLowerCase();
    if (!command) {
      const goal = await this.app.getThreadGoal(binding.threadId);
      await this.sendMessage(scopeId, formatGoalMessage(locale, goal));
      return;
    }
    if (command === 'clear') {
      if (args[1]?.toLowerCase() !== 'confirm') {
        await this.sendMessage(scopeId, t(locale, 'goal_clear_requires_confirm'));
        return;
      }
      const cleared = await this.app.clearThreadGoal(binding.threadId);
      await this.sendMessage(scopeId, t(locale, cleared ? 'goal_cleared' : 'goal_empty'));
      return;
    }
    if (command === 'pause' || command === 'resume' || command === 'done' || command === 'complete') {
      const existing = await this.app.getThreadGoal(binding.threadId);
      if (!existing) {
        await this.sendMessage(scopeId, t(locale, 'goal_empty'));
        return;
      }
      const status: ThreadGoalStatusValue = command === 'pause'
        ? 'paused'
        : command === 'resume'
          ? 'active'
          : 'complete';
      const goal = await this.app.setThreadGoal({ threadId: binding.threadId, status });
      await this.sendMessage(scopeId, formatGoalMessage(locale, goal, t(locale, 'goal_updated')));
      return;
    }
    if (command === 'budget') {
      const existing = await this.app.getThreadGoal(binding.threadId);
      if (!existing) {
        await this.sendMessage(scopeId, t(locale, 'goal_empty'));
        return;
      }
      const rawBudget = args[1]?.trim().toLowerCase() ?? '';
      if (!rawBudget) {
        await this.sendMessage(scopeId, t(locale, 'usage_goal'));
        return;
      }
      const tokenBudget = rawBudget === 'off' || rawBudget === 'clear' || rawBudget === 'none'
        ? null
        : Number.parseInt(rawBudget.replaceAll(',', ''), 10);
      if (tokenBudget !== null && (!Number.isFinite(tokenBudget) || tokenBudget <= 0)) {
        await this.sendMessage(scopeId, t(locale, 'usage_goal'));
        return;
      }
      const goal = await this.app.setThreadGoal({ threadId: binding.threadId, tokenBudget });
      await this.sendMessage(scopeId, formatGoalMessage(locale, goal, t(locale, 'goal_updated')));
      return;
    }
    const objective = command === 'set' ? args.slice(1).join(' ').trim() : args.join(' ').trim();
    if (!objective) {
      await this.sendMessage(scopeId, t(locale, 'usage_goal'));
      return;
    }
    const goal = await this.app.setThreadGoal({ threadId: binding.threadId, objective });
    await this.sendMessage(scopeId, formatGoalMessage(locale, goal, t(locale, 'goal_updated')));
  }

  private async handleHistoryCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    if (!binding) {
      await this.sendMessage(scopeId, t(locale, 'history_no_thread_bound'));
      return;
    }
    const limit = parsePositiveInt(args[0], 10, 1, 30);
    if (limit === null) {
      await this.sendMessage(scopeId, t(locale, 'usage_history'));
      return;
    }
    const turns = await this.app.listThreadTurns(binding.threadId, limit);
    await this.sendMessage(scopeId, formatHistoryMessage(locale, binding.threadId, turns));
  }

  private async handleFilesCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const query = args.join(' ').trim();
    if (!query) {
      await this.sendMessage(scopeId, t(locale, 'usage_files'));
      return;
    }
    const binding = this.store.getBinding(scopeId);
    const root = binding?.cwd ?? this.config.defaultCwd;
    const files = await this.app.fuzzyFileSearch(query, [root]);
    await this.sendMessage(scopeId, formatFuzzyFilesMessage(locale, query, root, files));
  }

  private async handleRemoteCommand(scopeId: string, locale: AppLocale): Promise<void> {
    await this.sendMessage(scopeId, formatRemoteStatusMessage(locale, this.lastRemoteControlStatus));
  }

  private async handleFastCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const raw = args.join(' ').trim().toLowerCase();
    if (!raw) {
      await this.showSetupPanel(scopeId, 'fast', undefined, locale);
      return;
    }
    if (this.findActiveTurn(scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'wait_current_turn'));
      return;
    }
    if (raw !== 'on' && raw !== 'off' && raw !== 'toggle') {
      await this.sendMessage(scopeId, t(locale, 'usage_fast'));
      return;
    }

    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    const fastTier = resolveFastTierForModel(currentModel);
    if (!fastTier) {
      await this.sendMessage(scopeId, t(locale, 'fast_not_supported_by_model'));
      await this.showSetupPanel(scopeId, 'fast', undefined, locale);
      return;
    }

    const currentlyOn = settings?.serviceTier === fastTier.id;
    const nextTier = raw === 'toggle'
      ? currentlyOn ? null : fastTier.id
      : raw === 'on'
        ? fastTier.id
        : null;
    this.store.setChatServiceTier(scopeId, nextTier);
    await this.showSetupPanel(scopeId, 'fast', undefined, locale);
  }

  private async setCollaborationMode(scopeId: string, locale: AppLocale, mode: CollaborationModeValue): Promise<void> {
    this.store.setChatCollaborationMode(scopeId, mode);
    if (mode === 'plan') {
      await this.sendMessage(scopeId, t(locale, 'mode_plan_armed'));
      return;
    }
    await this.sendMessage(scopeId, [
      t(locale, 'mode_configured', { value: formatCollaborationModeLabel(locale, mode) }),
      t(locale, 'applies_next_turn'),
    ].join('\n'));
  }

  private async handleAuthReloadCommand(scopeId: string, locale: AppLocale): Promise<void> {
    if (this.hasLocalBlockingActivity()) {
      await this.sendMessage(scopeId, t(locale, 'auth_reload_blocked_active'));
      return;
    }

    await this.sendMessage(scopeId, t(locale, 'auth_reload_restarting'));
    const currentCandidate = (await this.listCodexAuthState()).candidates.find(candidate => candidate.isCurrent) ?? null;
    const recovered = currentCandidate
      ? await this.recoverCodexAuthCandidate(currentCandidate.name, { crossNode: false })
      : false;
    this.pendingTurnErrors.clear();
    this.attachedThreads.clear();
    await this.app.restart();
    if (currentCandidate) {
      await this.syncCodexAuthCandidate(currentCandidate.name);
    }

    const lines = [t(locale, 'auth_reload_done')];
    if (recovered) {
      lines.push(t(locale, 'auth_recovered_newer_candidate', { value: currentCandidate!.name }));
    }
    lines.push(...await this.buildCodexUsageStatusLines(locale));
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private canRunGlobalAuthRefresh(): boolean {
    return this.isIdleForServiceUpdate()
      && this.store.countPendingApprovals() === 0
      && this.store.countPendingUserInputs() === 0
      && (!this.coordinator?.canSelfUpdate || this.coordinator.canSelfUpdate());
  }

  private async handleSelfUpdateCommand(scopeId: string, locale: AppLocale): Promise<void> {
    if (!this.selfUpdater) {
      await this.sendMessage(scopeId, t(locale, 'update_unavailable'));
      return;
    }
    if (!this.isIdleForServiceUpdate() || this.store.countPendingApprovals() > 0 || this.store.countPendingUserInputs() > 0 || (this.coordinator?.canSelfUpdate && !this.coordinator.canSelfUpdate())) {
      await this.sendRichInternalMessage(scopeId, '/update', await this.formatSelfUpdateBlockedMessage(locale));
      return;
    }
    const status = await this.selfUpdater.readStatus();
    if (status?.state === 'pending') {
      await this.sendMessage(scopeId, t(locale, 'update_already_running'));
      this.scheduleSelfUpdateStatusPoll();
      return;
    }
    if (status) {
      await this.selfUpdater.clearStatus();
    }
    await this.sendMessage(scopeId, t(locale, 'update_started'));
    try {
      await this.selfUpdater.launch(scopeId, locale);
      this.scheduleSelfUpdateStatusPoll();
    } catch (error) {
      await this.selfUpdater.clearStatus().catch(() => undefined);
      await this.sendMessage(scopeId, t(locale, 'update_failed', { error: formatUserError(error) }));
    }
  }

  private async formatSelfUpdateBlockedMessage(locale: AppLocale): Promise<string> {
    const blockers = await this.collectSelfUpdateBlockers(locale);
    if (locale === 'zh') {
      return [
        '现在不能从 Telegram 里升级 FoxClaw，因为后台仍有活动：',
        '',
        ...(blockers.length > 0 ? blockers.map((blocker) => `- ${blocker}`) : [`- ${t(locale, 'update_blocked_active')}`]),
        '',
        '说明：远端 auth 候选导入队列不等于本机 auth 文件数量；它可能来自其他节点还没清理或没收到删除广播的旧 team 账号。',
        '处理：普通 Codex 回复可用 /interrupt；auth 同步队列请等待消化，或在远端清理旧候选后补发删除/安全同步。终端 foxclaw update 不受这个聊天保护限制。',
      ].join('\n');
    }
    return [
      'FoxClaw cannot be updated from Telegram because background work is still active:',
      '',
      ...(blockers.length > 0 ? blockers.map((blocker) => `- ${blocker}`) : [`- ${t(locale, 'update_blocked_active')}`]),
      '',
      'Note: remote auth import backlog is not the same as the number of local auth files; it can come from stale team accounts on another node.',
      'Action: use /interrupt for normal Codex turns; let auth sync drain, or clean the remote stale candidates and resend delete/safe-sync events. Terminal foxclaw update bypasses this chat guard.',
    ].join('\n');
  }

  private async collectSelfUpdateBlockers(locale: AppLocale): Promise<string[]> {
    const blockers: string[] = [];
    const pendingApprovals = this.pendingApprovalMessages.size + this.store.countPendingApprovals();
    const pendingUserInputs = this.pendingUserInputs.size + this.store.countPendingUserInputs();
    const localLabels = locale === 'zh'
      ? {
          activeTurns: '当前 runtime 活跃回复',
          approvals: '待处理审批',
          userInputs: '待回答问题',
          mcp: '待处理 MCP 交互',
          logins: '登录流程',
          rotation: 'auth 自动轮换',
          refreshAll: 'auth 全量刷新',
          validation: '远端 auth 校验',
          turnStart: '回复启动中',
          otherRuntime: '其他 runtime 活跃',
          weixin: '微信 runtime 活跃回复',
          authQueue: '远端 auth 候选导入队列',
          received: '最近收到',
          imported: '最近导入',
          failed: '最近失败',
          lease: 'auth 同步租约',
          error: 'auth 同步错误',
          coordinator: '服务协调器报告仍忙',
        }
      : {
          activeTurns: 'Current runtime active turns',
          approvals: 'Pending approvals',
          userInputs: 'Pending questions',
          mcp: 'Pending MCP interactions',
          logins: 'Login flows',
          rotation: 'Auth rotation',
          refreshAll: 'Auth refresh-all',
          validation: 'Remote auth validation',
          turnStart: 'Turn startup',
          otherRuntime: 'Other runtime active turns',
          weixin: 'Weixin runtime active turns',
          authQueue: 'Remote auth candidate import queue',
          received: 'last received',
          imported: 'last imported',
          failed: 'recent failure',
          lease: 'Auth sync lease',
          error: 'Auth sync error',
          coordinator: 'Service coordinator reports busy',
        };

    if (this.activeTurns.size > 0) blockers.push(`${localLabels.activeTurns}: ${this.activeTurns.size}`);
    if (pendingApprovals > 0) blockers.push(`${localLabels.approvals}: ${pendingApprovals}`);
    if (pendingUserInputs > 0) blockers.push(`${localLabels.userInputs}: ${pendingUserInputs}`);
    if (this.pendingMcpElicitations.size > 0) blockers.push(`${localLabels.mcp}: ${this.pendingMcpElicitations.size}`);
    if (this.pendingLoginsByScope.size > 0) blockers.push(`${localLabels.logins}: ${this.pendingLoginsByScope.size}`);
    if (this.authRotationInProgress) blockers.push(localLabels.rotation);
    if (this.authRefreshAllInProgress) blockers.push(localLabels.refreshAll);
    if (this.externalAuthValidationInProgress) blockers.push(localLabels.validation);
    if (this.turnStartInProgress > 0) blockers.push(`${localLabels.turnStart}: ${this.turnStartInProgress}`);

    const serviceStatus = await this.readServiceStatusForUpdateBlockers();
    if (serviceStatus) {
      const activeBots = serviceStatus.bots
        .filter((runtime) => runtime.activeTurns > 0)
        .map((runtime) => `${runtime.username ? `@${runtime.username}` : runtime.id} ${runtime.activeTurns}`);
      if (activeBots.length > 0) {
        blockers.push(`${localLabels.otherRuntime}: ${activeBots.join(', ')}`);
      }
      if ((serviceStatus.weixinRuntime?.activeTurns ?? 0) > 0) {
        blockers.push(`${localLabels.weixin}: ${serviceStatus.weixinRuntime!.activeTurns}`);
      }
      const authSync = serviceStatus.authSync;
      if (authSync?.enabled) {
        if (authSync.pendingImports > 0) {
          const details = [
            authSync.lastReceivedAt ? `${localLabels.received} ${authSync.lastReceivedAt}` : null,
            authSync.lastImportedAt ? `${localLabels.imported} ${authSync.lastImportCandidate ?? authSync.lastImportedAt}` : null,
          ].filter(Boolean);
          blockers.push(`${localLabels.authQueue}: ${authSync.pendingImports}${details.length > 0 ? ` (${details.join('; ')})` : ''}`);
        }
        const latestFailure = authSync.candidateFailures?.[0] ?? null;
        if (latestFailure) {
          const source = latestFailure.sourceLabel ?? latestFailure.peer ?? latestFailure.sourceNodeId;
          blockers.push(`${localLabels.failed}: ${latestFailure.candidateName}: ${latestFailure.reason}${source ? ` (${source})` : ''}`);
        }
        if (authSync.activeLeaseId) blockers.push(`${localLabels.lease}: ${authSync.activeLeaseId}`);
        if (authSync.lastError) blockers.push(`${localLabels.error}: ${authSync.lastError}`);
      }
    } else if (this.coordinator?.canSelfUpdate && !this.coordinator.canSelfUpdate()) {
      blockers.push(localLabels.coordinator);
    }
    if (blockers.length === 0 && this.coordinator?.canSelfUpdate && !this.coordinator.canSelfUpdate()) {
      blockers.push(localLabels.coordinator);
    }
    return blockers;
  }

  private async readServiceStatusForUpdateBlockers(): Promise<ServiceRuntimeStatus | null> {
    if (!this.coordinator?.getServiceStatus) return null;
    try {
      return await this.coordinator.getServiceStatus();
    } catch (error) {
      this.logger.warn('self_update.service_status_failed', { error: toErrorMeta(error) });
      return null;
    }
  }

  private scheduleSelfUpdateStatusPoll(delay = SELF_UPDATE_STATUS_POLL_MS): void {
    if (this.stopping || !this.selfUpdater || this.selfUpdatePollTimer) {
      return;
    }
    this.selfUpdatePollTimer = setTimeout(() => {
      this.selfUpdatePollTimer = null;
      this.trackControlOperation(this.pollSelfUpdateStatus().catch((error) => {
        this.logger.error('self_update.poll_failed', { error: toErrorMeta(error) });
        this.scheduleSelfUpdateStatusPoll();
      }));
    }, delay);
  }

  private clearSelfUpdateStatusPoll(): void {
    if (!this.selfUpdatePollTimer) {
      return;
    }
    clearTimeout(this.selfUpdatePollTimer);
    this.selfUpdatePollTimer = null;
  }

  private async pollSelfUpdateStatus(): Promise<void> {
    const status = await this.selfUpdater?.readStatus();
    if (!status) {
      return;
    }
    if (status.state === 'pending') {
      this.scheduleSelfUpdateStatusPoll();
      return;
    }
    if (status.scopeId.startsWith('cluster:')) {
      this.coordinator?.selfUpdateCompleted?.(status);
      await this.selfUpdater?.clearStatus();
      return;
    }
    if (!this.ownsScope(status.scopeId)) {
      this.scheduleSelfUpdateStatusPoll();
      return;
    }
    this.coordinator?.selfUpdateCompleted?.(status);
    const broadcast = await this.resolveSelfUpdateBroadcastSummary(status);
    const result = this.formatSelfUpdateResult(status, broadcast);
    await this.sendRichHtmlMessage(status.scopeId, result.html, result.fallbackHtml);
    await this.selfUpdater?.clearStatus();
  }

  private formatSelfUpdateResult(
    status: SelfUpdateStatus,
    broadcast: SelfUpdateBroadcastSummary,
  ): { html: string; fallbackHtml: string } {
    const codexUpdateLine = this.formatCodexUpdateResult(status);
    const releaseNotes = this.formatSelfUpdateReleaseNotes(status);
    if (status.state === 'succeeded') {
      const foxclawResult = t(status.locale, 'update_succeeded', {
        from: status.fromVersion,
        to: status.toVersion ?? t(status.locale, 'unknown'),
      });
      const broadcastLine = formatSelfUpdateBroadcastLine(status.locale, status.toVersion, broadcast);
      const rows = [
        ['FoxClaw', `${status.fromVersion} -> ${status.toVersion ?? t(status.locale, 'unknown')}`, status.locale === 'zh' ? '升级完成，服务已重启' : 'Updated; service restarted'],
        ['Codex CLI', formatSelfUpdateVersionTransition(status.codexFromVersion, status.codexToVersion, status.locale), formatCodexUpdateState(status)],
        ...(status.agyFromVersion || status.agyUpdate ? [
          ['Antigravity (AGY)', formatSelfUpdateVersionTransition(status.agyFromVersion ?? null, status.agyToVersion ?? null, status.locale), status.agyUpdate ?? (status.locale === 'zh' ? '已检查更新' : 'Checked')]
        ] : []),
        [status.locale === 'zh' ? '集群广播' : 'Cluster broadcast', status.toVersion ?? t(status.locale, 'unknown'), broadcastLine],
      ];
      const notes = status.releaseNotes?.filter(note => note.trim()) ?? [];
      const notesHtml = notes.length > 0
        ? telegramDetails(
          status.locale === 'zh' ? `查看更新内容 · ${notes.length} 项` : `Release notes · ${notes.length} items`,
          `<ul>${notes.map(note => `<li>${escapeTelegramHtml(note)}</li>`).join('')}</ul>`,
        )
        : '';
      const title = status.locale === 'zh' ? 'FoxClaw 升级完成' : 'FoxClaw update completed';
      const html = [
        `<h3>${escapeTelegramHtml(title)}</h3>`,
        renderTelegramTable(
          status.locale === 'zh' ? ['组件', '版本', '结果'] : ['Component', 'Version', 'Result'],
          rows,
        ),
        notesHtml,
        '<footer>FoxClaw · update</footer>',
      ].filter(Boolean).join('\n');
      const fallbackHtml = [
        telegramBold(title),
        escapeTelegramHtml(foxclawResult),
        escapeTelegramHtml(codexUpdateLine ?? (status.locale === 'zh' ? 'Codex CLI：未执行升级。' : 'Codex CLI: not updated.')),
        ...(status.agyUpdate ? [escapeTelegramHtml(`Antigravity CLI：${status.agyUpdate}`)] : []),
        escapeTelegramHtml(broadcastLine),
        releaseNotes ? escapeTelegramHtml(releaseNotes) : '',
      ].filter(Boolean).join('\n');
      return { html, fallbackHtml };
    }
    const result = t(status.locale, 'update_failed', { error: status.error ?? t(status.locale, 'unknown') });
    const fallback = codexUpdateLine ? `${result}\n${codexUpdateLine}` : result;
    return {
      html: `<h3>${escapeTelegramHtml(status.locale === 'zh' ? 'FoxClaw 升级失败' : 'FoxClaw update failed')}</h3><p>${escapeTelegramHtml(fallback)}</p>`,
      fallbackHtml: escapeTelegramHtml(fallback),
    };
  }

  private async resolveSelfUpdateBroadcastSummary(status: SelfUpdateStatus): Promise<SelfUpdateBroadcastSummary> {
    if (status.state !== 'succeeded' || !status.toVersion || !this.coordinator?.getServiceStatus) {
      return { state: 'pending', sent: 0, peers: [] };
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const serviceStatus = await this.coordinator.getServiceStatus().catch(() => null);
      const authSync = serviceStatus?.authSync;
      if (!authSync?.enabled) {
        return { state: 'disabled', sent: 0, peers: [] };
      }
      const recentEvents = authSync.recentEvents ?? [];
      const updateCompletedAt = Date.parse(status.updatedAt);
      const broadcast = [...recentEvents].reverse().find(event => (
        event.kind === 'service.update.request'
        && event.stage === 'broadcast'
        && event.detail === `target=${status.toVersion}`
        && (!Number.isFinite(updateCompletedAt) || Date.parse(event.createdAt) >= updateCompletedAt)
      ));
      if (broadcast) {
        const peers = recentEvents
          .filter(event => (
            event.kind === 'service.update.request'
            && event.stage === 'sent'
            && event.direction === 'out'
            && event.requestId === broadcast.requestId
            && Boolean(event.peer)
          ))
          .map(event => event.peer!)
          .filter((peer, index, all) => all.indexOf(peer) === index);
        return { state: 'sent', sent: peers.length, peers };
      }
      if (attempt < 4) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    return { state: 'pending', sent: 0, peers: [] };
  }

  private formatSelfUpdateReleaseNotes(status: SelfUpdateStatus): string | null {
    const notes = status.releaseNotes?.filter(note => note.trim()) ?? [];
    if (status.state !== 'succeeded' || notes.length === 0) {
      return null;
    }
    return [
      '',
      t(status.locale, 'update_changes_title'),
      ...notes.map(note => `- ${note}`),
    ].join('\n');
  }

  private formatCodexUpdateResult(status: SelfUpdateStatus): string | null {
    if (status.codexFromVersion || status.codexToVersion) {
      return t(status.locale, 'update_codex_result', {
        from: status.codexFromVersion ?? t(status.locale, 'unknown'),
        to: status.codexToVersion ?? t(status.locale, 'unknown'),
      });
    }
    return status.codexUpdate ?? null;
  }

  private scheduleProactiveAuthRefresh(delayMs = CODEX_AUTH_PROACTIVE_REFRESH_INTERVAL_MS): void {
    if (this.stopping || this.proactiveAuthRefreshTimer) {
      return;
    }
    this.proactiveAuthRefreshTimer = setTimeout(() => {
      this.proactiveAuthRefreshTimer = null;
      this.trackControlOperation(this.runProactiveAuthRefresh().catch((error) => {
        this.logger.warn('codex.auth_proactive_refresh_failed', { error: toErrorMeta(error) });
      }).finally(() => {
        this.scheduleProactiveAuthRefresh();
      }));
    }, delayMs);
    this.proactiveAuthRefreshTimer.unref();
  }

  private clearProactiveAuthRefreshTimer(): void {
    if (!this.proactiveAuthRefreshTimer) {
      return;
    }
    clearTimeout(this.proactiveAuthRefreshTimer);
    this.proactiveAuthRefreshTimer = null;
  }

  private async runProactiveAuthRefresh(): Promise<void> {
    if (this.proactiveAuthRefreshInProgress || !this.canRunGlobalAuthRefresh()) {
      return;
    }
    const state = await this.listCodexAuthState();
    const dueCandidates = state.candidates.filter(candidate =>
      !candidate.disabled
      && candidate.state !== 'needs_repair'
      && candidate.credentialKind === 'chatgpt'
      && candidate.credentialLastRefreshMs !== null
      && candidate.credentialLastRefreshMs <= Date.now() - CODEX_AUTH_PROACTIVE_REFRESH_DAYS * 24 * 60 * 60_000
    );
    if (dueCandidates.length === 0) {
      return;
    }

    this.proactiveAuthRefreshInProgress = true;
    const startedAt = new Date().toISOString();
    const dueCandidateNames = dueCandidates.map(candidate => candidate.name);
    this.recordProactiveAuthRefreshStatus({
      state: 'running',
      startedAt,
      finishedAt: null,
      candidates: dueCandidateNames,
      refreshed: 0,
      skipped: 0,
      failed: 0,
      error: null,
      details: [],
    });
    let lease: { ok: boolean; leaseId: string | null; reason?: string | null } | undefined;
    try {
      lease = await this.coordinator?.acquireAuthRefreshLease?.(`proactive auth refresh: ${dueCandidateNames.join(', ')}`);
      if (lease && !lease.ok) {
        this.logger.warn('codex.auth_proactive_refresh_lease_failed', { reason: lease.reason });
        this.recordProactiveAuthRefreshStatus({
          state: 'lease_failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          candidates: dueCandidateNames,
          refreshed: 0,
          skipped: 0,
          failed: 0,
          error: lease.reason ?? 'unknown',
          details: [],
        });
        return;
      }
      const result = await this.refreshCodexAuthCandidates(new Set(dueCandidateNames));
      this.recordProactiveAuthRefreshStatus({
        state: 'completed',
        startedAt,
        finishedAt: new Date().toISOString(),
        candidates: dueCandidateNames,
        refreshed: result.refreshed.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
        error: result.failed.length > 0 ? `${result.failed.length} failed` : null,
        details: result.failed.slice(0, 5).map(failure => `${failure.name}: ${failure.error}`),
      });
    } catch (error) {
      this.recordProactiveAuthRefreshStatus({
        state: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        candidates: dueCandidateNames,
        refreshed: 0,
        skipped: 0,
        failed: dueCandidateNames.length,
        error: formatUserError(error),
        details: [],
      });
      throw error;
    } finally {
      await this.coordinator?.releaseAuthRefreshLease?.(lease?.leaseId ?? null);
      this.proactiveAuthRefreshInProgress = false;
    }
  }

  private recordProactiveAuthRefreshStatus(status: AuthProactiveRefreshStatus): void {
    this.proactiveAuthRefreshStatus = status;
    this.updateStatus();
  }

  async handleAuthCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() ?? 'list';
    if (action === 'sync') {
      await this.handleAuthSyncCommand(scopeId, locale, args.slice(1));
      return;
    }
    if (action === 'reload' || action === 'restart') {
      await this.handleAuthReloadCommand(scopeId, locale);
      return;
    }
    if (action === 'refresh') {
      if (args[1]?.toLowerCase() === 'all') {
        await this.handleAuthRefreshAllCommand(scopeId, locale, args[2]?.toLowerCase() === 'confirm');
        return;
      }
      await this.sendMessage(scopeId, t(locale, 'usage_auth'));
      return;
    }
    if (action === 'refresh_all') {
      await this.handleAuthRefreshAllCommand(scopeId, locale, args[1]?.toLowerCase() === 'confirm');
      return;
    }
    if (action === 'use') {
      await this.handleAuthUseCommand(scopeId, locale, args.slice(1));
      return;
    }
    if (action === 'add') {
      await this.handleAuthAddCommand(scopeId, locale, args.slice(1));
      return;
    }
    if (action === 'enable' || action === 'disable') {
      await this.handleAuthToggleCommand(scopeId, locale, args.slice(1), action === 'disable');
      return;
    }
    const listRequest = parseCodexAuthListRequest(action, args);
    if (!listRequest) {
      await this.sendMessage(scopeId, t(locale, 'usage_auth'));
      return;
    }

    const state = await this.listCodexAuthState();
    await this.refreshCurrentCodexAuthQuota(state);
    const record = createPendingAuthChoiceList(scopeId, state.candidates, listRequest);
    this.pendingAuthChoiceLists.set(record.localId, record);
    const authListMessage = renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(scopeId) !== null, record);
    const messageId = await this.sendRichInternalMessage(
      scopeId,
      '/auth',
      authListMessage,
      authChoiceKeyboard(locale, record),
    );
    record.messageId = messageId;
    this.scheduleStalePanelDeletion(scopeId, messageId);
  }

  private async handleAuthSyncCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() ?? 'status';
    if (action === 'status') {
      const message = formatAuthSyncStatus(
        locale,
        this.coordinator?.getAuthSyncStatus?.() ?? null,
        this.getRuntimeStatus().authProactiveRefresh ?? null,
      );
      await this.sendRichInternalMessage(scopeId, '/auth sync status', message);
      return;
    }
    if (action === 'events') {
      const message = formatAuthSyncEvents(
        locale,
        this.coordinator?.getAuthSyncStatus?.() ?? null,
        args.slice(1).join(' ').trim() || null,
      );
      await this.sendRichInternalMessage(scopeId, '/auth sync events', message);
      return;
    }
    if (action === 'trace') {
      const requestId = args[1]?.trim() || null;
      if (!requestId) {
        await this.sendMessage(scopeId, t(locale, 'auth_sync_trace_missing'));
        return;
      }
      await this.sendRichInternalMessage(
        scopeId,
        '/auth sync trace',
        formatAuthSyncTrace(locale, this.coordinator?.getAuthSyncStatus?.() ?? null, requestId),
      );
      return;
    }
    if (action === 'test') {
      const result = await this.coordinator?.authSyncTest?.();
      if (!result) {
        await this.sendMessage(scopeId, t(locale, 'auth_sync_disabled'));
        return;
      }
      const message = [
        t(locale, 'auth_sync_test_sent', { sent: result.sent, replied: result.replied }),
        ...(result.missing.length > 0 ? [t(locale, 'auth_sync_test_missing', { value: result.missing.join(', ') })] : []),
      ].join('\n');
      await this.sendMessage(scopeId, message);
      return;
    }
    if (action === 'audit' || action === 'check' || action === 'safe') {
      if (!this.canRunGlobalAuthRefresh()) {
        await this.sendMessage(scopeId, t(locale, 'auth_cluster_audit_blocked_active'));
        return;
      }
      await this.sendMessage(scopeId, t(locale, 'auth_cluster_audit_starting'));
      const outcome = await this.runAuthClusterAudit();
      if (!outcome) {
        await this.sendMessage(scopeId, t(locale, 'auth_sync_disabled'));
        return;
      }
      await this.sendRichInternalMessage(scopeId, '/auth sync safe', formatAuthClusterAuditResult(locale, outcome));
      return;
    }
    if (action === 'push' && args[1]?.toLowerCase() === 'all') {
      if (!this.canRunGlobalAuthRefresh()) {
        await this.sendMessage(scopeId, t(locale, 'auth_sync_push_blocked_active'));
        return;
      }
      const result = await this.runAuthSafeSyncAll();
      if (!result) {
        await this.sendMessage(scopeId, t(locale, 'auth_sync_disabled'));
        return;
      }
      await this.sendMessage(scopeId, t(locale, 'auth_sync_safe_done', {
        localSynced: result.localSynced,
        localSkipped: result.localSkipped,
        sent: result.sent,
        skipped: result.skipped,
      }));
      return;
    }
    await this.sendMessage(scopeId, t(locale, 'usage_auth_sync'));
  }

  private async runAuthSafeSyncAll(): Promise<{ localSynced: number; localSkipped: number; sent: number; skipped: number } | null> {
    const safeResult = await this.coordinator?.authSyncSafeAll?.();
    if (safeResult) {
      return safeResult;
    }
    const pushResult = await this.coordinator?.authSyncPushAll?.();
    return pushResult
      ? { localSynced: 0, localSkipped: 0, sent: pushResult.sent, skipped: pushResult.skipped }
      : null;
  }

  private async runAuthClusterAudit(): Promise<CodexAuthClusterAuditOutcome | null> {
    if (!this.coordinator?.authSyncAudit) return null;
    const lease = await this.coordinator.acquireAuthRefreshLease?.('cluster auth audit and stale refresh');
    if (lease && !lease.ok) {
      throw new UserFacingError(lease.reason ?? 'cluster auth audit lease was not granted');
    }
    try {
      const audit = await this.coordinator.authSyncAudit();
      if (!audit) return null;
      const refresh: CodexAuthRefreshAllResult = { refreshed: [], skipped: [], failed: [] };
      let refreshSkippedReason: string | null = null;
      const complete = audit.nodesResponded === audit.nodesExpected
        && audit.missingPeers.length === 0
        && audit.busyNodes.length === 0;
      if (complete) {
        const state = await this.listCodexAuthState();
        const staleNames = new Set(state.candidates
          .filter(candidate => (
            !candidate.disabled
            && candidate.state !== 'needs_repair'
            && candidate.credentialKind === 'chatgpt'
            && candidate.credentialLastRefreshMs !== null
            && candidate.credentialLastRefreshMs <= Date.now() - CODEX_AUTH_PROACTIVE_REFRESH_DAYS * 24 * 60 * 60_000
          ))
          .map(candidate => candidate.name));
        if (staleNames.size > 0) {
          const refreshed = await this.refreshCodexAuthCandidates(staleNames);
          refresh.refreshed.push(...refreshed.refreshed);
          refresh.skipped.push(...refreshed.skipped);
          refresh.failed.push(...refreshed.failed);
        }
      } else {
        refreshSkippedReason = 'cluster audit was incomplete';
      }
      const push = await this.coordinator.authSyncPushAll?.() ?? { sent: 0, skipped: 0 };
      return { audit, refresh, push, refreshSkippedReason };
    } finally {
      await this.coordinator.releaseAuthRefreshLease?.(lease?.leaseId ?? null);
    }
  }

  private async handleAuthRefreshAllCommand(scopeId: string, locale: AppLocale, confirmed = false): Promise<void> {
    if (!this.canRunGlobalAuthRefresh()) {
      await this.sendMessage(scopeId, t(locale, 'auth_refresh_all_blocked_active'));
      return;
    }
    if (!confirmed) {
      const state = await this.listCodexAuthState();
      await this.applySharedCodexAuthQuotaSnapshots(state);
      const record = createPendingAuthChoiceList(scopeId, state.candidates);
      this.pendingAuthChoiceLists.set(record.localId, record);
      const messageId = await this.sendMessage(
        scopeId,
        t(locale, 'auth_refresh_all_confirm_message'),
        authRefreshAllConfirmKeyboard(locale, record),
      );
      record.messageId = messageId;
      return;
    }
    await this.sendMessage(scopeId, t(locale, 'auth_refresh_all_starting'));
    const lease = await this.coordinator?.acquireAuthRefreshLease?.('auth refresh all');
    if (lease && !lease.ok) {
      await this.sendMessage(scopeId, t(locale, 'auth_refresh_all_lease_failed', { error: lease.reason ?? t(locale, 'unknown') }));
      return;
    }
    let result: CodexAuthRefreshAllResult;
    try {
      result = await this.refreshAllCodexAuthCandidates();
    } finally {
      await this.coordinator?.releaseAuthRefreshLease?.(lease?.leaseId ?? null);
    }
    const state = await this.listCodexAuthState();
    await this.applySharedCodexAuthQuotaSnapshots(state);
    const record = createPendingAuthChoiceList(scopeId, state.candidates);
    this.pendingAuthChoiceLists.set(record.localId, record);
    const messageId = await this.sendMessage(
      scopeId,
      `${formatAuthRefreshAllResult(locale, result)}\n\n${renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(scopeId) !== null, record)}`,
      authChoiceKeyboard(locale, record),
    );
    record.messageId = messageId;
  }

  private async handleAuthUseCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    if (this.hasLocalBlockingActivity()) {
      await this.sendMessage(scopeId, t(locale, 'auth_reload_blocked_active'));
      return;
    }
    const index = Number.parseInt(args[0] || '', 10);
    if (!Number.isFinite(index) || index < 1) {
      await this.sendMessage(scopeId, t(locale, 'usage_auth'));
      return;
    }
    let candidates = this.findLatestAuthChoiceList(scopeId)?.candidates ?? null;
    if (!candidates) {
      const state = await this.listCodexAuthState();
      candidates = state.candidates;
    }
    const candidate = candidates[index - 1];
    if (!candidate) {
      await this.sendMessage(scopeId, t(locale, 'auth_choice_expired'));
      const state = await this.listCodexAuthState();
      await this.sendMessage(scopeId, renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(scopeId) !== null));
      return;
    }
    if (candidate.state === 'needs_repair') {
      await this.sendMessage(scopeId, t(locale, 'auth_candidate_needs_repair', { value: candidate.name }));
      return;
    }
    const switchLabels = await this.readCodexAuthSwitchLabels(candidate);
    await this.sendMessage(scopeId, t(locale, 'auth_switching', this.codexAuthSwitchParams(locale, switchLabels.fromLabel, switchLabels.toLabel)));
    await this.switchCodexAuthAndRestart(scopeId, locale, candidate, false);
  }

  private async handleAuthToggleCommand(
    scopeId: string,
    locale: AppLocale,
    args: string[],
    disabled: boolean,
  ): Promise<void> {
    const index = Number.parseInt(args[0] || '', 10);
    if (!Number.isFinite(index) || index < 1) {
      await this.sendMessage(scopeId, t(locale, 'usage_auth'));
      return;
    }
    const state = await this.listCodexAuthState();
    const candidate = state.candidates[index - 1];
    if (!candidate) {
      await this.sendMessage(scopeId, t(locale, 'auth_choice_expired'));
      await this.sendMessage(scopeId, renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(scopeId) !== null));
      return;
    }
    this.store.setCodexAuthCandidateDisabled(candidate.name, disabled, this.authRuntimeId());
    await this.sendMessage(scopeId, t(locale, disabled ? 'auth_candidate_disabled' : 'auth_candidate_enabled', {
      value: candidate.name,
    }));
  }

  private findLatestAuthChoiceList(scopeId: string): PendingAuthChoiceList | null {
    let latest: PendingAuthChoiceList | null = null;
    for (const record of this.pendingAuthChoiceLists.values()) {
      if (record.chatId !== scopeId) {
        continue;
      }
      if (!latest || record.createdAt > latest.createdAt) {
        latest = record;
      }
    }
    return latest;
  }

  private async handleAuthAddCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    if (this.hasLocalBlockingActivity()) {
      await this.sendMessage(scopeId, t(locale, 'auth_reload_blocked_active'));
      return;
    }

    const requestedName = args.join(' ').trim();
    const candidateName = codexAuthCandidateNameFromAddName(requestedName);
    if (!candidateName) {
      await this.sendMessage(scopeId, t(locale, 'usage_auth_add'));
      return;
    }

    const state = await this.listCodexAuthState();
    const targetPath = path.join(state.authDir, candidateName);
    const existing = await fs.stat(targetPath).catch(() => null);
    if (existing) {
      await this.sendMessage(scopeId, t(locale, 'auth_add_exists', { value: candidateName }));
      return;
    }

    await this.sendMessage(scopeId, t(locale, 'auth_add_preparing', { value: candidateName }));
    await pointCodexAuthAtTarget(state.authDir, state.authPath, targetPath);
    this.pendingTurnErrors.clear();
    this.attachedThreads.clear();
    try {
      await this.app.restart();
      const login = await this.app.startDeviceLogin();
      const oldLoginId = this.pendingLoginsByScope.get(scopeId);
      if (oldLoginId) {
        this.pendingLoginScopesById.delete(oldLoginId);
        this.pendingAuthAddsByLoginId.delete(oldLoginId);
      }
      this.pendingLoginsByScope.set(scopeId, login.loginId);
      this.pendingLoginScopesById.set(login.loginId, scopeId);
      this.pendingAuthAddsByLoginId.set(login.loginId, {
        loginId: login.loginId,
        scopeId,
        name: candidateName,
        path: targetPath,
        previousTargetPath: state.currentTargetPath,
        mode: 'add',
        createdAt: Date.now(),
      });
      this.scheduleAuthLoginRecovery(login.loginId);
      await this.sendMessage(scopeId, [
        t(locale, 'auth_add_started', { value: candidateName }),
        t(locale, 'login_device_prereq'),
        t(locale, 'login_url', { value: login.verificationUrl }),
        t(locale, 'login_code', { value: login.userCode }),
        t(locale, 'login_id', { value: login.loginId }),
        t(locale, 'login_cancel_hint', { value: login.loginId }),
      ].join('\n'), this.loginCancelKeyboard(login.loginId, locale));
    } catch (error) {
      await this.restoreAuthAfterAddFailure(state.authDir, state.authPath, state.currentTargetPath);
      throw error;
    }
  }

  private async startAuthRepairLogin(
    scopeId: string,
    locale: AppLocale,
    candidate: CodexAuthCandidate,
  ): Promise<void> {
    const state = await this.listCodexAuthState();
    const target = state.candidates.find(entry => entry.name === candidate.name) ?? null;
    if (!target) {
      await this.sendMessage(scopeId, t(locale, 'auth_choice_expired'));
      return;
    }

    await pointCodexAuthAtTarget(state.authDir, state.authPath, target.path);
    this.pendingTurnErrors.clear();
    this.attachedThreads.clear();
    try {
      await this.app.restart();
      const login = await this.app.startDeviceLogin();
      const oldLoginId = this.pendingLoginsByScope.get(scopeId);
      if (oldLoginId) {
        this.pendingLoginScopesById.delete(oldLoginId);
        this.pendingAuthAddsByLoginId.delete(oldLoginId);
      }
      this.pendingLoginsByScope.set(scopeId, login.loginId);
      this.pendingLoginScopesById.set(login.loginId, scopeId);
      this.pendingAuthAddsByLoginId.set(login.loginId, {
        loginId: login.loginId,
        scopeId,
        name: target.name,
        path: target.path,
        previousTargetPath: state.currentTargetPath,
        mode: 'repair',
        createdAt: Date.now(),
      });
      this.scheduleAuthLoginRecovery(login.loginId);
      await this.sendMessage(scopeId, [
        t(locale, 'auth_repair_started', { value: target.name }),
        t(locale, 'login_device_prereq'),
        t(locale, 'login_url', { value: login.verificationUrl }),
        t(locale, 'login_code', { value: login.userCode }),
        t(locale, 'login_id', { value: login.loginId }),
        t(locale, 'login_cancel_hint', { value: login.loginId }),
      ].join('\n'), this.loginCancelKeyboard(login.loginId, locale));
    } catch (error) {
      await this.restoreAuthAfterAddFailure(state.authDir, state.authPath, state.currentTargetPath);
      throw error;
    }
  }

  private async deleteCodexAuthCandidate(
    candidate: CodexAuthCandidate,
    reason: string | null = null,
  ): Promise<boolean> {
    const wasCurrent = candidate.isCurrent;
    const authDir = this.resolveAuthDir();
    const authPath = path.join(authDir, 'auth.json');
    let deletedByCoordinator = false;
    try {
      await this.coordinator?.authCandidateDeleted?.(this.authRuntimeId(), candidate.name, reason);
      deletedByCoordinator = Boolean(this.coordinator?.authCandidateDeleted);
    } catch (error) {
      this.logger.warn('codex.auth_candidate_delete_sync_failed', {
        candidate: candidate.name,
        runtimeId: this.authRuntimeId(),
        error: toErrorMeta(error),
      });
    }
    if (!deletedByCoordinator) {
      await fs.rm(candidate.path, { force: true }).catch(() => undefined);
      if (wasCurrent) {
        await fs.rm(authPath, { force: true }).catch(() => undefined);
      }
    }
    this.store.deleteCodexAuthCandidate(candidate.name);
    if (isInvalidCodexAuthDeleteReason(reason)) {
      this.store.recordCodexAuthCandidateInvalidDelete(candidate.name, reason);
    } else {
      this.store.recordCodexAuthCandidateRemoved(candidate.name, reason);
    }
    this.authRotationFailedTargets.delete(candidate.path);
    const snapshots = await this.readCodexAuthQuotaSnapshots();
    if (Object.prototype.hasOwnProperty.call(snapshots, candidate.name)) {
      delete snapshots[candidate.name];
      await this.writeCodexAuthQuotaSnapshots();
    }
    if (wasCurrent) {
      this.pendingTurnErrors.clear();
      this.attachedThreads.clear();
      await this.app.restart();
    }
    return wasCurrent;
  }

  private async handleAccountCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const account = await this.app.readAccount();
    const lines = [
      t(locale, 'account_title'),
      account
        ? t(locale, 'account_current', {
            value: [
              formatCodexAccountLabel(account),
              account.email,
              account.planType ? formatPlanTypeLabel(account.planType) : null,
            ].filter(Boolean).join(' · '),
          })
        : t(locale, 'account_not_signed_in'),
    ];
    lines.push(...await this.buildCodexUsageStatusLines(locale));
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleQuotaCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const lines = [t(locale, 'quota_title')];
    lines.push(...await this.buildCodexUsageStatusLines(locale));
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleQuotaNudgeCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const creditType = args[0] === 'usage_limit' ? 'usage_limit' : args[0] === 'credits' ? 'credits' : null;
    if (!creditType || args[1] !== 'confirm') {
      await this.sendMessage(scopeId, t(locale, 'usage_quota_nudge'));
      return;
    }
    await this.app.sendAddCreditsNudgeEmail(creditType);
    await this.sendMessage(scopeId, t(locale, 'quota_nudge_sent'));
  }

  private async handleVoiceCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    if (args[0]?.toLowerCase() === 'file' || args[0]?.toLowerCase() === 'send') {
      await this.handleVoiceFileCommand(scopeId, locale, args.slice(1));
      return;
    }
    const raw = args.join(' ').trim();
    const snippetId = raw.toLowerCase() === 'last' ? this.latestVoiceSnippetByScope.get(scopeId) ?? null : null;
    const text = snippetId ? this.voiceSnippets.get(snippetId)?.text ?? '' : raw;
    if (!text) {
      await this.sendMessage(scopeId, locale === 'zh' ? '用法：/voice 要朗读的文本，或 /voice last' : 'Usage: /voice text to read, or /voice last');
      return;
    }
    await this.sendVoiceForText(scopeId, locale, text);
  }

  private async handleVoiceFileCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    if (scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      await this.sendMessage(scopeId, locale === 'zh' ? '当前只有 Telegram 支持语音消息。' : 'Voice messages are currently supported only on Telegram.');
      return;
    }
    const fileArg = args[0]?.trim();
    if (!fileArg) {
      await this.sendMessage(scopeId, locale === 'zh'
        ? '用法：/voice file /path/to/audio.ogg [说明]'
        : 'Usage: /voice file /path/to/audio.ogg [caption]');
      return;
    }
    const filePath = path.resolve(this.config.defaultCwd, fileArg);
    const contentType = telegramVoiceContentType(filePath);
    if (!contentType) {
      await this.sendMessage(scopeId, locale === 'zh'
        ? '只支持作为 Telegram voice 发送的音频格式：.ogg、.opus、.oga、.mp3、.m4a。'
        : `Supported Telegram voice file formats: ${TELEGRAM_VOICE_SUPPORTED_EXTENSIONS}.`);
      return;
    }
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      await this.sendMessage(scopeId, locale === 'zh' ? `找不到音频文件：${filePath}` : `Audio file not found: ${filePath}`);
      return;
    }
    if (stat.size > TELEGRAM_VOICE_MAX_BYTES) {
      await this.sendMessage(scopeId, locale === 'zh' ? 'Telegram voice 文件不能超过 50MB。' : 'Telegram voice files must be 50MB or smaller.');
      return;
    }
    try {
      const contents = await fs.readFile(filePath);
      const caption = args.slice(1).join(' ').trim() || (locale === 'zh' ? 'FoxClaw 语音文件' : 'FoxClaw voice file');
      await this.messaging.sendVoice(scopeId, path.basename(filePath), contents, caption, contentType);
    } catch (error) {
      this.logger.warn('voice.file_send_failed', { scopeId, filePath, error: toErrorMeta(error) });
      await this.sendMessage(scopeId, locale === 'zh'
        ? `语音文件发送失败：${formatUserError(error)}`
        : `Voice file send failed: ${formatUserError(error)}`);
    }
  }

  private async handleVoiceCallback(event: TelegramCallbackEvent, localId: string, locale: AppLocale): Promise<void> {
    const snippet = this.voiceSnippets.get(localId);
    if (!snippet || snippet.scopeId !== event.scopeId) {
      await this.messaging.answerCallback(event.callbackQueryId, locale === 'zh' ? '这条总结语音已过期' : 'This voice summary has expired');
      return;
    }
    await this.messaging.answerCallback(event.callbackQueryId, locale === 'zh' ? '正在生成语音...' : 'Generating voice...');
    await this.sendVoiceForText(event.scopeId, locale, snippet.text);
  }

  private async sendVoiceForText(scopeId: string, locale: AppLocale, text: string): Promise<void> {
    if (scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      await this.sendMessage(scopeId, locale === 'zh' ? '当前只有 Telegram 支持语音消息。' : 'Voice messages are currently supported only on Telegram.');
      return;
    }
    if (!this.config.voiceTtsEnabled) {
      await this.sendMessage(scopeId, locale === 'zh' ? '语音服务未启用。' : 'Voice TTS is not enabled.');
      return;
    }
    try {
      const voice = await synthesizeTelegramVoice(text, this.config);
      await this.messaging.sendVoice(scopeId, voice.filename, voice.contents, locale === 'zh' ? 'FoxClaw 总结语音' : 'FoxClaw voice summary');
    } catch (error) {
      this.logger.warn('voice.summary_failed', { scopeId, error: toErrorMeta(error) });
      await this.sendMessage(scopeId, locale === 'zh'
        ? `语音生成失败：${formatUserError(error)}`
        : `Voice generation failed: ${formatUserError(error)}`);
    }
  }

  private async handleLoginDeviceCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const pendingLoginId = this.pendingLoginsByScope.get(scopeId);
    if (pendingLoginId) {
      await this.sendMessage(scopeId, t(locale, 'login_cancel_hint', { value: pendingLoginId }), this.loginCancelKeyboard(pendingLoginId, locale));
      return;
    }
    const login = await this.app.startDeviceLogin();
    const oldLoginId = this.pendingLoginsByScope.get(scopeId);
    if (oldLoginId) {
      this.pendingLoginScopesById.delete(oldLoginId);
    }
    this.pendingLoginsByScope.set(scopeId, login.loginId);
    this.pendingLoginScopesById.set(login.loginId, scopeId);
    await this.sendMessage(scopeId, [
      t(locale, 'login_device_started'),
      t(locale, 'login_device_prereq'),
      t(locale, 'login_url', { value: login.verificationUrl }),
      t(locale, 'login_code', { value: login.userCode }),
      t(locale, 'login_id', { value: login.loginId }),
      t(locale, 'login_cancel_hint', { value: login.loginId }),
    ].join('\n'), this.loginCancelKeyboard(login.loginId, locale));
  }

  private loginCancelKeyboard(loginId: string, locale: AppLocale): Array<Array<{ text: string; callback_data: string }>> {
    return [[{ text: t(locale, 'button_cancel'), callback_data: `login:cancel:${loginId}` }]];
  }

  private async handleLoginCancelCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const loginId = args[0]?.trim() || this.pendingLoginsByScope.get(scopeId) || null;
    if (!loginId || this.pendingLoginsByScope.get(scopeId) !== loginId) {
      await this.sendMessage(scopeId, t(locale, 'login_cancel_no_pending'));
      return;
    }
    const pendingAuthAdd = this.pendingAuthAddsByLoginId.get(loginId) ?? null;
    // Claim cancellation before awaiting RPC: completion notifications may arrive first.
    this.pendingLoginsByScope.delete(scopeId);
    this.pendingLoginScopesById.delete(loginId);
    this.pendingAuthAddsByLoginId.delete(loginId);
    let cancelError: unknown;
    try {
      await this.app.cancelLogin(loginId);
    } catch (error) {
      cancelError = error;
      this.logger.warn('codex.login_cancel_failed', { error: toErrorMeta(error) });
    }
    if (pendingAuthAdd) {
      await this.restorePendingAuthAdd(pendingAuthAdd);
      await this.sendMessage(scopeId, t(locale, 'auth_add_cancelled'));
      return;
    }
    if (cancelError) {
      await this.sendMessage(scopeId, locale === 'zh'
        ? '已退出本地登录流程，但未能确认服务端取消。请勿继续使用旧验证码；可重新登录或用 /codex_restart 重置登录服务。'
        : 'Local login flow cleared, but server cancellation is unconfirmed. Do not use the old code; start a new login or use /codex_restart.');
      return;
    }
    await this.sendMessage(scopeId, t(locale, 'login_cancelled'));
  }

  private async handleLogoutCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    if (args[0] !== 'confirm') {
      await this.sendMessage(scopeId, t(locale, 'usage_logout'));
      return;
    }
    await this.app.logoutAccount();
    await this.sendMessage(scopeId, t(locale, 'logout_done'));
  }

  private async handleSteerCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    const text = args.join(' ').trim();
    if (!text) {
      await this.sendMessage(scopeId, t(locale, 'usage_steer'));
      return;
    }
    const active = this.findActiveTurn(scopeId);
    if (!active) {
      await this.sendMessage(scopeId, t(locale, 'no_active_turn'));
      return;
    }
    if (active.isObserved) {
      await this.sendMessage(scopeId, t(locale, 'watch_read_only_active'));
      return;
    }
    await this.app.steerTurn(active.threadId, active.turnId, [{
      type: 'text',
      text,
      text_elements: [],
    }]);
    await this.sendMessage(scopeId, t(locale, 'steer_sent', { turnId: active.turnId }));
  }

  private async handleForkCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    if (this.findActiveTurn(scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'wait_current_turn'));
      return;
    }
    const binding = await this.requireReadyBinding(scopeId, locale);
    if (!binding) return;
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    const session = await this.app.forkThread({
      threadId: binding.threadId,
      cwd: binding.cwd ?? this.config.defaultCwd,
      approvalPolicy: access.approvalPolicy,
      sandboxMode: access.sandboxMode,
      model: settings?.model ?? null,
      serviceTier: settings?.serviceTier ?? null,
    });
    const forkBinding = this.storeThreadSession(scopeId, session, 'replace');
    const requestedName = args.join(' ').trim();
    if (requestedName) {
      await this.app.setThreadName(forkBinding.threadId, requestedName);
    }
    await this.sendMessage(scopeId, t(locale, 'thread_forked', { threadId: forkBinding.threadId }));
  }

  private async handleRollbackCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    if (this.findActiveTurn(scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'wait_current_turn'));
      return;
    }
    const binding = await this.requireReadyBinding(scopeId, locale);
    if (!binding) return;
    const count = Number.parseInt(args[0] || '1', 10);
    if (!Number.isFinite(count) || count < 1) {
      await this.sendMessage(scopeId, t(locale, 'usage_rollback'));
      return;
    }
    if (count > 1 && args[1] !== 'confirm') {
      await this.sendMessage(scopeId, t(locale, 'rollback_confirm_required', { count }));
      return;
    }
    await this.app.rollbackThread(binding.threadId, count);
    await this.sendMessage(scopeId, t(locale, 'rollback_done', { count }));
  }

  private async handleRenameCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.sendMessage(scopeId, t(locale, 'usage_rename'));
      return;
    }
    const binding = await this.requireReadyBinding(scopeId, locale);
    if (!binding) return;
    await this.app.setThreadName(binding.threadId, name);
    await this.sendMessage(scopeId, t(locale, 'rename_done', { name }));
  }

  private async handleCompactCommand(event: TelegramTextEvent, locale: AppLocale): Promise<void> {
    if (this.findActiveTurn(event.scopeId)) {
      await this.sendMessage(event.scopeId, t(locale, 'wait_current_turn'));
      return;
    }
    const binding = await this.requireReadyBinding(event.scopeId, locale);
    if (!binding) return;
    await this.app.compactThread(binding.threadId);
    await this.sendMessage(event.scopeId, t(locale, 'compact_started'));
  }

  private async handleArchiveCommand(scopeId: string, locale: AppLocale): Promise<void> {
    if (this.findActiveTurn(scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'wait_current_turn'));
      return;
    }
    const binding = this.store.getBinding(scopeId);
    if (!binding) {
      await this.sendMessage(scopeId, t(locale, 'watch_no_thread_bound'));
      return;
    }
    await this.stopWatchingScopeThread(scopeId);
    await this.app.archiveThread(binding.threadId);
    this.store.clearBinding(scopeId);
    this.attachedThreads.delete(attachedThreadKey(scopeId, binding.threadId));
    await this.sendMessage(scopeId, t(locale, 'archive_done', { threadId: binding.threadId }));
  }

  private async handleUnarchiveCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const index = Number.parseInt(args[0] || '', 10);
    if (!Number.isFinite(index)) {
      await this.sendMessage(scopeId, t(locale, 'usage_unarchive'));
      return;
    }
    const cached = this.store.getCachedThread(scopeId, index);
    if (!cached || !cached.archived) {
      await this.sendMessage(scopeId, t(locale, 'unknown_cached_thread'));
      return;
    }
    await this.app.unarchiveThread(cached.threadId);
    const binding = await this.bindCachedThread(scopeId, cached.threadId);
    await this.sendMessage(scopeId, t(locale, 'unarchive_done', { threadId: binding.threadId }));
  }

  private async handleReviewCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    if (this.findActiveTurn(event.scopeId)) {
      await this.sendMessage(event.scopeId, t(locale, 'wait_current_turn'));
      return;
    }
    const binding = await this.requireReadyBinding(event.scopeId, locale);
    if (!binding) return;
    const target = parseReviewTarget(args);
    if (!target) {
      await this.sendMessage(event.scopeId, t(locale, 'usage_review'));
      return;
    }
    const result = await this.app.startReview(binding.threadId, target, 'inline');
    await this.sendMessage(event.scopeId, t(locale, 'review_started', { turnId: result.turnId || t(locale, 'unknown') }));
    if (result.turnId) {
      await this.registerActiveTurn(
        event.scopeId,
        event.chatId,
        event.chatType,
        event.topicId,
        result.reviewThreadId,
        result.turnId,
        0,
      );
    }
  }

  private async handleRichCommand(scopeId: string, locale: AppLocale): Promise<void> {
    await this.sendRichHtmlMessage(
      scopeId,
      formatRichDemoMessage(locale),
      formatRichDemoFallbackMessage(locale),
    );
  }

  private async handleDiffCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const diff = this.latestTurnDiffs.get(scopeId);
    if (!diff?.diff.trim()) {
      await this.sendMessage(scopeId, t(locale, 'diff_unavailable'));
      return;
    }
    await this.sendRichHtmlMessage(
      scopeId,
      formatRichDiffMessage(locale, diff.diff),
      formatDiffMessage(locale, diff.diff),
    );
  }

  private async handleLoadedCommand(scopeId: string, locale: AppLocale): Promise<void> { return this.nativePanels.handleLoadedCommand(scopeId, locale); }

  private async handleSkillsCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> { return this.nativePanels.handleSkillsCommand(scopeId, locale, args); }

  private async handleSkillCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> { return this.nativePanels.handleSkillCommand(scopeId, locale, args); }

  private async handleSkillConfigCommand(scopeId: string, locale: AppLocale, args: string[], enabled: boolean): Promise<void> { return this.nativePanels.handleSkillConfigCommand(scopeId, locale, args, enabled); }

  private async handleHooksCommand(scopeId: string, locale: AppLocale): Promise<void> { return this.nativePanels.handleHooksCommand(scopeId, locale); }

  private async handlePluginsCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> { return this.nativePanels.handlePluginsCommand(scopeId, locale, args); }

  private async handlePluginCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> { return this.nativePanels.handlePluginCommand(scopeId, locale, args); }

  private async handlePluginSkillCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> { return this.nativePanels.handlePluginSkillCommand(scopeId, locale, args); }

  private async handleAppsCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> { return this.nativePanels.handleAppsCommand(scopeId, locale, args); }

  private async handleFeaturesCommand(scopeId: string, locale: AppLocale): Promise<void> { return this.nativePanels.handleFeaturesCommand(scopeId, locale); }

  private async handleConfigCommand(scopeId: string, locale: AppLocale, args: string[] = []): Promise<void> { return this.nativePanels.handleConfigCommand(scopeId, locale, args); }

  private async handleConfigToggleCallback(
    event: TelegramCallbackEvent,
    key: 'auth_auto_delete' | 'delete_tool_details',
    enabled: boolean,
    locale: AppLocale,
  ): Promise<void> { return this.nativePanels.handleConfigToggleCallback(event, key, enabled, locale); }

  private async setFoxClawBooleanConfig(
    key: 'auth_auto_delete' | 'delete_tool_details',
    enabled: boolean,
  ): Promise<{ key: 'auth_auto_delete' | 'delete_tool_details'; enabled: boolean; envKey: string; envPath: string | null; envUpdated: boolean; envError: string | null }> { return this.nativePanels.setFoxClawBooleanConfig(key, enabled); }

  private formatConfigToggleUpdate(
    locale: AppLocale,
    update: { key: 'auth_auto_delete' | 'delete_tool_details'; enabled: boolean; envPath: string | null; envUpdated: boolean; envError: string | null },
  ): string { return this.nativePanels.formatConfigToggleUpdate(locale, update); }

  private async handleRequirementsCommand(scopeId: string, locale: AppLocale): Promise<void> { return this.nativePanels.handleRequirementsCommand(scopeId, locale); }

  private async handleProviderCommand(scopeId: string, locale: AppLocale): Promise<void> { return this.nativePanels.handleProviderCommand(scopeId, locale); }

  private async handleMcpCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> { return this.nativePanels.handleMcpCommand(scopeId, locale, args); }

  private async handleMcpReloadCommand(scopeId: string, locale: AppLocale): Promise<void> { return this.nativePanels.handleMcpReloadCommand(scopeId, locale); }

  private async handleMcpLoginCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> { return this.nativePanels.handleMcpLoginCommand(scopeId, locale, args); }

  private async handleMcpResourceCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> { return this.nativePanels.handleMcpResourceCommand(scopeId, locale, args); }

  private async listSkillsForScope(scopeId: string, forceReload: boolean): Promise<CodexSkillsListEntry[]> { return this.nativePanels.listSkillsForScope(scopeId, forceReload); }

  private async requireReadyBinding(scopeId: string, locale: AppLocale): Promise<ThreadBinding | null> {
    const binding = this.store.getBinding(scopeId);
    if (!binding) {
      await this.sendMessage(scopeId, t(locale, 'watch_no_thread_bound'));
      return null;
    }
    return this.ensureThreadReady(scopeId, binding);
  }

  private async handleAuthPanelActionCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: 'login_device' | 'reload' | 'safe_sync' | 'cluster_audit' | 'refresh_all' | 'refresh_all_confirm' | 'refresh_all_cancel',
    locale: AppLocale,
  ): Promise<void> {
    const record = this.pendingAuthChoiceLists.get(localId);
    if (!record) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_expired'));
      return;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_mismatch'));
      return;
    }
    if (action === 'login_device') {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'login_device_started'));
      await this.handleLoginDeviceCommand(event.scopeId, locale);
      return;
    }
    if (action === 'safe_sync') {
      if (!this.canRunGlobalAuthRefresh()) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_sync_push_blocked_active'));
        return;
      }
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_sync_safe_starting'));
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(event.scopeId, record.messageId, t(locale, 'auth_sync_safe_starting'), []);
      }
      if (record.messageId !== null) {
        this.pauseStalePanelDeletion(event.scopeId, record.messageId);
      }
      let outcome: CodexAuthClusterAuditOutcome | null;
      try {
        outcome = await this.runAuthClusterAudit();
      } catch (error) {
        if (record.messageId !== null) {
          await this.editAuthPanelMessage(
            event.scopeId,
            record.messageId,
            t(locale, 'auth_cluster_audit_failed', { error: formatUserError(error) }),
            authChoiceKeyboard(locale, record),
          );
        }
        return;
      }
      if (!outcome) {
        if (record.messageId !== null) {
          await this.editAuthPanelMessage(
            event.scopeId,
            record.messageId,
            t(locale, 'auth_sync_disabled'),
            authChoiceKeyboard(locale, record),
          );
        }
        return;
      }
      const state = await this.listCodexAuthState();
      await this.applySharedCodexAuthQuotaSnapshots(state);
      record.candidates = state.candidates;
      record.createdAt = Date.now();
      clampCodexAuthListOffset(record);
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(
          event.scopeId,
          record.messageId,
          `${formatAuthClusterAuditResult(locale, outcome)}\n\n${renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record)}`,
          authChoiceKeyboard(locale, record),
        );
      }
      return;
    }
    if (action === 'cluster_audit') {
      if (!this.canRunGlobalAuthRefresh()) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_cluster_audit_blocked_active'));
        return;
      }
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_cluster_audit_starting'));
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(event.scopeId, record.messageId, t(locale, 'auth_cluster_audit_starting'), []);
        this.pauseStalePanelDeletion(event.scopeId, record.messageId);
      }
      let outcome: CodexAuthClusterAuditOutcome | null;
      try {
        outcome = await this.runAuthClusterAudit();
      } catch (error) {
        if (record.messageId !== null) {
          await this.editAuthPanelMessage(
            event.scopeId,
            record.messageId,
            t(locale, 'auth_cluster_audit_failed', { error: formatUserError(error) }),
            authChoiceKeyboard(locale, record),
          );
        }
        return;
      }
      if (!outcome) {
        if (record.messageId !== null) {
          await this.editAuthPanelMessage(event.scopeId, record.messageId, t(locale, 'auth_sync_disabled'), authChoiceKeyboard(locale, record));
        }
        return;
      }
      const state = await this.listCodexAuthState();
      await this.applySharedCodexAuthQuotaSnapshots(state);
      record.candidates = state.candidates;
      record.createdAt = Date.now();
      clampCodexAuthListOffset(record);
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(
          event.scopeId,
          record.messageId,
          `${formatAuthClusterAuditResult(locale, outcome)}\n\n${renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record)}`,
          authChoiceKeyboard(locale, record),
        );
      }
      return;
    }
    if (action === 'refresh_all') {
      if (!this.canRunGlobalAuthRefresh()) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_refresh_all_blocked_active'));
        return;
      }
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_refresh_all_confirm_short'));
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(
          event.scopeId,
          record.messageId,
          t(locale, 'auth_refresh_all_confirm_message'),
          authRefreshAllConfirmKeyboard(locale, record),
        );
      }
      return;
    }
    if (action === 'refresh_all_cancel') {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_refresh_all_cancelled'));
      const state = await this.listCodexAuthState();
      await this.applySharedCodexAuthQuotaSnapshots(state);
      record.candidates = state.candidates;
      record.createdAt = Date.now();
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(
          event.scopeId,
          record.messageId,
          renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record),
          authChoiceKeyboard(locale, record),
        );
      }
      return;
    }
    if (action === 'refresh_all_confirm') {
      if (!this.canRunGlobalAuthRefresh()) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_refresh_all_blocked_active'));
        return;
      }
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_refresh_all_starting'));
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(event.scopeId, record.messageId, t(locale, 'auth_refresh_all_starting'), []);
      }
      const lease = await this.coordinator?.acquireAuthRefreshLease?.('auth refresh all');
      if (lease && !lease.ok) {
        if (record.messageId !== null) {
          await this.editAuthPanelMessage(
            event.scopeId,
            record.messageId,
            t(locale, 'auth_refresh_all_lease_failed', { error: lease.reason ?? t(locale, 'unknown') }),
            authChoiceKeyboard(locale, record),
          );
        }
        return;
      }
      let result: CodexAuthRefreshAllResult;
      try {
        result = await this.refreshAllCodexAuthCandidates();
      } finally {
        await this.coordinator?.releaseAuthRefreshLease?.(lease?.leaseId ?? null);
      }
      const state = await this.listCodexAuthState();
      await this.applySharedCodexAuthQuotaSnapshots(state);
      record.candidates = state.candidates;
      record.createdAt = Date.now();
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(
          event.scopeId,
          record.messageId,
          `${formatAuthRefreshAllResult(locale, result)}\n\n${renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record)}`,
          authChoiceKeyboard(locale, record),
        );
      }
      return;
    }
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_reload_restarting'));
    await this.handleAuthReloadCommand(event.scopeId, locale);
  }

  private async handleAuthListViewCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: 'prev' | 'next' | 'clear_search' | CodexAuthListFilter,
    locale: AppLocale,
  ): Promise<void> {
    const record = this.pendingAuthChoiceLists.get(localId);
    if (!record) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_expired'));
      return;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_mismatch'));
      return;
    }
    if (action === 'prev') {
      record.offset = Math.max(0, record.offset - record.pageSize);
    } else if (action === 'next') {
      record.offset += record.pageSize;
    } else if (action === 'clear_search') {
      record.searchTerm = null;
      record.offset = 0;
    } else {
      record.filter = action;
      record.offset = 0;
    }
    const state = await this.listCodexAuthState();
    record.candidates = state.candidates;
    record.createdAt = Date.now();
    clampCodexAuthListOffset(record);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    if (record.messageId !== null) {
      await this.editAuthPanelMessage(
        event.scopeId,
        record.messageId,
        renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record),
        authChoiceKeyboard(locale, record),
      );
    }
  }

  private async refreshRepairedAuthChoice(
    event: TelegramCallbackEvent,
    record: PendingAuthChoiceList,
    candidateName: string,
    locale: AppLocale,
  ): Promise<boolean> {
    const state = await this.listCodexAuthState();
    if (state.candidates.find(candidate => candidate.name === candidateName)?.state === 'needs_repair') return false;
    record.candidates = state.candidates;
    record.createdAt = Date.now();
    clampCodexAuthListOffset(record);
    await this.messaging.answerCallback(event.callbackQueryId, locale === 'zh'
      ? '授权状态已变化，已刷新面板。' : 'Auth state changed; panel refreshed.');
    if (record.messageId !== null) {
      await this.editAuthPanelMessage(event.scopeId, record.messageId,
        renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record),
        authChoiceKeyboard(locale, record));
    }
    return true;
  }

  private async handleAuthRepairMenuCallback(
    event: TelegramCallbackEvent,
    localId: string,
    index: number,
    locale: AppLocale,
  ): Promise<void> {
    const record = this.pendingAuthChoiceLists.get(localId);
    if (!record) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_expired'));
      return;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_mismatch'));
      return;
    }
    const candidate = record.candidates[index];
    if (!candidate) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    if (await this.refreshRepairedAuthChoice(event, record, candidate.name, locale)) return;
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_repair_actions_short'));
    if (record.messageId !== null) {
      await this.editAuthPanelMessage(
        event.scopeId,
        record.messageId,
        t(locale, 'auth_repair_actions_message', { value: formatCodexAuthCandidateDisplayName(candidate.name) }),
        authRepairKeyboard(locale, record, index),
      );
    }
  }

  private async handleAuthRepairActionCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: 'login' | 'delete' | 'cancel',
    index: number,
    locale: AppLocale,
  ): Promise<void> {
    const record = this.pendingAuthChoiceLists.get(localId);
    if (!record) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_expired'));
      return;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_mismatch'));
      return;
    }
    const candidate = record.candidates[index];
    if (!candidate) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    if (action !== 'cancel' && await this.refreshRepairedAuthChoice(event, record, candidate.name, locale)) return;
    if (action === 'cancel') {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
      const state = await this.listCodexAuthState();
      record.candidates = state.candidates;
      record.createdAt = Date.now();
      clampCodexAuthListOffset(record);
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(
          event.scopeId,
          record.messageId,
          renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record),
          authChoiceKeyboard(locale, record),
        );
      }
      return;
    }
    if (this.hasLocalBlockingActivity()) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_reload_blocked_active'));
      return;
    }
    if (action === 'login') {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'login_device_started'));
      if (record.messageId !== null) {
        await this.editAuthPanelMessage(
          event.scopeId,
          record.messageId,
          t(locale, 'auth_repair_login_preparing', { value: candidate.name }),
          [],
        );
      }
      await this.startAuthRepairLogin(event.scopeId, locale, candidate);
      return;
    }

    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_candidate_deleted_short'));
    const restarted = await this.deleteCodexAuthCandidate(candidate);
    const state = await this.listCodexAuthState();
    record.candidates = state.candidates;
    record.createdAt = Date.now();
    clampCodexAuthListOffset(record);
    if (record.messageId !== null) {
      await this.editAuthPanelMessage(
        event.scopeId,
        record.messageId,
        `${t(locale, 'auth_candidate_deleted', { value: candidate.name })}${restarted ? `\n${t(locale, 'auth_delete_current_restarted')}` : ''}\n\n${renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record)}`,
        authChoiceKeyboard(locale, record),
      );
    }
  }

  private async handleAuthToggleCallback(
    event: TelegramCallbackEvent,
    localId: string,
    index: number,
    locale: AppLocale,
  ): Promise<void> {
    const record = this.pendingAuthChoiceLists.get(localId);
    if (!record) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_expired'));
      return;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_mismatch'));
      return;
    }
    const candidate = record.candidates[index];
    if (!candidate) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    const disabled = !candidate.disabled;
    this.store.setCodexAuthCandidateDisabled(candidate.name, disabled, this.authRuntimeId());
    const state = await this.listCodexAuthState();
    record.candidates = state.candidates;
    clampCodexAuthListOffset(record);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, disabled ? 'auth_candidate_disabled_short' : 'auth_candidate_enabled_short'));
    if (record.messageId !== null) {
      await this.editAuthPanelMessage(
        event.scopeId,
        record.messageId,
        renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record),
        authChoiceKeyboard(locale, record),
      );
    }
  }

  private async handleAuthSwitchCallback(
    event: TelegramCallbackEvent,
    localId: string,
    index: number,
    locale: AppLocale,
  ): Promise<void> {
    const record = this.pendingAuthChoiceLists.get(localId);
    if (!record) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_expired'));
      return;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_mismatch'));
      return;
    }
    if (this.hasLocalBlockingActivity()) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_reload_blocked_active'));
      return;
    }
    const candidate = record.candidates[index];
    if (!candidate) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    if (candidate.state === 'needs_repair') {
      await this.handleAuthRepairMenuCallback(event, localId, index, locale);
      return;
    }

    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_recorded'));
    const switchLabels = await this.readCodexAuthSwitchLabels(candidate);
    const switchingMessage = t(locale, 'auth_switching', this.codexAuthSwitchParams(locale, switchLabels.fromLabel, switchLabels.toLabel));
    if (record.messageId !== null) {
      await this.editAuthPanelMessage(event.scopeId, record.messageId, switchingMessage, []);
    }
    const outcome = await this.switchCodexAuthAndRestart(event.scopeId, locale, candidate, false, false);
    const state = await this.listCodexAuthState();
    record.candidates = state.candidates;
    record.createdAt = Date.now();
    clampCodexAuthListOffset(record);
    if (record.messageId !== null) {
      await this.editAuthPanelMessage(
        event.scopeId,
        record.messageId,
        [
          ...this.formatAuthSwitchValidationLines(locale, outcome),
          renderAuthListMessage(locale, state, this.authDisplayBotLabel(), parseWeixinBridgeScope(event.scopeId) !== null, record),
        ].filter(Boolean).join('\n\n'),
        authChoiceKeyboard(locale, record),
      );
    }
  }

  private async maybeRunPendingAuthRotation(): Promise<boolean> {
    if (!this.pendingAuthRotation || this.authRotationInProgress) {
      return false;
    }
    if (this.hasLocalBlockingActivity()) {
      return false;
    }

    const rotation = this.pendingAuthRotation;
    this.pendingAuthRotation = null;
    this.authRotationInProgress = true;
    try {
      const failedTargets = rotation.retry?.failedAuthTargets ?? this.authRotationFailedTargets;
      const locale = this.localeForChat(rotation.scopeId);
      const current = (await this.listCodexAuthState()).candidates.find(candidate => candidate.isCurrent) ?? null;
      if (current && rotation.reasonKind === 'auth_invalid') {
        const recoveredCurrent = await this.recoverCodexAuthCandidate(current.name);
        if (recoveredCurrent) {
          await this.sendMessage(rotation.scopeId, t(locale, 'auth_auto_recovered_current', {
            value: current.name,
            error: formatShortStatusError(rotation.reason),
          }));
          this.pendingTurnErrors.clear();
          this.attachedThreads.clear();
          await this.app.restart();
          await this.syncCodexAuthCandidate(current.name);
          if (rotation.retry) {
            await this.retryTurnAfterAuthRotation(rotation.scopeId, locale, rotation.retry);
            return true;
          }
          return false;
        }
        const disposition = await this.markCodexAuthCandidateNeedsRepair(current.name);
        if (disposition.deleted) {
          await this.sendMessage(rotation.scopeId, formatCodexAuthPoolSummary(locale, this.store.getCodexAuthPoolStats()));
        }
      }
      while (true) {
        const selection = await this.selectNextCodexAuthCandidate(failedTargets);
        if (!selection) {
          await this.sendMessage(rotation.scopeId, t(locale, rotation.reasonKind === 'quota_limited' ? 'auth_quota_no_candidate' : 'auth_auto_no_candidate', {
            error: formatShortStatusError(rotation.reason),
          }));
          return false;
        }
        const { candidate, fromLabel, toLabel } = selection;
        const switchingKey = rotation.reasonKind === 'quota_limited'
          ? (this.config.authAutoDeleteNeedsRepair ? 'auth_quota_switching_quiet' : 'auth_quota_switching')
          : (this.config.authAutoDeleteNeedsRepair ? 'auth_auto_switching_quiet' : 'auth_auto_switching');
        await this.sendMessage(rotation.scopeId, this.config.authAutoDeleteNeedsRepair
          ? t(locale, switchingKey, { error: formatShortStatusError(rotation.reason) })
          : t(locale, switchingKey, {
            ...this.codexAuthSwitchParams(locale, fromLabel, toLabel),
            error: formatShortStatusError(rotation.reason),
          }));
        const outcome = await this.switchCodexAuthAndRestart(rotation.scopeId, locale, candidate, true, true, rotation.reasonKind);
        if (!outcome.ok) {
          failedTargets.add(candidate.path);
          continue;
        }
        if (rotation.retry) {
          await this.retryTurnAfterAuthRotation(rotation.scopeId, locale, rotation.retry);
          return true;
        }
        return false;
      }
    } catch (error) {
      await this.handleAsyncError('codex.auth_rotation', error, rotation.scopeId);
      return false;
    } finally {
      this.authRotationInProgress = false;
    }
  }

  private async retryTurnAfterAuthRotation(
    scopeId: string,
    locale: AppLocale,
    retry: AuthRetryContext,
  ): Promise<void> {
    await this.sendMessage(scopeId, t(locale, 'auth_auto_retrying'));
    const binding: ThreadBinding = {
      chatId: scopeId,
      threadId: retry.threadId,
      cwd: retry.cwd,
      updatedAt: Date.now(),
    };
    let turn: { threadId: string; turnId: string; collaborationMode: CollaborationModeValue };
    try {
      const readyBinding = await this.ensureThreadReady(scopeId, binding, {
        recoverMissingThread: false,
      });
      turn = await this.startTurnWithRecovery(scopeId, readyBinding, retry.input, {
        collaborationMode: retry.collaborationMode,
        recoverMissingThread: false,
      });
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        await this.sendMessage(scopeId, t(locale, 'auth_auto_retry_thread_missing', { threadId: retry.threadId }));
        return;
      }
      throw error;
    }
    const target = resolveScopeMessageTarget(scopeId) ?? {
      chatId: retry.chatId,
      chatType: retry.chatType,
      topicId: retry.topicId,
    };
    await this.registerActiveTurn(
      scopeId,
      target.chatId,
      target.chatType,
      target.topicId,
      turn.threadId,
      turn.turnId,
      0,
      {
        ...retry,
        threadId: turn.threadId,
        cwd: this.store.getBinding(scopeId)?.cwd ?? retry.cwd,
        chatId: target.chatId,
        chatType: target.chatType,
        topicId: target.topicId,
        collaborationMode: turn.collaborationMode,
        failedAuthTargets: new Set(retry.failedAuthTargets),
      },
      turn.collaborationMode,
    );
  }

  private async selectNextCodexAuthCandidate(failedTargets: Set<string>): Promise<CodexAuthSelection | null> {
    const state = await this.listCodexAuthState();
    if (state.currentTargetPath) {
      failedTargets.add(state.currentTargetPath);
    }
    const candidates = state.candidates.filter(candidate =>
      !candidate.disabled
      && candidate.state !== 'needs_repair'
      && !failedTargets.has(candidate.path));
    if (candidates.length === 0) {
      return null;
    }

    const currentIndex = state.currentTargetPath
      ? state.candidates.findIndex(candidate => candidate.path === state.currentTargetPath)
      : -1;
    for (let offset = 1; offset <= state.candidates.length; offset += 1) {
      const candidate = state.candidates[(currentIndex + offset + state.candidates.length) % state.candidates.length];
      if (
        candidate
        && !candidate.disabled
        && candidate.state !== 'needs_repair'
        && !failedTargets.has(candidate.path)
      ) {
        return { candidate, fromLabel: state.currentLabel, toLabel: await authPathDisplayLabel(candidate.path) };
      }
    }
    const candidate = candidates[0] ?? null;
    return candidate ? { candidate, fromLabel: state.currentLabel, toLabel: await authPathDisplayLabel(candidate.path) } : null;
  }

  private async listCodexAuthState(): Promise<CodexAuthState> {
    const state = await listCodexAuthState(
      this.store.listDisabledCodexAuthCandidateNames(this.authRuntimeId()),
      this.store.listCodexAuthCandidateStates(this.authRuntimeId()),
      this.resolveAuthDir(),
    );
    this.store.recordCodexAuthPoolInventory(state.candidates.map(candidate => candidate.name));
    const snapshots = await this.readCodexAuthQuotaSnapshots();
    const candidateQuotaIdentities = await this.readCodexAuthCandidateQuotaIdentities(state.candidates);
    state.candidates.forEach((candidate) => {
      const candidateQuotaIdentity = candidateQuotaIdentities.get(candidate.name) ?? null;
      const snapshot = snapshots[candidate.name] ?? null;
      candidate.quota = this.codexAuthQuotaSnapshotMatchesIdentity(snapshot, candidateQuotaIdentity)
        ? snapshot
        : null;
    });
    await this.applySharedCodexAuthQuotaSnapshots(state, candidateQuotaIdentities);
    return state;
  }

  private resolveAuthDir(): string {
    return this.config.codexAuthDir
      ?? (this.config.tgMultiBotMode ? this.config.codexHome : null)
      ?? process.env.CODEX_AUTH_DIR
      ?? path.join(os.homedir(), '.codex');
  }

  private async readCodexAuthSwitchLabels(candidate: CodexAuthCandidate): Promise<CodexAuthSwitchResult> {
    const state = await this.listCodexAuthState();
    return {
      fromLabel: state.currentLabel,
      toLabel: await authPathDisplayLabel(candidate.path),
    };
  }

  private codexAuthSwitchParams(locale: AppLocale, fromLabel: string | null, toLabel: string): { from: string; to: string } {
    return {
      from: fromLabel ?? t(locale, 'none'),
      to: toLabel,
    };
  }

  private async switchCodexAuthAndRestart(
    scopeId: string,
    locale: AppLocale,
    candidate: CodexAuthCandidate,
    automatic: boolean,
    sendResult = true,
    automaticReason: CodexAuthRotationReason = 'auth_invalid',
  ): Promise<CodexAuthSwitchOutcome> {
    const authDir = this.resolveAuthDir();
    const initialState = await listCodexAuthState(new Set(), new Map(), authDir);
    const authStat = await fs.lstat(initialState.authPath).catch(() => null);
    const originalRegularAuth = authStat?.isFile()
      ? await fs.readFile(initialState.authPath, 'utf8').catch(() => null)
      : null;
    const recovered = await this.recoverCodexAuthCandidate(candidate.name, { crossNode: automatic });
    const result = await switchCodexAuth(candidate.path, authDir);
    this.authRotationFailedTargets.delete(candidate.path);
    this.pendingTurnErrors.clear();
    this.attachedThreads.clear();
    await this.app.restart();
    const validation = await this.validateCurrentCodexAuthCandidate(candidate);
    if (!validation.ok) {
      let restoredPrevious = false;
      try {
        await restoreCodexAuthTarget(initialState.authDir, initialState.authPath, initialState.currentTargetPath, originalRegularAuth);
        this.pendingTurnErrors.clear();
        this.attachedThreads.clear();
        await this.app.restart();
        restoredPrevious = true;
      } catch (error) {
        this.logger.warn('codex.auth_switch_restore_failed', {
          candidate: candidate.name,
          error: toErrorMeta(error),
        });
      }
      const validationFailureKind: CodexAuthRotationReason = isCodexAuthInvalidError(validation.error)
        ? 'auth_invalid'
        : isCodexQuotaLimitError(validation.error)
          ? 'quota_limited'
          : 'auth_invalid';
      const repairDisposition = validationFailureKind === 'auth_invalid'
        ? await this.markCodexAuthCandidateNeedsRepair(candidate.name)
        : { deleted: false, restarted: false };
      const outcome: CodexAuthSwitchOutcome = {
        ...result,
        ok: false,
        candidateName: candidate.name,
        recovered,
        error: validation.error,
        validationFailureKind,
        restoredPrevious,
        autoDeleted: repairDisposition.deleted,
        deleteRestarted: repairDisposition.restarted,
      };
      if (sendResult) {
        const lines = this.formatAuthSwitchValidationLines(locale, outcome);
        await this.sendMessage(scopeId, lines.join('\n'));
      }
      return outcome;
    }

    this.markCodexAuthCandidateActive(candidate.name);
    await this.syncCodexAuthCandidate(candidate.name);
    const outcome: CodexAuthSwitchOutcome = {
      ...result,
      ok: true,
      candidateName: candidate.name,
      recovered,
      error: null,
      validationFailureKind: null,
      restoredPrevious: false,
      autoDeleted: false,
      deleteRestarted: false,
    };

    if (!sendResult) {
      return outcome;
    }
    const doneKey = automaticReason === 'quota_limited' ? 'auth_quota_done' : 'auth_auto_done';
    const doneQuietKey = automaticReason === 'quota_limited' ? 'auth_quota_done_quiet' : 'auth_auto_done_quiet';
    const lines = [automatic && this.config.authAutoDeleteNeedsRepair
      ? t(locale, doneQuietKey)
      : t(
        locale,
        automatic ? doneKey : 'auth_switch_done',
        this.codexAuthSwitchParams(locale, result.fromLabel, result.toLabel),
      )];
    if (recovered) {
      lines.push(t(locale, 'auth_recovered_newer_candidate', { value: candidate.name }));
    }
    lines.push(...await this.buildCodexUsageStatusLines(locale));
    await this.sendMessage(scopeId, lines.join('\n'));
    return outcome;
  }

  private async validateCurrentCodexAuthCandidate(candidate: CodexAuthCandidate): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      if (await isCodexApiKeyAuthCandidate(candidate.path)) {
        const account = await this.app.readAccount(false);
        if (!account) {
          return { ok: false, error: 'Codex did not return account info after switch' };
        }
        return { ok: true };
      }

      const metadata = await readChatGptAuthMetadata(candidate.path);
      if (!metadata) {
        return { ok: false, error: 'candidate is not a readable ChatGPT auth file' };
      }
      if (!chatGptAuthMetadataMatchesCandidateName(candidate.name, metadata)) {
        return { ok: false, error: 'candidate auth identity does not match candidate name' };
      }

      const [account, rateLimits] = await Promise.all([
        this.app.readAccount(false),
        this.app.readAccountRateLimits(),
      ]);
      if (!account) {
        return { ok: false, error: 'Codex did not return account info after switch' };
      }
      if (account.type !== 'chatgpt') {
        return { ok: false, error: `Codex account type is ${account.type || 'unknown'}, expected ChatGPT` };
      }
      const snapshot = selectCodexRateLimitSnapshot(rateLimits);
      if (!snapshot) {
        return { ok: false, error: 'Codex did not return ChatGPT rate limits after switch' };
      }
      await this.recordCodexAuthQuotaSnapshot(candidate.name, metadata, snapshot);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatUserError(error) };
    }
  }

  private formatAuthSwitchValidationLines(locale: AppLocale, outcome: CodexAuthSwitchOutcome): string[] {
    if (outcome.ok) {
      return [];
    }
    const validationKey = outcome.validationFailureKind === 'quota_limited'
      ? 'auth_switch_validation_quota_limited'
      : outcome.autoDeleted && this.config.authAutoDeleteNeedsRepair
      ? 'auth_switch_validation_auto_deleted_quiet'
      : outcome.autoDeleted
        ? 'auth_switch_validation_auto_deleted'
        : 'auth_switch_validation_failed';
    return [
      t(locale, validationKey, {
        value: outcome.candidateName,
        error: outcome.error ?? t(locale, 'unknown'),
      }),
      outcome.restoredPrevious ? t(locale, 'auth_switch_validation_reverted') : '',
      outcome.deleteRestarted ? t(locale, 'auth_delete_current_restarted') : '',
      outcome.autoDeleted ? formatCodexAuthPoolSummary(locale, this.store.getCodexAuthPoolStats()) : '',
    ].filter(Boolean);
  }

  private async recoverCodexAuthCandidate(candidateName: string, options: { crossNode?: boolean } = { crossNode: true }): Promise<boolean> {
    if (!this.coordinator?.recoverAuthCandidate) {
      return false;
    }
    try {
      return await this.coordinator.recoverAuthCandidate(this.authRuntimeId(), candidateName, options);
    } catch (error) {
      this.logger.warn('codex.auth_candidate_recovery_failed', {
        candidate: candidateName,
        runtimeId: this.authRuntimeId(),
        error: toErrorMeta(error),
      });
      return false;
    }
  }

  private async markCodexAuthCandidateNeedsRepair(candidateName: string): Promise<CodexAuthRepairDisposition> {
    if (this.config.authAutoDeleteNeedsRepair) {
      const candidate = (await this.listCodexAuthState()).candidates.find(entry => entry.name === candidateName) ?? null;
      if (!candidate) {
        this.store.deleteCodexAuthCandidate(candidateName);
        this.store.recordCodexAuthCandidateInvalidDelete(candidateName, AUTH_DELETE_REASON_NEEDS_REPAIR);
        return { deleted: true, restarted: false };
      }
      const restarted = await this.deleteCodexAuthCandidate(candidate, AUTH_DELETE_REASON_NEEDS_REPAIR);
      this.logger.warn('codex.auth_candidate_auto_deleted', {
        candidate: candidateName,
        runtimeId: this.authRuntimeId(),
      });
      return { deleted: true, restarted };
    }
    this.store.setCodexAuthCandidateState(candidateName, 'needs_repair');
    return { deleted: false, restarted: false };
  }

  private markCodexAuthCandidateActive(candidateName: string): void {
    this.store.setCodexAuthCandidateState(candidateName, 'active');
  }

  private async syncCodexAuthCandidate(candidateName: string): Promise<void> {
    try {
      await this.coordinator?.authCandidateUpdated?.(this.authRuntimeId(), candidateName);
    } catch (error) {
      this.logger.warn('codex.auth_candidate_sync_failed', {
        candidate: candidateName,
        runtimeId: this.authRuntimeId(),
        error: toErrorMeta(error),
      });
    }
  }

  private async refreshAllCodexAuthCandidates(): Promise<CodexAuthRefreshAllResult> {
    return this.refreshCodexAuthCandidates();
  }

  private async refreshCodexAuthCandidates(candidateNames: Set<string> | null = null): Promise<CodexAuthRefreshAllResult> {
    if (this.authRefreshAllInProgress) {
      throw new UserFacingError('Auth refresh all is already running.');
    }
    const initialState = await this.listCodexAuthState();
    const result: CodexAuthRefreshAllResult = { refreshed: [], skipped: [], failed: [] };
    const candidates = candidateNames
      ? initialState.candidates.filter(candidate => candidateNames.has(candidate.name))
      : initialState.candidates;
    if (candidates.length === 0) {
      return result;
    }

    const authStat = await fs.lstat(initialState.authPath).catch(() => null);
    const originalRegularAuth = authStat?.isFile()
      ? await fs.readFile(initialState.authPath, 'utf8').catch(() => null)
      : null;
    let changedAuthTarget = false;
    this.authRefreshAllInProgress = true;
    try {
      for (const candidate of candidates) {
        const before = await readChatGptAuthMetadata(candidate.path);
        if (candidate.disabled || candidate.state === 'needs_repair' || !before || !chatGptAuthMetadataMatchesCandidateName(candidate.name, before)) {
          result.skipped.push(candidate.name);
          continue;
        }
        try {
          await pointCodexAuthAtTarget(initialState.authDir, initialState.authPath, candidate.path);
          changedAuthTarget = true;
          this.pendingTurnErrors.clear();
          this.attachedThreads.clear();
          await this.app.restart();
          await this.app.readAccount(true);
          const rateLimits = await this.app.readAccountRateLimits();
          const snapshot = selectCodexRateLimitSnapshot(rateLimits);
          if (!snapshot) {
            throw new Error('Codex did not return ChatGPT rate limits after refresh');
          }
          const after = await readChatGptAuthMetadata(candidate.path);
          if (
            !after
            || !chatGptAuthMetadataMatchesCandidateName(candidate.name, after)
            || !chatGptAuthMetadataCompatible(before, after)
          ) {
            throw new Error('refreshed auth identity did not match the original candidate');
          }
          if (after.lastRefreshMs <= before.lastRefreshMs) {
            throw new Error('Codex did not advance last_refresh');
          }
          await this.recordCodexAuthQuotaSnapshot(candidate.name, after, snapshot);
          await this.syncCodexAuthCandidate(candidate.name);
          result.refreshed.push(candidate.name);
        } catch (error) {
          result.failed.push({ name: candidate.name, error: formatUserError(error) });
        }
      }
    } finally {
      try {
        if (changedAuthTarget) {
          await restoreCodexAuthTarget(initialState.authDir, initialState.authPath, initialState.currentTargetPath, originalRegularAuth);
          this.pendingTurnErrors.clear();
          this.attachedThreads.clear();
          await this.app.restart();
        }
      } finally {
        this.authRefreshAllInProgress = false;
      }
    }
    return result;
  }

  private async buildNativeCollaborationMode(
    settings: ChatSessionSettings | null,
    cwd: string,
    modeOverride?: CollaborationModeValue | null,
  ): Promise<CodexCollaborationMode | null> {
    const mode = resolveCollaborationMode(
      modeOverride === undefined ? settings?.collaborationMode ?? null : modeOverride,
    );
    try {
      const [config, presets] = await Promise.all([
        this.app.readEffectiveConfig(cwd),
        this.app.listCollaborationModes(),
      ]);
      const preset = presets.find(entry => entry.mode === mode) ?? null;
      const model = settings?.model ?? preset?.model ?? config.model;
      if (!model) {
        this.logger.warn('codex.collaboration_mode_model_unavailable', { mode, cwd });
        return null;
      }
      const reasoningEffort = mode === 'plan'
        ? settings?.reasoningEffort
          ?? config.planModeReasoningEffort
          ?? preset?.reasoningEffort
          ?? config.modelReasoningEffort
          ?? null
        : settings?.reasoningEffort
          ?? config.modelReasoningEffort
          ?? preset?.reasoningEffort
          ?? null;
      return {
        mode,
        settings: {
          model,
          reasoning_effort: normalizeRequestedEffort(reasoningEffort ?? ''),
          developer_instructions: config.developerInstructions,
        },
      };
    } catch (error) {
      this.logger.warn('codex.collaboration_mode_failed', {
        mode,
        cwd,
        error: formatUserError(error),
      });
      return null;
    }
  }

  private async buildCodexUsageStatusLines(locale: AppLocale): Promise<string[]> {
    const [accountResult, limitsResult] = await Promise.allSettled([
      this.app.readAccount(),
      this.app.readAccountRateLimits(),
    ]);
    const account = accountResult.status === 'fulfilled' ? accountResult.value : null;
    if (accountResult.status === 'rejected') {
      this.logger.warn('codex.account_status_failed', { error: formatUserError(accountResult.reason) });
    }
    if (limitsResult.status === 'rejected') {
      this.logger.warn('codex.rate_limits_failed', { error: formatUserError(limitsResult.reason) });
    }
    const lines: string[] = [];
    if (account) {
      lines.push(t(locale, 'status_codex_account', { value: formatCodexAccountLabel(account) }));
    }
    if (limitsResult.status !== 'fulfilled') {
      lines.push(t(locale, 'status_codex_usage_unavailable', { error: formatShortStatusError(limitsResult.reason) }));
      return lines;
    }
    const snapshot = selectCodexRateLimitSnapshot(limitsResult.value);
    const planType = snapshot?.planType ?? account?.planType ?? null;
    if (planType) {
      lines.push(t(locale, 'status_codex_plan', { value: formatPlanTypeLabel(planType) }));
    }
    if (!snapshot) {
      lines.push(t(locale, 'status_codex_usage_unavailable', { error: t(locale, 'unknown') }));
      return lines;
    }
    lines.push(t(locale, 'status_codex_usage_title', { value: snapshot.limitName ?? snapshot.limitId ?? 'codex' }));
    for (const [kind, window] of [['primary', snapshot.primary], ['secondary', snapshot.secondary]] as const) {
      if (!window) {
        continue;
      }
      lines.push(t(locale, 'status_codex_usage_window', {
        window: formatRateLimitWindowLabel(locale, window, kind),
        percent: formatRemainingUsagePercent(window.usedPercent),
        reset: window.resetsAt
          ? t(locale, 'status_codex_usage_reset', { value: formatLocalTimestamp(window.resetsAt) })
          : '',
      }));
    }
    if (snapshot.credits?.unlimited) {
      lines.push(t(locale, 'status_codex_credits', { value: locale === 'zh' ? '无限' : 'unlimited' }));
    } else if (snapshot.credits?.balance && snapshot.credits.balance !== '0') {
      lines.push(t(locale, 'status_codex_credits', { value: snapshot.credits.balance }));
    }
    if (snapshot.rateLimitReachedType) {
      lines.push(t(locale, 'status_codex_limit_reached', { value: formatPlanTypeLabel(snapshot.rateLimitReachedType) }));
    }
    return lines;
  }

  private async buildCodexLocalUsageStatusLines(locale: AppLocale): Promise<string[]> {
    try {
      const snapshot = await this.readCachedCodexLocalUsageStats();
      void this.refreshCodexLocalUsageIfNeeded(snapshot).catch((error) => {
        this.logger.warn('codex.local_usage_background_refresh_failed', { error: formatUserError(error) });
      });
      if (!snapshot) {
        return [t(locale, 'status_codex_local_usage_refreshing')];
      }
      const stats = snapshot.stats;
      if (stats.sessionFiles === 0 || stats.sessionsWithUsage === 0) {
        return [];
      }
      return [
        t(locale, 'status_codex_local_history', {
          sessions: formatTokenCount(stats.sessionsWithUsage),
          turns: formatTokenCount(stats.turns),
          events: formatTokenCount(stats.usageEvents),
        }),
        t(locale, 'status_codex_local_tokens', {
          total: formatCodexTokenCountWithMetric(stats.totals.totalTokens),
          input: formatCodexTokenCountWithMetric(stats.totals.inputTokens),
          visible: formatTokenCount(Math.max(0, stats.totals.outputTokens - stats.totals.reasoningOutputTokens)),
          output: formatCodexTokenCountWithMetric(stats.totals.outputTokens),
          cached: formatCodexTokenCountWithMetric(stats.totals.cachedInputTokens),
          reasoning: formatTokenCount(stats.totals.reasoningOutputTokens),
        }),
        ...this.formatCodexLocalResponseThroughputStatusLines(locale, stats),
        t(locale, 'status_codex_local_snapshot_at', {
          value: formatLocalTimestamp(snapshot.computedAtMs / 1000),
        }),
      ];
    } catch (error) {
      this.logger.warn('codex.local_usage_failed', { error: formatUserError(error) });
      return [t(locale, 'status_codex_local_usage_unavailable', { error: formatShortStatusError(error) })];
    }
  }

  private formatCodexLocalResponseThroughputStatusLines(locale: AppLocale, stats: CodexLocalUsageStats): string[] {
    const throughput = stats.responseThroughput;
    if (
      throughput.completedTurns === 0
      || throughput.visibleOutputTokens <= 0
      || throughput.seconds <= 0
      || throughput.recentCompletedTurns === 0
      || throughput.recentVisibleOutputTokens <= 0
      || throughput.recentSeconds <= 0
    ) {
      return [];
    }
    return [t(locale, 'status_codex_local_throughput', {
      overall: formatCompactNumber(throughput.visibleOutputTokens / throughput.seconds),
      recent: formatCompactNumber(throughput.recentVisibleOutputTokens / throughput.recentSeconds),
      recentTurns: formatTokenCount(throughput.recentCompletedTurns),
      turns: formatTokenCount(throughput.completedTurns),
    })];
  }

  private async resolveFastStatusLabel(locale: AppLocale, settings: ChatSessionSettings | null): Promise<string> {
    try {
      const models = await this.app.listModels();
      const model = resolveCurrentModel(models, settings?.model ?? null);
      return formatServiceTierStatusLabel(locale, model, settings?.serviceTier ?? null);
    } catch (error) {
      this.logger.warn('codex.models_for_fast_status_failed', { error: formatUserError(error) });
      return t(locale, 'unknown');
    }
  }

  private async readCachedCodexLocalUsageStats(): Promise<CodexLocalUsageSnapshot | null> { return this.localUsage.readCachedCodexLocalUsageStats(); }

  private async refreshCodexLocalUsageIfNeeded(snapshot?: CodexLocalUsageSnapshot | null): Promise<void> { return this.localUsage.refreshCodexLocalUsageIfNeeded(snapshot); }

  private async refreshCodexLocalUsageStats(): Promise<void> { return this.localUsage.refreshCodexLocalUsageStats(); }

  private codexLocalUsageSnapshotPath(): string { return this.localUsage.codexLocalUsageSnapshotPath(); }

  private async refreshCurrentCodexAuthQuota(state: CodexAuthState): Promise<void> { return this.authQuota.refreshCurrentCodexAuthQuota(state); }

  private async applySharedCodexAuthQuotaSnapshots(
    state: CodexAuthState,
    candidateQuotaIdentities?: Map<string, CodexAuthQuotaIdentity>,
  ): Promise<void> { return this.authQuota.applySharedCodexAuthQuotaSnapshots(state, candidateQuotaIdentities); }

  private async recordCodexAuthQuotaSnapshot(
    candidateName: string,
    metadata: ChatGptAuthMetadata | null,
    snapshot: CodexRateLimitSnapshot,
  ): Promise<void> { return this.authQuota.recordCodexAuthQuotaSnapshot(candidateName, metadata, snapshot); }

  private async readCodexAuthCandidateQuotaIdentities(candidates: CodexAuthCandidate[]): Promise<Map<string, CodexAuthQuotaIdentity>> { return this.authQuota.readCodexAuthCandidateQuotaIdentities(candidates); }

  private codexAuthQuotaSnapshotMatchesIdentity(
    snapshot: CodexAuthQuotaSnapshot | null,
    identity: CodexAuthQuotaIdentity | null,
  ): snapshot is CodexAuthQuotaSnapshot { return this.authQuota.codexAuthQuotaSnapshotMatchesIdentity(snapshot, identity); }

  private async readCodexAuthQuotaSnapshots(): Promise<Record<string, CodexAuthQuotaSnapshot>> { return this.authQuota.readCodexAuthQuotaSnapshots(); }

  private async writeCodexAuthQuotaSnapshots(): Promise<void> { return this.authQuota.writeCodexAuthQuotaSnapshots(); }

  private codexAuthQuotaSnapshotPath(): string { return this.authQuota.codexAuthQuotaSnapshotPath(); }

  private runtimeSnapshotFilename(filename: string): string {
    if (!this.config.tgScopeBotId) {
      return filename;
    }
    return filename.replace(/\.json$/, `-${this.config.tgScopeBotId}.json`);
  }

  private async sendThreadContextSummary(scopeId: string, locale: AppLocale, threadId: string): Promise<void> {
    try {
      const turns = await this.app.listThreadTurns(threadId, 5);
      const text = formatThreadContextSummary(locale, turns);
      if (text) {
        await this.sendMessage(scopeId, text);
      }
    } catch (error) {
      this.logger.warn('codex.thread_context_summary_failed', {
        scopeId,
        threadId,
        error: formatUserError(error),
      });
    }
  }

  private async handleModelCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    if (args.length === 0) {
      await this.showSetupPanel(scopeId, 'model', undefined, locale);
      return;
    }

    if (this.findActiveTurn(scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'model_change_blocked'));
      return;
    }
    const settings = this.store.getChatSettings(scopeId);
    const raw = args.join(' ').trim();
    const models = await this.app.listModels();
    if (raw === '' || raw.toLowerCase() === 'default' || raw.toLowerCase() === 'reset') {
      const defaultModel = resolveCurrentModel(models, null);
      const nextEffort = clampEffortToModel(defaultModel, normalizeRequestedEffort(settings?.reasoningEffort ?? ''));
      const nextTier = clampServiceTierToModel(defaultModel, settings?.serviceTier ?? null);
      this.store.setChatSettings(scopeId, null, nextEffort.effort);
      if (nextTier.adjusted) {
        this.store.setChatServiceTier(scopeId, null);
      }
      const lines = [
        t(locale, 'model_reset'),
        t(locale, 'status_configured_effort', { value: nextEffort.effort ?? t(locale, 'server_default') }),
        t(locale, 'applies_next_turn'),
        t(locale, 'tip_use_models'),
      ];
      if (nextEffort.adjustedFrom) {
        lines.splice(1, 0, t(locale, 'effort_adjusted_default_model', { effort: nextEffort.adjustedFrom }));
      }
      if (nextTier.adjusted) {
        lines.splice(1, 0, t(locale, 'fast_cleared_due_to_model_switch'));
      }
      await this.sendMessage(scopeId, lines.join('\n'));
      await this.showSetupPanel(scopeId, 'model', undefined, locale);
      return;
    }

    const selected = resolveRequestedModel(models, raw);
    if (!selected) {
      await this.sendMessage(scopeId, t(locale, 'unknown_model', { model: raw }));
      return;
    }

    const nextEffort = clampEffortToModel(selected, normalizeRequestedEffort(settings?.reasoningEffort ?? ''));
    const nextTier = clampServiceTierToModel(selected, settings?.serviceTier ?? null);
    this.store.setChatSettings(scopeId, selected.model, nextEffort.effort);
    if (nextTier.adjusted) {
      this.store.setChatServiceTier(scopeId, null);
    }
    const lines = [
      t(locale, 'model_configured', { model: selected.model }),
      t(locale, 'status_configured_effort', { value: nextEffort.effort ?? t(locale, 'server_default') }),
      t(locale, 'applies_next_turn'),
      t(locale, 'tip_use_models'),
    ];
    if (nextEffort.adjustedFrom) {
      lines.splice(1, 0, t(locale, 'effort_adjusted_model', { effort: nextEffort.adjustedFrom, model: selected.model }));
    }
    if (nextTier.adjusted) {
      lines.splice(1, 0, t(locale, 'fast_cleared_due_to_model_switch'));
    }
    await this.sendMessage(scopeId, lines.join('\n'));
    await this.showSetupPanel(scopeId, 'model', undefined, locale);
  }

  private async handleEffortCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    if (args.length === 0) {
      await this.showSetupPanel(scopeId, 'effort', undefined, locale);
      return;
    }

    if (this.findActiveTurn(scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'effort_change_blocked'));
      return;
    }
    const settings = this.store.getChatSettings(scopeId);
    const models = await this.app.listModels();
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    const raw = args.join(' ').trim().toLowerCase();
    if (raw === 'default' || raw === 'reset') {
      this.store.setChatSettings(scopeId, settings?.model ?? null, null);
      await this.sendMessage(scopeId, [
        t(locale, 'effort_reset'),
        t(locale, 'applies_next_turn'),
        t(locale, 'tip_use_models'),
      ].join('\n'));
      await this.showSetupPanel(scopeId, 'effort', undefined, locale);
      return;
    }

    const effort = normalizeRequestedEffort(raw);
    if (!effort) {
      await this.sendMessage(scopeId, t(locale, 'usage_effort'));
      return;
    }
    if (currentModel && currentModel.supportedReasoningEfforts.length > 0 && !currentModel.supportedReasoningEfforts.includes(effort)) {
      await this.sendMessage(
        scopeId,
        t(locale, 'model_does_not_support_effort', {
          model: currentModel.model,
          effort,
          supported: currentModel.supportedReasoningEfforts.join(', '),
        }),
      );
      return;
    }
    this.store.setChatSettings(scopeId, settings?.model ?? null, effort);
    await this.sendMessage(scopeId, [
      t(locale, 'effort_configured', { effort }),
      t(locale, 'applies_next_turn'),
      t(locale, 'tip_use_models'),
    ].join('\n'));
    await this.showSetupPanel(scopeId, 'effort', undefined, locale);
  }

  private async handleThreadOpenCallback(event: TelegramCallbackEvent, threadId: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    const cached = this.store.listCachedThreads(scopeId).find(thread => thread.threadId === threadId);
    if (cached?.archived) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_is_archived_use_unarchive'));
      return;
    }
    await this.stopWatchingScopeThread(scopeId, threadId);
    let binding: ThreadBinding;
    let readOnly = false;
    try {
      binding = await this.bindCachedThread(scopeId, threadId);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_no_longer_available'));
        return;
      }
      if (!cached || !isThreadActiveWriterError(error)) throw error;
      binding = this.bindCachedThreadReadOnly(scopeId, cached);
      readOnly = true;
    }

    const threads = this.store.listCachedThreads(scopeId);
    if (threads.length > 0) {
      const threadLikes = threads.map((row) => ({
        index: row.index,
        threadId: row.threadId,
        name: row.name,
        preview: row.preview,
        cwd: row.cwd,
        modelProvider: row.modelProvider,
        status: row.status,
        archived: row.archived,
        updatedAt: row.updatedAt,
      }));
      const state = this.threadListPresentationState.get(scopeId) ?? null;
      const listState: ThreadListPresentationState = state ?? {
        offset: 0,
      pageSize: Math.max(threads.length, 1),
      hasPreviousPage: false,
      hasNextPage: false,
      searchTerm: null,
      archived: threads.some(thread => thread.archived),
    };
      const text = formatThreadsMessage(locale, threadLikes, binding.threadId, listState.searchTerm, listState);
      const keyboard = parseWeixinBridgeScope(scopeId)
        ? buildThreadsKeyboard(locale, threadLikes, binding.threadId)
        : buildThreadListKeyboard(locale, threadLikes, listState, binding.threadId);
      await this.editHtmlMessage(scopeId, event.messageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, event.messageId);
    }

    let callbackText = readOnly ? t(locale, 'thread_opened_read_only') : t(locale, 'thread_opened');
    if (!readOnly && this.config.codexAppSyncOnOpen) {
      const revealError = await this.tryRevealThread(scopeId, binding.threadId, 'open');
      callbackText = revealError ? t(locale, 'opened_sync_failed_short') : t(locale, 'opened_in_codex_short');
    }
    await this.messaging.answerCallback(event.callbackQueryId, callbackText);
    await this.sendThreadContextSummary(scopeId, locale, binding.threadId);
  }

  private async handleThreadActionCallback(
    event: TelegramCallbackEvent,
    action: 'rename' | 'watch' | 'archive' | 'unarchive',
    threadId: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    const cached = this.store.listCachedThreads(scopeId).find(thread => thread.threadId === threadId);
    if (!cached) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'cached_thread_unavailable'));
      return;
    }

    if (action === 'rename') {
      this.pendingThreadNewCwds.delete(scopeId);
      this.pendingThreadRenames.set(scopeId, {
        scopeId,
        threadId,
        messageId: event.messageId,
        createdAt: Date.now(),
      });
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_rename_prompt_short'));
      await this.sendMessage(scopeId, t(locale, 'thread_rename_prompt', {
        title: cached.name || cached.preview || t(locale, 'empty'),
      }));
      return;
    }

    if (action === 'watch') {
      if (cached.archived) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_is_archived_use_unarchive'));
        return;
      }
      const binding = this.bindCachedThreadReadOnly(scopeId, cached);
      const target = resolveScopeMessageTarget(scopeId);
      if (!target) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
        return;
      }
      const watch = await this.watchThread(scopeId, target.chatId, target.chatType, target.topicId, binding);
      await this.showThreadsPanelFromStoredState(scopeId, event.messageId, locale, false);
      await this.messaging.answerCallback(event.callbackQueryId, formatWatchCallbackText(locale, watch.mode, watch.threadId));
      await this.sendThreadContextSummary(scopeId, locale, watch.threadId);
      return;
    }

    if (action === 'archive') {
      if (cached.archived) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_is_archived_use_unarchive'));
        return;
      }
      await this.archiveThreadFromPanel(scopeId, threadId);
      await this.showThreadsPanelFromStoredState(scopeId, event.messageId, locale, false);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_archived_short'));
      return;
    }

    if (!cached.archived) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_not_archived'));
      return;
    }
    await this.app.unarchiveThread(threadId);
    await this.bindCachedThread(scopeId, threadId);
    await this.showThreadsPanelFromStoredState(scopeId, event.messageId, locale, false);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_unarchived_short'));
  }

  private async handleThreadNewCallback(event: TelegramCallbackEvent, locale: AppLocale): Promise<void> {
    this.pendingThreadRenames.delete(event.scopeId);
    this.pendingThreadNewCwds.set(event.scopeId, {
      scopeId: event.scopeId,
      messageId: event.messageId,
      cwdToCreate: null,
      confirmationMessageId: null,
      createdAt: Date.now(),
    });
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_new_prompt_short'));
    await this.sendMessage(event.scopeId, t(locale, 'thread_new_prompt', { cwd: this.config.defaultCwd }));
  }

  private async handleThreadNewFromThreadCallback(
    event: TelegramCallbackEvent,
    threadId: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    const cached = this.store.listCachedThreads(scopeId).find(thread => thread.threadId === threadId);
    if (!cached) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'cached_thread_unavailable'));
      return;
    }

    this.pendingThreadRenames.delete(scopeId);
    this.pendingThreadNewCwds.delete(scopeId);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_new_started_short'));
    await this.startNewThreadForRequestedCwd(scopeId, locale, cached.cwd || this.config.defaultCwd, event.messageId);
  }

  private async handleThreadNewCwdCallback(
    event: TelegramCallbackEvent,
    action: 'create' | 'cancel',
    locale: AppLocale,
  ): Promise<void> {
    const pending = this.pendingThreadNewCwds.get(event.scopeId);
    if (!pending || !pending.cwdToCreate) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_new_cwd_expired'));
      return;
    }
    if (action === 'cancel') {
      this.pendingThreadNewCwds.delete(event.scopeId);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_new_cwd_cancelled'));
      await this.finishThreadNewCwdConfirmation(event.scopeId, pending, t(locale, 'thread_new_cwd_cancelled'));
      return;
    }

    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    await this.createMissingCwdAndStartNewThread(event.scopeId, locale, pending);
  }

  private async handleThreadNewCwdTextReply(event: TelegramTextEvent, locale: AppLocale): Promise<void> {
    const pending = this.pendingThreadNewCwds.get(event.scopeId);
    if (!pending) {
      return;
    }
    const rawCwd = event.text.trim();
    if (pending.cwdToCreate && isThreadNewCwdCreateConfirmation(rawCwd)) {
      await this.createMissingCwdAndStartNewThread(event.scopeId, locale, pending);
      return;
    }
    if (pending.cwdToCreate && isThreadNewCwdCancelConfirmation(rawCwd)) {
      this.pendingThreadNewCwds.delete(event.scopeId);
      await this.finishThreadNewCwdConfirmation(event.scopeId, pending, t(locale, 'thread_new_cwd_cancelled'));
      return;
    }
    if (!rawCwd) {
      await this.sendMessage(event.scopeId, t(locale, 'thread_new_prompt', { cwd: this.config.defaultCwd }));
      return;
    }
    const cwd = rawCwd === '.' ? this.config.defaultCwd : rawCwd;
    pending.cwdToCreate = null;
    pending.confirmationMessageId = null;
    pending.createdAt = Date.now();
    this.pendingThreadNewCwds.set(event.scopeId, pending);
    await this.startNewThreadForRequestedCwd(event.scopeId, locale, cwd, pending.messageId);
  }

  private async startNewThreadForRequestedCwd(
    scopeId: string,
    locale: AppLocale,
    cwd: string,
    panelMessageId: number | null,
  ): Promise<void> {
    const state = await this.inspectNewThreadCwd(cwd);
    if (state === 'missing') {
      await this.promptCreateMissingNewThreadCwd(scopeId, locale, cwd, panelMessageId);
      return;
    }
    if (state === 'not_directory') {
      await this.sendMessage(scopeId, t(locale, 'thread_new_cwd_not_directory', { cwd }));
      return;
    }
    this.pendingThreadNewCwds.delete(scopeId);
    await this.createAndBindNewThread(scopeId, locale, cwd, panelMessageId);
  }

  private async createAndBindNewThread(
    scopeId: string,
    locale: AppLocale,
    cwd: string,
    panelMessageId: number | null,
  ): Promise<void> {
    this.store.cancelQueuedTurnInputs(scopeId);
    await this.stopWatchingScopeThread(scopeId);
    const binding = await this.createBinding(scopeId, cwd);
    await this.sendNewThreadStartedMessage(scopeId, locale, binding, cwd);
    if (panelMessageId !== null) {
      await this.showThreadsPanelFromStoredState(scopeId, panelMessageId, locale, false);
    }
  }

  private async promptCreateMissingNewThreadCwd(
    scopeId: string,
    locale: AppLocale,
    cwd: string,
    panelMessageId: number | null,
  ): Promise<void> {
    const pending: PendingThreadNewCwd = {
      scopeId,
      messageId: panelMessageId,
      cwdToCreate: cwd,
      confirmationMessageId: null,
      createdAt: Date.now(),
    };
    this.pendingThreadNewCwds.set(scopeId, pending);
    const lines = [
      t(locale, 'thread_new_cwd_missing', { cwd }),
      t(locale, 'thread_new_cwd_reply_hint'),
    ];
    const messageId = await this.sendMessage(scopeId, lines.join('\n'), threadNewCwdCreateKeyboard(locale));
    pending.confirmationMessageId = messageId;
  }

  private async createMissingCwdAndStartNewThread(
    scopeId: string,
    locale: AppLocale,
    pending: PendingThreadNewCwd,
  ): Promise<void> {
    const cwd = pending.cwdToCreate;
    if (!cwd) {
      this.pendingThreadNewCwds.delete(scopeId);
      await this.sendMessage(scopeId, t(locale, 'thread_new_cwd_expired'));
      return;
    }
    try {
      await fs.mkdir(cwd, { recursive: true });
    } catch (error) {
      await this.sendMessage(scopeId, t(locale, 'thread_new_cwd_create_failed', {
        cwd,
        error: formatUserError(error),
      }));
      return;
    }

    const state = await this.inspectNewThreadCwd(cwd);
    if (state !== 'directory') {
      await this.sendMessage(scopeId, t(locale, 'thread_new_cwd_create_failed', {
        cwd,
        error: state === 'not_directory'
          ? t(locale, 'thread_new_cwd_not_directory', { cwd })
          : t(locale, 'thread_new_cwd_still_missing'),
      }));
      return;
    }

    this.pendingThreadNewCwds.delete(scopeId);
    await this.finishThreadNewCwdConfirmation(scopeId, pending, t(locale, 'thread_new_cwd_created', { cwd }));
    await this.createAndBindNewThread(scopeId, locale, cwd, pending.messageId);
  }

  private async finishThreadNewCwdConfirmation(
    scopeId: string,
    pending: PendingThreadNewCwd,
    text: string,
  ): Promise<void> {
    if (pending.confirmationMessageId === null) {
      await this.sendMessage(scopeId, text);
      return;
    }
    await this.editMessage(scopeId, pending.confirmationMessageId, text, []);
  }

  private async inspectNewThreadCwd(cwd: string): Promise<'directory' | 'missing' | 'not_directory'> {
    try {
      const stat = await fs.stat(cwd);
      return stat.isDirectory() ? 'directory' : 'not_directory';
    } catch (error) {
      if (isFileMissingError(error)) {
        return 'missing';
      }
      throw error;
    }
  }

  private async handleThreadRenameTextReply(event: TelegramTextEvent, locale: AppLocale): Promise<void> {
    const pending = this.pendingThreadRenames.get(event.scopeId);
    if (!pending) {
      return;
    }
    const name = event.text.trim();
    if (!name) {
      await this.sendMessage(event.scopeId, t(locale, 'usage_rename'));
      return;
    }
    this.pendingThreadRenames.delete(event.scopeId);
    await this.app.setThreadName(pending.threadId, name);
    await this.sendMessage(event.scopeId, t(locale, 'rename_done', { name }));
    if (pending.messageId !== null) {
      await this.showThreadsPanelFromStoredState(event.scopeId, pending.messageId, locale);
    }
  }

  private async archiveThreadFromPanel(scopeId: string, threadId: string): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    if (binding?.threadId === threadId) {
      await this.stopWatchingScopeThread(scopeId);
      this.store.clearBinding(scopeId);
    }
    await this.app.archiveThread(threadId);
    this.attachedThreads.delete(attachedThreadKey(scopeId, threadId));
  }

  private async showThreadsPanelFromStoredState(
    scopeId: string,
    messageId: number,
    locale: AppLocale,
    archivedOverride?: boolean,
  ): Promise<void> {
    const state = this.threadListPresentationState.get(scopeId);
    await this.showThreadsPanel(
      scopeId,
      messageId,
      state?.searchTerm ?? null,
      locale,
      { offset: state?.offset ?? 0 },
      archivedOverride ?? Boolean(state?.archived),
    );
  }

  private async handleTurnInterruptCallback(event: TelegramCallbackEvent, turnId: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    const active = this.getActiveTurn(scopeId, turnId);
    if (!active) {
      await this.cleanupStaleInterruptButton(scopeId, event.messageId, locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'turn_already_finished'));
      return;
    }
    if (active.isObserved) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'watch_read_only_active'));
      return;
    }
    if (active.interruptRequested) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'interrupt_already_requested'));
      return;
    }
    active.interruptRequested = true;
    try {
      await this.requestInterrupt(active);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'interrupt_requested'));
    } catch (error) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'interrupt_failed', { error: formatUserError(error) }));
    }
  }

  private async handleNavigationCallback(
    event: TelegramCallbackEvent,
    target: 'models' | 'threads' | 'reveal' | 'permissions',
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (target === 'models') {
      await this.showSetupPanel(scopeId, 'model', event.messageId, locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'opened_setup_panel'));
      return;
    }
    if (target === 'permissions') {
      await this.showSetupPanel(scopeId, 'access', event.messageId, locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'opened_setup_panel'));
      return;
    }
    if (target === 'threads') {
      await this.showThreadsPanel(scopeId, event.messageId, undefined, locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'opened_thread_list'));
      return;
    }

    const binding = this.store.getBinding(scopeId);
    if (!binding) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'no_thread_bound_callback'));
      return;
    }
    const readyBinding = await this.ensureThreadReady(scopeId, binding);
    const revealError = await this.tryRevealThread(scopeId, readyBinding.threadId, 'reveal');
    await this.messaging.answerCallback(event.callbackQueryId, revealError ? t(locale, 'reveal_failed', { error: revealError }) : t(locale, 'opened_in_codex_short'));
  }

  private async showWherePanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    const fastStatus = await this.resolveFastStatusLabel(locale, settings);
    if (!binding) {
      let text = [
        t(locale, 'where_no_thread_bound'),
        t(locale, 'where_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
        t(locale, 'where_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
        t(locale, 'where_fast', { value: fastStatus }),
        t(locale, 'where_collaboration_mode', { value: formatCollaborationModeLabel(locale, settings?.collaborationMode ?? null) }),
        t(locale, 'where_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }),
        t(locale, 'where_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }),
        t(locale, 'where_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }),
        t(locale, 'where_send_message_or_new'),
      ].join('\n');
      if (parseWeixinBridgeScope(scopeId)) {
        text += `\n\n${formatWeixinWhereNavCopyPaste(locale, false, this.config.defaultCwd)}`;
      }
      if (messageId !== undefined) {
        await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, false));
        this.scheduleStalePanelDeletion(scopeId, messageId);
        return;
      }
      const sentMessageId = await this.sendMessage(scopeId, text, whereKeyboard(locale, false));
      this.scheduleStalePanelDeletion(scopeId, sentMessageId);
      return;
    }

    const readyBinding = await this.ensureThreadReady(scopeId, binding);
    const thread = await this.app.readThread(readyBinding.threadId, false);
    if (!thread) {
      let text = t(locale, 'where_thread_unavailable', { threadId: readyBinding.threadId });
      if (parseWeixinBridgeScope(scopeId)) {
        text += `\n\n${formatWeixinWhereNavCopyPaste(locale, true, this.config.defaultCwd)}`;
      }
      if (messageId !== undefined) {
        await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, false));
        this.scheduleStalePanelDeletion(scopeId, messageId);
        return;
      }
      const sentMessageId = await this.sendMessage(scopeId, text, whereKeyboard(locale, false));
      this.scheduleStalePanelDeletion(scopeId, sentMessageId);
      return;
    }

    let text = formatWhereMessage(locale, thread, settings, this.config.defaultCwd, access, fastStatus);
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinWhereNavCopyPaste(locale, true, this.config.defaultCwd)}`;
    }
    if (messageId !== undefined) {
      await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, true));
      this.scheduleStalePanelDeletion(scopeId, messageId);
      return;
    }
    const sentMessageId = await this.sendMessage(scopeId, text, whereKeyboard(locale, true));
    this.scheduleStalePanelDeletion(scopeId, sentMessageId);
  }

  private async handleThreadListNavigationCallback(
    event: TelegramCallbackEvent,
    action: 'prev' | 'next' | 'clear' | 'archived' | 'recent',
    locale: AppLocale,
  ): Promise<void> {
    const state = this.threadListPresentationState.get(event.scopeId) ?? {
      offset: 0,
      pageSize: Math.max(1, this.config.threadListLimit),
      hasPreviousPage: false,
      hasNextPage: false,
      searchTerm: null,
      archived: false,
    };
    const switchingArchiveView = action === 'archived' || action === 'recent';
    const nextOffset = switchingArchiveView
      ? 0
      : action === 'prev'
      ? Math.max(0, state.offset - state.pageSize)
      : action === 'next'
        ? state.offset + state.pageSize
        : 0;
    const nextSearchTerm = action === 'clear' ? null : state.searchTerm;
    const archived = action === 'archived'
      ? true
      : action === 'recent'
        ? false
        : Boolean(state.archived);
    await this.showThreadsPanel(event.scopeId, event.messageId, nextSearchTerm, locale, { offset: nextOffset }, archived);
    await this.messaging.answerCallback(
      event.callbackQueryId,
      t(locale, action === 'clear'
        ? 'threads_filter_cleared_short'
        : switchingArchiveView
          ? 'opened_thread_list'
          : 'decision_recorded'),
    );
  }

  async showThreadsPanel(
    scopeId: string,
    messageId?: number,
    searchTerm?: string | null,
    locale = this.localeForChat(scopeId),
    options: { offset?: number } = {},
    archived = false,
  ): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const pageSize = Math.max(1, this.config.threadListLimit);
    const offset = Math.max(0, options.offset ?? 0);
    const threads = await this.app.listThreads({
      limit: offset + pageSize + 1,
      searchTerm: searchTerm ?? null,
      archived,
    });
    const visible = threads.slice(offset, offset + pageSize);
    const hasNextPage = threads.length > offset + visible.length;
    const presentationState: ThreadListPresentationState = {
      offset,
      pageSize,
      hasPreviousPage: offset > 0,
      hasNextPage,
      searchTerm: searchTerm ?? null,
      archived,
    };
    this.threadListPresentationState.set(scopeId, presentationState);

    const cached = visible.map((thread, index) => ({
      listIndex: offset + index + 1,
      threadId: thread.threadId,
      name: thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      modelProvider: thread.modelProvider,
      status: thread.status,
      archived,
      updatedAt: thread.updatedAt,
    }));
    const forDisplay = visible.map((thread, index) => ({
      index: offset + index + 1,
      threadId: thread.threadId,
      name: thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      modelProvider: thread.modelProvider,
      status: thread.status,
      archived,
      updatedAt: thread.updatedAt,
    }));
    this.store.cacheThreadList(scopeId, cached);
    let text = formatThreadsMessage(locale, forDisplay, binding?.threadId ?? null, searchTerm ?? null, presentationState);
    if (parseWeixinBridgeScope(scopeId)) {
      const rows = forDisplay.map((row) => ({
        threadId: row.threadId,
        name: row.name,
        preview: row.preview,
        cwd: row.cwd,
        archived: row.archived,
      }));
      text += `\n\n${formatWeixinThreadsCopyPaste(locale, rows, searchTerm ?? null, offset)}`;
    }
    const keyboard = parseWeixinBridgeScope(scopeId)
      ? buildThreadsKeyboard(locale, forDisplay, binding?.threadId ?? null)
      : buildThreadListKeyboard(locale, forDisplay, presentationState, binding?.threadId ?? null);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, messageId);
      return;
    }
    const sentMessageId = await this.sendHtmlMessage(scopeId, text, keyboard);
    this.scheduleStalePanelDeletion(scopeId, sentMessageId);
  }

  private async showModelSettingsPanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    let text = formatModelSettingsMessage(locale, models, settings);
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinModelCopyPaste(locale, models, settings)}`;
      text += `\n\n${formatWeixinWhereNavCopyPaste(locale, this.store.getBinding(scopeId) !== null, this.config.defaultCwd)}`;
    }
    const keyboard = buildModelSettingsKeyboard(locale, models, settings);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, messageId);
      return;
    }
    const sentMessageId = await this.sendHtmlMessage(scopeId, text, keyboard);
    this.scheduleStalePanelDeletion(scopeId, sentMessageId);
  }

  private async showSetupPanel(
    scopeId: string,
    focus: SetupFocusSection,
    messageId?: number,
    locale = this.localeForChat(scopeId),
  ): Promise<void> {
    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    let text = formatSetupPanelMessage(locale, { focus, models, settings, access });
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinModelCopyPaste(locale, models, settings)}`;
      text += `\n\n${formatWeixinAccessCopyPaste(locale)}`;
      text += `\n\n${formatWeixinWhereNavCopyPaste(locale, this.store.getBinding(scopeId) !== null, this.config.defaultCwd)}`;
    }
    const keyboard = buildSetupPanelKeyboard(locale, { focus, models, settings, access });
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, messageId);
      return;
    }
    const sentMessageId = await this.sendHtmlMessage(scopeId, text, keyboard);
    this.scheduleStalePanelDeletion(scopeId, sentMessageId);
  }

  private async showAccessSettingsPanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const access = this.resolveEffectiveAccess(scopeId);
    let text = formatAccessSettingsMessage(locale, access);
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinAccessCopyPaste(locale)}`;
      text += `\n\n${formatWeixinWhereNavCopyPaste(locale, this.store.getBinding(scopeId) !== null, this.config.defaultCwd)}`;
    }
    const keyboard = buildAccessSettingsKeyboard(locale, access);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, messageId);
      return;
    }
    const sentMessageId = await this.sendHtmlMessage(scopeId, text, keyboard);
    this.scheduleStalePanelDeletion(scopeId, sentMessageId);
  }

  private async handleSettingsCallback(
    event: TelegramCallbackEvent,
    kind: 'model' | 'effort' | 'access',
    rawValue: string,
    locale: AppLocale,
  ): Promise<void> {
    await this.handleSetupCallback(event, kind, rawValue, locale);
  }

  private async handleSetupCallback(
    event: TelegramCallbackEvent,
    kind: 'model' | 'effort' | 'fast' | 'access' | 'mode' | 'active',
    rawValue: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (kind !== 'access' && kind !== 'active' && this.findActiveTurn(scopeId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
      return;
    }

    if (kind === 'access') {
      const nextPreset = normalizeAccessPreset(rawValue);
      if (!nextPreset) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
        return;
      }
      this.setChatAccessPreset(scopeId, nextPreset);
      await this.refreshSetupPanel(scopeId, event.messageId, 'access', locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'callback_access', {
        value: formatAccessPresetLabel(locale, nextPreset),
      }));
      return;
    }

    if (kind === 'active') {
      const mode = normalizeRequestedActiveTurnMessageMode(rawValue);
      if (!mode) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
        return;
      }
      this.store.setChatActiveTurnMessageMode(scopeId, mode);
      await this.refreshSetupPanel(scopeId, event.messageId, 'active', locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'active_configured', {
        value: formatActiveTurnMessageModeLabel(locale, mode),
      }));
      return;
    }

    if (kind === 'mode') {
      const mode = normalizeRequestedCollaborationMode(rawValue);
      if (!mode) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
        return;
      }
      this.store.setChatCollaborationMode(scopeId, mode);
      await this.refreshSetupPanel(scopeId, event.messageId, 'mode', locale);
      await this.messaging.answerCallback(
        event.callbackQueryId,
        mode === 'plan'
          ? t(locale, 'mode_plan_armed')
          : t(locale, 'mode_configured', { value: formatCollaborationModeLabel(locale, mode) }),
      );
      return;
    }

    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    const value = kind === 'model' ? decodeURIComponent(rawValue) : rawValue;

    if (kind === 'model') {
      if (value === 'default') {
        const defaultModel = resolveCurrentModel(models, null);
        const nextEffort = clampEffortToModel(defaultModel, normalizeRequestedEffort(settings?.reasoningEffort ?? ''));
        const nextTier = clampServiceTierToModel(defaultModel, settings?.serviceTier ?? null);
        this.store.setChatSettings(scopeId, null, nextEffort.effort);
        if (nextTier.adjusted) {
          this.store.setChatServiceTier(scopeId, null);
        }
        await this.refreshSetupPanel(scopeId, event.messageId, 'model', locale, models);
        await this.messaging.answerCallback(
          event.callbackQueryId,
          nextTier.adjusted ? t(locale, 'fast_cleared_due_to_model_switch') : t(locale, 'using_server_default_model'),
        );
        return;
      }
      const selected = resolveRequestedModel(models, value);
      if (!selected) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'model_no_longer_available'));
        return;
      }
      const nextEffort = clampEffortToModel(selected, normalizeRequestedEffort(settings?.reasoningEffort ?? ''));
      const nextTier = clampServiceTierToModel(selected, settings?.serviceTier ?? null);
      this.store.setChatSettings(scopeId, selected.model, nextEffort.effort);
      if (nextTier.adjusted) {
        this.store.setChatServiceTier(scopeId, null);
      }
      await this.refreshSetupPanel(scopeId, event.messageId, 'model', locale, models);
      await this.messaging.answerCallback(
        event.callbackQueryId,
        nextTier.adjusted ? t(locale, 'fast_cleared_due_to_model_switch') : t(locale, 'callback_model', { model: selected.model }),
      );
      return;
    }

    if (kind === 'fast') {
      const currentModel = resolveCurrentModel(models, settings?.model ?? null);
      const fastTier = resolveFastTierForModel(currentModel);
      if (!fastTier || value === 'unsupported') {
        await this.refreshSetupPanel(scopeId, event.messageId, 'fast', locale, models);
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'fast_not_supported_by_model'));
        return;
      }
      const nextTier = value === 'on' ? fastTier.id : null;
      this.store.setChatServiceTier(scopeId, nextTier);
      await this.refreshSetupPanel(scopeId, event.messageId, 'fast', locale, models);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'callback_fast', {
        value: nextTier ? t(locale, 'fast_enabled', { tier: fastTier.name || fastTier.id }) : t(locale, 'fast_disabled'),
      }));
      return;
    }

    if (value === 'default') {
      this.store.setChatSettings(scopeId, settings?.model ?? null, null);
      await this.refreshSetupPanel(scopeId, event.messageId, 'effort', locale, models);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'using_default_effort'));
      return;
    }

    const effort = normalizeRequestedEffort(value);
    if (!effort) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unknown_effort'));
      return;
    }
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    if (currentModel && currentModel.supportedReasoningEfforts.length > 0 && !currentModel.supportedReasoningEfforts.includes(effort)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'effort_not_supported_by_model'));
      return;
    }
    this.store.setChatSettings(scopeId, settings?.model ?? null, effort);
    await this.refreshSetupPanel(scopeId, event.messageId, 'effort', locale, models);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'callback_effort', { effort }));
  }

  private async handleAccessSettingsCallback(event: TelegramCallbackEvent, rawValue: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    const nextPreset = normalizeAccessPreset(rawValue);
    if (!nextPreset) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    this.setChatAccessPreset(scopeId, nextPreset);
    await this.refreshAccessSettingsPanel(scopeId, event.messageId, locale);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'callback_access', {
      value: formatAccessPresetLabel(locale, nextPreset),
    }));
  }

  private async refreshModelSettingsPanel(scopeId: string, messageId: number, locale: AppLocale, models?: ModelInfo[]): Promise<void> {
    const resolvedModels = models ?? await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    await this.editHtmlMessage(
      scopeId,
      messageId,
      formatModelSettingsMessage(locale, resolvedModels, settings),
      buildModelSettingsKeyboard(locale, resolvedModels, settings),
    );
  }

  private async refreshSetupPanel(
    scopeId: string,
    messageId: number,
    focus: SetupFocusSection,
    locale: AppLocale,
    models?: ModelInfo[],
  ): Promise<void> {
    const resolvedModels = models ?? await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    await this.editHtmlMessage(
      scopeId,
      messageId,
      formatSetupPanelMessage(locale, { focus, models: resolvedModels, settings, access }),
      buildSetupPanelKeyboard(locale, { focus, models: resolvedModels, settings, access }),
    );
  }

  private async refreshAccessSettingsPanel(scopeId: string, messageId: number, locale: AppLocale): Promise<void> {
    const access = this.resolveEffectiveAccess(scopeId);
    await this.editHtmlMessage(
      scopeId,
      messageId,
      formatAccessSettingsMessage(locale, access),
      buildAccessSettingsKeyboard(locale, access),
    );
  }

  private async startBoundTurnFromEvent(
    event: TelegramTextEvent,
    locale: AppLocale,
    text: string,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (this.externalAuthValidationInProgress) {
      await this.sendMessage(scopeId, t(locale, 'auth_sync_validation_busy'));
      return;
    }
    this.turnStartInProgress += 1;
    try {
      this.clearPlanImplementationPromptsForScope(scopeId);
      await this.stopWatchingScopeThread(scopeId);
      const existingBinding = this.store.getBinding(scopeId);
      const binding = existingBinding
        ? await this.ensureThreadReady(scopeId, existingBinding)
        : await this.createBinding(scopeId, null);
      await this.sendTyping(scopeId);
      const previewMessageId = 0;
      try {
        const input = await this.buildTurnInput(binding, { ...event, text }, locale);
        const turnState = await this.startTurnWithRecovery(scopeId, binding, input);
        if (turnState.collaborationMode === 'plan') {
          this.store.setChatCollaborationMode(scopeId, DEFAULT_COLLABORATION_MODE);
        }
        await this.registerActiveTurn(
          scopeId,
          event.chatId,
          event.chatType,
          event.topicId,
          turnState.threadId,
          turnState.turnId,
          previewMessageId,
          {
            input,
            threadId: turnState.threadId,
            cwd: this.store.getBinding(scopeId)?.cwd ?? binding.cwd ?? this.config.defaultCwd,
            chatId: event.chatId,
            chatType: event.chatType,
            topicId: event.topicId,
            collaborationMode: turnState.collaborationMode,
            failedAuthTargets: new Set(),
          },
          turnState.collaborationMode,
        );
      } catch (error) {
        if (previewMessageId > 0) {
          await this.cleanupTransientPreview(scopeId, previewMessageId);
        }
        throw error;
      }
    } finally {
      this.turnStartInProgress -= 1;
    }
  }

  private async requestInterrupt(active: ActiveTurn): Promise<void> {
    active.interruptRequested = true;
    try {
      await this.app.interruptTurn(active.threadId, active.turnId);
      await this.finalizeUserInputsForTurn(active, 'interrupted');
      await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    } catch (error) {
      active.interruptRequested = false;
      throw error;
    }
  }

  private async queueTurnRender(
    active: ActiveTurn,
    options: { forceStatus?: boolean; forceStream?: boolean } = {},
  ): Promise<void> {
    this.clearRenderRetry(active);
    active.renderRequested = true;
    active.forceStatusFlush = active.forceStatusFlush || Boolean(options.forceStatus);
    active.forceStreamFlush = active.forceStreamFlush || Boolean(options.forceStream);
    if (active.renderTask) {
      await active.renderTask;
      return;
    }
    active.renderTask = (async () => {
      while (active.renderRequested) {
        const forceStatus = active.forceStatusFlush;
        const forceStream = active.forceStreamFlush;
        active.renderRequested = false;
        active.forceStatusFlush = false;
        active.forceStreamFlush = false;
        await this.syncTurnStream(active, forceStream);
        await this.syncTurnStatus(active, forceStatus);
      }
    })().finally(() => {
      active.renderTask = null;
    });
    await active.renderTask;
  }

  private async syncTurnStatus(active: ActiveTurn, force: boolean): Promise<void> {
    if (active.pendingArchivedStatus) {
      const archived = await this.archiveStatusMessage(active, active.pendingArchivedStatus);
      if (!archived) {
        return;
      }
      active.pendingArchivedStatus = null;
    }

    const text = this.renderActiveStatus(active);
    if (active.previewActive && active.statusNeedsRebase) {
      await this.rebaseStatusMessage(active, text);
      return;
    }
    if (!force && text === active.statusMessageText && active.previewActive) {
      return;
    }
    await this.ensureStatusMessage(active, text);
  }

  private async syncTurnStream(active: ActiveTurn, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - active.lastStreamFlushAt < this.config.telegramPreviewThrottleMs) {
      return;
    }

    active.lastStreamFlushAt = now;
    if (active.renderRoute.currentRenderer === 'draft_stream') {
      await this.syncDraftTurnStream(active, force);
      return;
    }

    for (const segment of active.segments) {
      await this.syncSegmentTimeline(active, segment);
    }
  }

  private async cleanupStaleTurnPreviews(): Promise<void> {
    for (const preview of this.store.listActiveTurnPreviews()) {
      if (!this.ownsScope(preview.scopeId)) {
        continue;
      }
      if (!this.messaging.canSendToScope(preview.scopeId)) {
        this.store.removeActiveTurnPreview(preview.turnId);
        this.logger.info('telegram.preview_dropped_disabled_channel', {
          scopeId: preview.scopeId,
          threadId: preview.threadId,
          turnId: preview.turnId,
        });
        continue;
      }
      try {
        if (await this.recoverLiveTurnPreview(preview)) {
          continue;
        }
      } catch (error) {
        this.logger.warn('telegram.preview_recovery_failed', {
          scopeId: preview.scopeId,
          threadId: preview.threadId,
          turnId: preview.turnId,
          error: toErrorMeta(error),
        });
      }
      this.scheduleRestartPreviewRecovery(preview, 0);
    }
  }

  private scheduleRestartPreviewRecovery(preview: ActiveTurnPreviewRecord, attempt: number): void {
    const key = restartPreviewRecoveryKey(preview);
    if (this.restartPreviewRecoveryTimers.has(key)) {
      return;
    }
    const delayMs = RESTART_PREVIEW_RECOVERY_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      void this.retireStaleRestartPreview(preview).catch((error) => {
        this.logger.warn('telegram.preview_stale_retire_failed', {
          scopeId: preview.scopeId,
          threadId: preview.threadId,
          turnId: preview.turnId,
          error: toErrorMeta(error),
        });
      });
      return;
    }
    const timer = setTimeout(() => {
      this.restartPreviewRecoveryTimers.delete(key);
      void this.retryRestartPreviewRecovery(preview, attempt + 1).catch((error) => {
        this.logger.warn('telegram.preview_recovery_retry_failed', {
          scopeId: preview.scopeId,
          threadId: preview.threadId,
          turnId: preview.turnId,
          attempt: attempt + 1,
          error: toErrorMeta(error),
        });
        this.scheduleRestartPreviewRecovery(preview, attempt + 1);
      });
    }, delayMs);
    timer.unref?.();
    this.restartPreviewRecoveryTimers.set(key, timer);
    this.logger.info('telegram.preview_recovery_deferred', {
      scopeId: preview.scopeId,
      threadId: preview.threadId,
      turnId: preview.turnId,
      attempt: attempt + 1,
      delayMs,
    });
  }

  private async retryRestartPreviewRecovery(preview: ActiveTurnPreviewRecord, attempt: number): Promise<void> {
    const current = this.store.listActiveTurnPreviews().find((record) => (
      record.scopeId === preview.scopeId
      && record.turnId === preview.turnId
      && record.messageId === preview.messageId
    ));
    if (!current) {
      return;
    }
    if (!this.ownsScope(current.scopeId)) {
      return;
    }
    if (!this.messaging.canSendToScope(current.scopeId)) {
      this.store.removeActiveTurnPreview(current.turnId);
      this.logger.info('telegram.preview_dropped_disabled_channel', {
        scopeId: current.scopeId,
        threadId: current.threadId,
        turnId: current.turnId,
      });
      return;
    }
    try {
      if (await this.recoverLiveTurnPreview(current)) {
        this.logger.info('telegram.preview_recovery_retry_succeeded', {
          scopeId: current.scopeId,
          threadId: current.threadId,
          turnId: current.turnId,
          attempt,
        });
        return;
      }
    } catch (error) {
      this.logger.warn('telegram.preview_recovery_retry_failed', {
        scopeId: current.scopeId,
        threadId: current.threadId,
        turnId: current.turnId,
        attempt,
        error: toErrorMeta(error),
      });
    }
    this.scheduleRestartPreviewRecovery(current, attempt);
  }

  private async retireStaleRestartPreview(preview: ActiveTurnPreviewRecord): Promise<void> {
    const current = this.store.listActiveTurnPreviews().find((record) => (
      record.scopeId === preview.scopeId
      && record.turnId === preview.turnId
      && record.messageId === preview.messageId
    ));
    if (!current) {
      return;
    }
    await this.retirePreviewMessage(
      current.scopeId,
      current.messageId,
      t(this.localeForChat(current.scopeId), 'stale_preview_restarted', { threadId: current.threadId }),
      current.turnId,
    );
  }

  private clearRestartPreviewRecoveryTimers(): void {
    for (const timer of this.restartPreviewRecoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.restartPreviewRecoveryTimers.clear();
  }

  private async recoverLiveTurnPreview(preview: {
    scopeId: string;
    threadId: string;
    turnId: string;
    messageId: number;
    isObserved: boolean;
    archivedMessageIds: number[];
  }): Promise<boolean> {
    if (this.getActiveTurn(preview.scopeId, preview.turnId)) {
      return true;
    }
    if (!this.messaging.canSendToScope(preview.scopeId)) {
      return false;
    }
    const target = resolveScopeMessageTarget(preview.scopeId);
    if (!target) {
      return false;
    }
    const snapshot = await this.app.readThreadSnapshot(preview.threadId);
    if (!snapshot) {
      return preview.isObserved ? false : this.resumeInterruptedTurnAfterRestart(preview, target);
    }
    const liveTurn = findLiveTurn(snapshot);
    if (liveTurn) {
      if (
        liveTurn.turnId === preview.turnId
        && snapshot.activeFlags.includes('waitingOnUserInput')
        && !this.hasPendingUserInputForTurn(preview.scopeId, preview.turnId)
      ) {
        return this.interruptOrphanWaitingUserInput(preview);
      }
      return this.attachRecoveredTurnPreview(preview, target, snapshot, liveTurn);
    }
    const previousTurn = snapshot.turns.find(turn => turn.turnId === preview.turnId) ?? null;
    if (previousTurn && previousTurn.status !== 'inProgress') {
      if (!turnHasRelayableOutcome(previousTurn)) {
        return this.resumeInterruptedTurnAfterRestart(preview, target);
      }
      await this.retirePreviewMessage(
        preview.scopeId,
        preview.messageId,
        t(this.localeForChat(preview.scopeId), 'completed_see_reply_below'),
        preview.turnId,
      );
      return true;
    }
    if (preview.isObserved) {
      return false;
    }
    return this.resumeInterruptedTurnAfterRestart(preview, target);
  }

  private async attachRecoveredTurnPreview(
    preview: {
      scopeId: string;
      threadId: string;
      turnId: string;
      messageId: number;
      isObserved: boolean;
      archivedMessageIds: number[];
    },
    target: { chatId: string; chatType: string; topicId: number | null },
    snapshot: AppThreadSnapshot,
    liveTurn: AppTurnSnapshot,
  ): Promise<boolean> {
    await this.stopWatchingScopeThread(preview.scopeId, preview.threadId);
    const active = this.createActiveTurnState(
      preview.scopeId,
      target.chatId,
      target.chatType,
      target.topicId,
      preview.threadId,
      liveTurn.turnId,
      preview.messageId,
      preview.isObserved,
    );
    active.archivedMessageIds = [...preview.archivedMessageIds];
    this.setActiveTurn(preview.scopeId, liveTurn.turnId, active);
    this.store.saveActiveTurnPreview({
      turnId: liveTurn.turnId,
      scopeId: preview.scopeId,
      threadId: preview.threadId,
      messageId: preview.messageId,
      isObserved: preview.isObserved,
      archivedMessageIds: active.archivedMessageIds,
    });
    const watcher: ObservedThreadWatcher = {
      scopeId: preview.scopeId,
      chatId: target.chatId,
      chatType: target.chatType,
      topicId: target.topicId,
      threadId: preview.threadId,
      mode: 'app_snapshot',
      timer: null,
      cursor: seedObservedTurnCursor(liveTurn),
      activeTurnId: liveTurn.turnId,
      waitingOnApproval: snapshot.activeFlags.includes('waitingOnApproval'),
      sessionPath: null,
      sessionOffset: -1,
      sessionRemainder: '',
      sessionCursor: { activeTurnId: null, nextMessageIndex: 0 },
      stopped: false,
    };
    this.observedThreadWatchers.set(preview.scopeId, watcher);
    this.scheduleObservedThreadPoll(watcher);
    this.updateStatus();
    await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    this.logger.info('telegram.preview_recovered', {
      scopeId: preview.scopeId,
      threadId: preview.threadId,
      turnId: liveTurn.turnId,
      previousTurnId: preview.turnId,
      isObserved: preview.isObserved,
    });
    return true;
  }

  private async resumeInterruptedTurnAfterRestart(
    preview: {
      scopeId: string;
      threadId: string;
      turnId: string;
      messageId: number;
      archivedMessageIds: number[];
    },
    target: { chatId: string; chatType: string; topicId: number | null },
  ): Promise<boolean> {
    const locale = this.localeForChat(preview.scopeId);
    const storedBinding = this.store.getBinding(preview.scopeId);
    const binding: ThreadBinding = storedBinding?.threadId === preview.threadId
      ? storedBinding
      : {
          chatId: preview.scopeId,
          threadId: preview.threadId,
          cwd: storedBinding?.cwd ?? this.config.defaultCwd,
          updatedAt: Date.now(),
        };
    const input: TurnInput[] = [{
      type: 'text',
      text: t(locale, 'restart_auto_resume_prompt'),
      text_elements: [],
    }];
    try {
      await this.sendTyping(preview.scopeId);
      const readyBinding = await this.ensureThreadReady(preview.scopeId, binding, {
        recoverMissingThread: false,
      });
      const turnState = await this.startTurnWithRecovery(preview.scopeId, readyBinding, input, {
        recoverMissingThread: false,
      });
      const cwd = readyBinding.cwd ?? this.store.getBinding(preview.scopeId)?.cwd ?? this.config.defaultCwd;
      if (turnState.collaborationMode === 'plan') {
        this.store.setChatCollaborationMode(preview.scopeId, DEFAULT_COLLABORATION_MODE);
      }
      await this.registerActiveTurn(
        preview.scopeId,
        target.chatId,
        target.chatType,
        target.topicId,
        turnState.threadId,
        turnState.turnId,
        preview.messageId,
        {
          input,
          threadId: turnState.threadId,
          cwd,
          chatId: target.chatId,
          chatType: target.chatType,
          topicId: target.topicId,
          collaborationMode: turnState.collaborationMode,
          failedAuthTargets: new Set(),
        },
        turnState.collaborationMode,
        null,
        preview.archivedMessageIds,
      );
      this.logger.info('telegram.preview_auto_resumed_after_restart', {
        scopeId: preview.scopeId,
        threadId: preview.threadId,
        previousTurnId: preview.turnId,
        turnId: turnState.turnId,
      });
      return true;
    } catch (error) {
      this.logger.warn('telegram.preview_auto_resume_after_restart_failed', {
        scopeId: preview.scopeId,
        threadId: preview.threadId,
        turnId: preview.turnId,
        error: toErrorMeta(error),
      });
      return false;
    }
  }

  private async interruptOrphanWaitingUserInput(preview: {
    scopeId: string;
    threadId: string;
    turnId: string;
    messageId: number;
  }): Promise<boolean> {
    try {
      await this.app.interruptTurn(preview.threadId, preview.turnId);
      await this.retirePreviewMessage(
        preview.scopeId,
        preview.messageId,
        t(this.localeForChat(preview.scopeId), 'stale_user_input_interrupted', { threadId: preview.threadId }),
        preview.turnId,
      );
      this.logger.warn('codex.user_input_orphan_interrupted', {
        scopeId: preview.scopeId,
        threadId: preview.threadId,
        turnId: preview.turnId,
      });
      return true;
    } catch (error) {
      this.logger.warn('codex.user_input_orphan_interrupt_failed', {
        scopeId: preview.scopeId,
        threadId: preview.threadId,
        turnId: preview.turnId,
        error: toErrorMeta(error),
      });
      return false;
    }
  }

  private async cleanupFinishedPreview(
    active: Pick<ActiveTurn, 'scopeId' | 'previewMessageId' | 'turnId' | 'interruptRequested' | 'previewActive'>,
    locale: AppLocale,
  ): Promise<void> {
    if (!active.previewActive) {
      return;
    }
    try {
      await this.deleteMessage(active.scopeId, active.previewMessageId);
      this.store.removeActiveTurnPreview(active.turnId);
      return;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        this.store.removeActiveTurnPreview(active.turnId);
        return;
      }
      this.logger.warn('telegram.preview_delete_failed', { error: String(error), turnId: active.turnId });
    }

    await this.retirePreviewMessage(
      active.scopeId,
      active.previewMessageId,
      t(locale, active.interruptRequested ? 'interrupted_see_reply_below' : 'completed_see_reply_below'),
      active.turnId,
    );
  }

  private async cleanupStaleInterruptButton(scopeId: string, messageId: number, locale: AppLocale): Promise<void> {
    try {
      await this.clearMessageButtons(scopeId, messageId);
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.logger.warn('telegram.stale_interrupt_cleanup_failed', {
          scopeId,
          messageId,
          locale,
          error: String(error),
        });
      }
    }
  }

  private async cleanupTransientPreview(scopeId: string, messageId: number): Promise<void> {
    try {
      await this.deleteMessage(scopeId, messageId);
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.logger.warn('telegram.preview_transient_cleanup_failed', { scopeId, messageId, error: String(error) });
      }
    }
  }

  private releaseActiveTurnsForBridgeShutdown(): void {
    const activeTurns = [...this.activeTurns.values()];
    for (const active of activeTurns) {
      this.clearToolBatchTimer(active.toolBatch);
      this.clearRenderRetry(active);
      active.resolver();
      this.deleteActiveTurnRecord(active);
    }
    if (activeTurns.length > 0) {
      this.updateStatus();
    }
  }

  private async retirePreviewMessage(scopeId: string, messageId: number, text: string, turnId?: string): Promise<void> {
    try {
      await this.editMessage(scopeId, messageId, text, []);
      this.forgetPreviewRecord(scopeId, messageId, turnId);
      return;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        this.forgetPreviewRecord(scopeId, messageId, turnId);
        return;
      }
      this.logger.warn('telegram.preview_text_cleanup_failed', {
        scopeId,
        messageId,
        turnId: turnId ?? null,
        error: String(error),
      });
    }

    try {
      await this.clearMessageButtons(scopeId, messageId);
      this.forgetPreviewRecord(scopeId, messageId, turnId);
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        this.forgetPreviewRecord(scopeId, messageId, turnId);
        return;
      }
      this.logger.warn('telegram.preview_markup_cleanup_failed', {
        scopeId,
        messageId,
        turnId: turnId ?? null,
        error: String(error),
      });
    }
  }

  private forgetPreviewRecord(scopeId: string, messageId: number, turnId?: string): void {
    if (turnId) {
      this.store.removeActiveTurnPreview(turnId);
      return;
    }
    this.store.removeActiveTurnPreviewByMessage(scopeId, messageId);
  }

  private async clearMessageButtons(scopeId: string, messageId: number): Promise<void> {
    await this.messaging.clearInlineKeyboard(scopeId, messageId);
  }

  private async sendDraft(scopeId: string, draftId: number, text: string): Promise<void> {
    await this.messaging.sendDraft(scopeId, draftId, text);
  }

  private async sendRichDraft(scopeId: string, draftId: number, html: string, fallbackText: string): Promise<void> {
    await this.messaging.sendRichDraft(scopeId, draftId, html, fallbackText);
  }

  private async sendRichMarkdownDraft(scopeId: string, draftId: number, markdown: string, fallbackText: string): Promise<void> {
    try {
      await this.messaging.sendRichMarkdownDraft(scopeId, draftId, markdown, fallbackText);
    } catch (markdownError) {
      this.logger.warn('telegram.rich_markdown_draft_failed', { scopeId, error: toErrorMeta(markdownError) });
      await this.sendRichDraft(scopeId, draftId, renderTelegramMarkdownRichHtml(markdown), fallbackText);
    }
  }

  private renderActiveStatus(active: ActiveTurn): string {
    const locale = this.localeForChat(active.scopeId);
    return renderActiveTurnStatus(locale, {
      interruptRequested: active.interruptRequested,
      pendingApprovalKinds: active.pendingApprovalKinds,
      toolStatusText: active.toolBatch
        ? formatToolBatchStatus(locale, active.toolBatch.counts, active.toolBatch.actionLines, true)
        : null,
      reasoningActive: active.reasoningActiveCount > 0,
      hasStreamingReply: this.findStreamingSegment(active) !== null,
    });
  }

  private async dismissTurnPreview(active: ActiveTurn): Promise<void> {
    if (!active.previewActive) {
      return;
    }
    await this.cleanupTransientPreview(active.scopeId, active.previewMessageId);
    active.previewActive = false;
    active.statusMessageText = null;
    active.statusNeedsRebase = false;
    this.store.removeActiveTurnPreview(active.turnId);
  }

  private async ensureStatusMessage(active: ActiveTurn, text: string): Promise<void> {
    if (!active.previewActive) {
      try {
        const messageId = await this.sendMessage(
          active.scopeId,
          text,
          active.interruptRequested ? [] : activeTurnKeyboard(this.localeForChat(active.scopeId), active.turnId),
        );
        active.previewMessageId = messageId;
        active.previewActive = true;
        active.statusMessageText = text;
        active.statusNeedsRebase = false;
        this.store.saveActiveTurnPreview({
          turnId: active.turnId,
          scopeId: active.scopeId,
          threadId: active.threadId,
          messageId,
          isObserved: active.isObserved,
          archivedMessageIds: active.archivedMessageIds,
        });
      } catch (error) {
        this.logger.warn('telegram.preview_send_failed', { error: String(error), turnId: active.turnId });
        this.scheduleRenderRetry(active);
      }
      return;
    }
    try {
      await this.editMessage(
        active.scopeId,
        active.previewMessageId,
        text,
        active.interruptRequested ? [] : activeTurnKeyboard(this.localeForChat(active.scopeId), active.turnId),
      );
      active.statusMessageText = text;
      active.statusNeedsRebase = false;
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.logger.warn('telegram.preview_edit_failed', {
          error: String(error),
          turnId: active.turnId,
          messageId: active.previewMessageId,
        });
      }
      active.previewActive = false;
      active.statusMessageText = null;
      active.statusNeedsRebase = false;
      this.recordArchivedMessageId(active, active.previewMessageId);
      this.store.removeActiveTurnPreview(active.turnId);
      await this.ensureStatusMessage(active, text);
      return;
    }
    this.clearRenderRetry(active);
  }

  private async rebaseStatusMessage(active: ActiveTurn, text: string): Promise<void> {
    if (active.previewActive) {
      await this.cleanupTransientPreview(active.scopeId, active.previewMessageId);
      active.previewActive = false;
      active.statusMessageText = null;
      this.store.removeActiveTurnPreview(active.turnId);
    }
    active.statusNeedsRebase = false;
    await this.ensureStatusMessage(active, text);
  }

  private async archiveStatusMessage(active: ActiveTurn, content: ArchivedStatusContent): Promise<boolean> {
    if (!active.previewActive) {
      try {
        let messageId: number | null = null;
        if (content.html) {
          messageId = await this.sendHtmlMessage(active.scopeId, content.html);
        } else {
          messageId = await this.sendMessage(active.scopeId, content.text);
        }
        if (messageId !== null) {
          this.recordArchivedMessageId(active, messageId);
        }
      } catch (error) {
        if (isTelegramMessageTooLong(error)) {
          try {
            const messageId = await this.sendMessage(active.scopeId, firstLine(content.text));
            this.recordArchivedMessageId(active, messageId);
            return true;
          } catch (fallbackError) {
            this.logger.warn('telegram.preview_archive_fallback_send_failed', { error: String(fallbackError), turnId: active.turnId });
          }
        } else {
          this.logger.warn('telegram.preview_archive_send_failed', { error: String(error), turnId: active.turnId });
        }
        this.scheduleRenderRetry(active);
        return false;
      }
      return true;
    }
    try {
      if (content.html) {
        await this.editHtmlMessage(active.scopeId, active.previewMessageId, content.html, []);
      } else {
        await this.editMessage(active.scopeId, active.previewMessageId, content.text, []);
      }
      this.recordArchivedMessageId(active, active.previewMessageId);
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        active.previewActive = false;
        active.statusMessageText = null;
        active.statusNeedsRebase = false;
        this.store.removeActiveTurnPreview(active.turnId);
        return this.archiveStatusMessage(active, content);
      }
      if (isTelegramMessageTooLong(error)) {
        try {
          await this.editMessage(active.scopeId, active.previewMessageId, firstLine(content.text), []);
          this.recordArchivedMessageId(active, active.previewMessageId);
          active.previewActive = false;
          active.statusMessageText = null;
          active.statusNeedsRebase = false;
          this.store.removeActiveTurnPreview(active.turnId);
          return true;
        } catch (fallbackError) {
          if (isTelegramMessageGone(fallbackError)) {
            active.previewActive = false;
            active.statusMessageText = null;
            active.statusNeedsRebase = false;
            this.store.removeActiveTurnPreview(active.turnId);
            return this.archiveStatusMessage(active, { text: firstLine(content.text), html: null });
          }
          this.logger.warn('telegram.preview_archive_fallback_failed', {
            error: String(fallbackError),
            turnId: active.turnId,
            messageId: active.previewMessageId,
          });
          this.recordArchivedMessageId(active, active.previewMessageId);
          active.previewActive = false;
          active.statusMessageText = null;
          active.statusNeedsRebase = false;
          this.store.removeActiveTurnPreview(active.turnId);
          return true;
        }
      }
      this.logger.warn('telegram.preview_archive_failed', {
        error: String(error),
        turnId: active.turnId,
        messageId: active.previewMessageId,
      });
      this.scheduleRenderRetry(active);
      return false;
    }
    active.previewActive = false;
    active.statusMessageText = null;
    active.statusNeedsRebase = false;
    this.store.removeActiveTurnPreview(active.turnId);
    return true;
  }

  private recordArchivedMessageId(active: ActiveTurn, messageId: number): void {
    if (!active.archivedMessageIds.includes(messageId)) {
      active.archivedMessageIds.push(messageId);
    }
    if (active.previewActive && active.previewMessageId > 0) {
      this.store.saveActiveTurnPreview({
        turnId: active.turnId,
        scopeId: active.scopeId,
        threadId: active.threadId,
        messageId: active.previewMessageId,
        isObserved: active.isObserved,
        archivedMessageIds: active.archivedMessageIds,
      });
    }
  }

  private noteToolCommandStart(active: ActiveTurn, event: RawExecCommandEvent): void {
    if (!active.toolBatch) {
      active.toolBatch = createToolBatchState();
    }
    this.clearToolBatchTimer(active.toolBatch);
    active.toolBatch.openCallIds.add(event.callId);
    const descriptors = describeExecCommand(event);
    for (const descriptor of descriptors) {
      if (active.toolBatch.actionKeys.has(descriptor.key)) {
        continue;
      }
      active.toolBatch.actionKeys.add(descriptor.key);
      active.toolBatch.actionLines.push(descriptor.line);
      incrementToolBatchCount(active.toolBatch.counts, descriptor.kind);
    }
  }

  private noteToolCommandEnd(active: ActiveTurn, event: RawExecCommandEvent): void {
    if (!active.toolBatch) {
      active.toolBatch = createToolBatchState();
    }
    const descriptors = describeExecCommand(event);
    for (const descriptor of descriptors) {
      if (active.toolBatch.actionKeys.has(descriptor.key)) {
        continue;
      }
      active.toolBatch.actionKeys.add(descriptor.key);
      active.toolBatch.actionLines.push(descriptor.line);
      incrementToolBatchCount(active.toolBatch.counts, descriptor.kind);
    }
    active.toolBatch.openCallIds.delete(event.callId);
    this.scheduleToolBatchArchive(active);
  }

  private scheduleToolBatchArchive(active: ActiveTurn): void {
    const batch = active.toolBatch;
    if (!batch || batch.openCallIds.size > 0) {
      return;
    }
    this.clearToolBatchTimer(batch);
    batch.finalizeTimer = setTimeout(() => {
      const current = this.getActiveTurn(active.scopeId, active.turnId);
      if (!current || current.toolBatch !== batch || batch.openCallIds.size > 0) {
        return;
      }
      batch.finalizeTimer = null;
      current.pendingArchivedStatus = renderArchivedToolBatchStatus(this.localeForChat(current.scopeId), batch.counts, batch.actionLines);
      current.toolBatch = null;
      void this.queueTurnRender(current, { forceStatus: true });
    }, 600);
  }

  private promoteReadyToolBatch(active: ActiveTurn): void {
    const batch = active.toolBatch;
    if (!batch || batch.openCallIds.size > 0) {
      return;
    }
    this.clearToolBatchTimer(batch);
    active.pendingArchivedStatus = renderArchivedToolBatchStatus(this.localeForChat(active.scopeId), batch.counts, batch.actionLines);
    active.toolBatch = null;
  }

  private clearToolBatchTimer(batch: ToolBatchState | null): void {
    if (!batch?.finalizeTimer) {
      return;
    }
    clearTimeout(batch.finalizeTimer);
    batch.finalizeTimer = null;
  }

  private scheduleRenderRetry(active: ActiveTurn, delayMs = 1500): void {
    if (active.renderRetryTimer) {
      return;
    }
    active.renderRetryTimer = setTimeout(() => {
      active.renderRetryTimer = null;
      if (!this.getActiveTurn(active.scopeId, active.turnId)) {
        return;
      }
      void this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    }, delayMs);
  }

  private clearRenderRetry(active: ActiveTurn): void {
    if (!active.renderRetryTimer) {
      return;
    }
    clearTimeout(active.renderRetryTimer);
    active.renderRetryTimer = null;
  }

  private async notePendingApprovalStatus(threadId: string, kind: PendingApprovalRecord['kind']): Promise<void> {
    for (const active of this.findActiveTurnsByThreadId(threadId)) {
      active.pendingApprovalKinds.add(kind);
      await this.queueTurnRender(active, { forceStatus: true });
    }
  }

  private async clearPendingApprovalStatus(threadId: string, kind: PendingApprovalRecord['kind']): Promise<void> {
    for (const active of this.findActiveTurnsByThreadId(threadId)) {
      active.pendingApprovalKinds.delete(kind);
      await this.queueTurnRender(active, { forceStatus: true });
    }
  }

  private async syncDraftTurnStream(active: ActiveTurn, force: boolean): Promise<void> {
    for (const segment of active.segments) {
      if (!segment.completed) {
        continue;
      }
      await this.syncSegmentTimeline(active, segment);
    }

    const draftText = this.renderDraftStreamText(active);
    if (draftText === null) {
      active.draftText = null;
      return;
    }
    if (!force && draftText === active.draftText) {
      return;
    }
    if (!active.draftId) {
      active.draftId = crypto.randomInt(1, 2_147_483_647);
    }
    try {
      if (active.richDraftDisabled) {
        await this.sendDraft(active.scopeId, active.draftId, draftText);
      } else {
        await this.sendRichMarkdownDraft(
          active.scopeId,
          active.draftId,
          draftText,
          draftText,
        );
      }
      active.draftText = draftText;
    } catch (error) {
      let finalError: unknown = error;
      if (!active.richDraftDisabled) {
        active.richDraftDisabled = true;
        this.logger.warn('telegram.rich_draft_send_failed', {
          error: String(finalError),
          turnId: active.turnId,
          draftId: active.draftId,
        });
        try {
          await this.sendDraft(active.scopeId, active.draftId, draftText);
          active.draftText = draftText;
          return;
        } catch (fallbackError) {
          finalError = fallbackError;
        }
      }
      this.logger.warn('telegram.draft_send_failed', {
        error: String(finalError),
        turnId: active.turnId,
        draftId: active.draftId,
      });
      this.scheduleRenderRetry(active);
    }
  }

  private renderDraftStreamText(active: ActiveTurn): string | null {
    const locale = this.localeForChat(active.scopeId);
    const streamingSegment = this.findStreamingSegment(active);
    if (streamingSegment) {
      return clipTelegramDraftMessage(streamingSegment.text, t(locale, 'working'));
    }
    return null;
  }

  private findStreamingSegment(active: ActiveTurn): ActiveTurnSegment | null {
    return [...active.segments].reverse().find(segment => !segment.completed && segment.text.trim()) ?? null;
  }

  private findActiveTurnByThreadId(threadId: string): ActiveTurn | null {
    const active = this.findActiveTurnsByThreadId(threadId)
      .filter(turn => this.messaging.canSendToScope(turn.scopeId));
    return active.find(turn => !turn.isObserved) ?? active[0] ?? null;
  }

  private findActiveTurnsByThreadId(threadId: string): ActiveTurn[] {
    return [...this.activeTurns.values()].filter(active => active.threadId === threadId);
  }

  private async syncSegmentTimeline(active: ActiveTurn, segment: ActiveTurnSegment): Promise<void> {
    const chunks = chunkTelegramStreamMessage(segment.text);
    let index = 0;
    while (index < chunks.length) {
      const chunk = chunks[index]!;
      const existing = segment.messages[index];
      if (!existing) {
        try {
          const messageId = await this.sendMessage(active.scopeId, chunk);
          segment.messages.push({ messageId, text: chunk, richHtml: null, richFailedForText: null });
          active.statusNeedsRebase = true;
        } catch (error) {
          this.logger.warn('telegram.stream_send_failed', {
            error: String(error),
            turnId: active.turnId,
            itemId: segment.itemId,
            chunkIndex: index,
          });
          this.scheduleRenderRetry(active);
          return;
        }
        index += 1;
        continue;
      }
      if (existing.text === chunk) {
        index += 1;
        continue;
      }
      try {
        await this.editMessage(active.scopeId, existing.messageId, chunk);
        existing.text = chunk;
        existing.richHtml = null;
        existing.richFailedForText = null;
        index += 1;
      } catch (error) {
        if (isTelegramMessageGone(error)) {
          segment.messages.splice(index);
          continue;
        }
        this.logger.warn('telegram.stream_edit_failed', {
          error: String(error),
          turnId: active.turnId,
          itemId: segment.itemId,
          messageId: existing.messageId,
          chunkIndex: index,
        });
        this.scheduleRenderRetry(active);
        return;
      }
    }

    while (segment.messages.length > chunks.length) {
      const stale = segment.messages.pop();
      if (!stale) {
        break;
      }
      try {
        await this.deleteMessage(active.scopeId, stale.messageId);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.stream_delete_failed', {
            error: String(error),
            turnId: active.turnId,
            itemId: segment.itemId,
            messageId: stale.messageId,
          });
        }
      }
    }

    if (this.shouldPromoteSegmentToRich(active, segment)) {
      await this.promoteSegmentMessagesToRich(active, segment, chunks);
    }
  }

  private shouldPromoteSegmentToRich(active: ActiveTurn, segment: ActiveTurnSegment): boolean {
    return !active.scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)
      && segment.completed
      && segment.outputKind !== 'error'
      && Boolean(segment.text.trim());
  }

  private async promoteSegmentMessagesToRich(
    active: ActiveTurn,
    segment: ActiveTurnSegment,
    chunks: string[],
  ): Promise<void> {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const existing = segment.messages[index];
      if (!existing || !chunk.trim()) {
        continue;
      }
      if (existing.richHtml === chunk || existing.richFailedForText === chunk) {
        continue;
      }
      const keyboard = this.voiceKeyboardForSegment(active, segment, index, chunks.length);
      try {
        await this.messaging.editRichMarkdown(active.scopeId, existing.messageId, chunk, chunk, keyboard);
        existing.richHtml = chunk;
        existing.richFailedForText = null;
      } catch (markdownError) {
        this.logger.warn('telegram.stream_rich_markdown_edit_failed', {
          error: String(markdownError),
          turnId: active.turnId,
          itemId: segment.itemId,
          messageId: existing.messageId,
          chunkIndex: index,
        });
        const richHtml = renderTelegramMarkdownRichHtml(chunk);
        try {
          await this.messaging.editRichHtml(active.scopeId, existing.messageId, richHtml, escapeTelegramHtml(chunk), keyboard);
          existing.richHtml = richHtml;
          existing.richFailedForText = null;
          continue;
        } catch (error) {
        if (isTelegramMessageGone(error)) {
          segment.messages.splice(index);
          return;
        }
        existing.richFailedForText = chunk;
        this.logger.warn('telegram.stream_rich_edit_failed', {
          error: String(error),
          turnId: active.turnId,
          itemId: segment.itemId,
          messageId: existing.messageId,
          chunkIndex: index,
        });
        }
      }
    }
  }

  private voiceKeyboardForSegment(
    active: ActiveTurn,
    segment: ActiveTurnSegment,
    chunkIndex: number,
    chunkCount: number,
  ): Array<Array<{ text: string; callback_data: string }>> | undefined {
    if (
      !this.config.voiceTtsEnabled
      || !this.config.voiceSummaryButtonEnabled
      || active.scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)
      || active.isObserved
      || segment.outputKind !== 'final_answer'
      || chunkIndex !== chunkCount - 1
    ) {
      return undefined;
    }
    const snippetId = segment.voiceSnippetId ?? this.registerVoiceSnippet(active.scopeId, segment.text);
    segment.voiceSnippetId = snippetId;
    const locale = this.localeForChat(active.scopeId);
    return [[{
      text: locale === 'zh' ? '🔊 听总结' : '🔊 Listen',
      callback_data: `voice:${snippetId}`,
    }]];
  }

  private registerVoiceSnippet(scopeId: string, text: string): string {
    this.pruneVoiceSnippets();
    const normalized = normalizeVoiceText(text, this.config.voiceSummaryTextLimit);
    const id = crypto.randomBytes(6).toString('hex');
    this.voiceSnippets.set(id, { scopeId, text: normalized, createdAt: Date.now() });
    this.latestVoiceSnippetByScope.set(scopeId, id);
    return id;
  }

  private pruneVoiceSnippets(): void {
    const expiresBefore = Date.now() - 24 * 60 * 60_000;
    for (const [id, snippet] of this.voiceSnippets.entries()) {
      if (snippet.createdAt < expiresBefore) {
        this.voiceSnippets.delete(id);
        if (this.latestVoiceSnippetByScope.get(snippet.scopeId) === id) {
          this.latestVoiceSnippetByScope.delete(snippet.scopeId);
        }
      }
    }
    while (this.voiceSnippets.size > 100) {
      const oldest = [...this.voiceSnippets.entries()]
        .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
      if (!oldest) break;
      this.voiceSnippets.delete(oldest[0]);
      if (this.latestVoiceSnippetByScope.get(oldest[1].scopeId) === oldest[0]) {
        this.latestVoiceSnippetByScope.delete(oldest[1].scopeId);
      }
    }
  }
}

export { BridgeSessionCore as BridgeController };
