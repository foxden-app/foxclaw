import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { normalizeLocale, t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore, PendingUserInputStoredRecord } from '../store/database.js';
import type {
  AppLocale,
  ActiveTurnMessageMode,
  ChatSessionSettings,
  CodexAccountInfo,
  CodexAccountRateLimits,
  CodexAppInfo,
  CodexCollaborationMode,
  CodexConfigRequirements,
  CodexExperimentalFeature,
  CodexFuzzyFileResult,
  CodexHooksListEntry,
  CodexMcpResourceContent,
  CodexMcpServerStatus,
  CodexModelProviderCapabilities,
  CodexPluginDetail,
  CodexPluginMarketplace,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexSkillMetadata,
  CodexSkillsListEntry,
  CodexThreadGoal,
  CollaborationModeValue,
  AppTurnSnapshot,
  ModelInfo,
  PendingApprovalRecord,
  ReasoningEffortValue,
  ReviewTarget,
  RuntimeStatus,
  ThreadBinding,
  ThreadGoalStatusValue,
  ThreadSessionState,
} from '../types.js';
import { parseCommand } from './commands.js';
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
import { clampServiceTierToModel, resolveFastTierForModel } from './service_tier.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import {
  TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
  buildAttachmentPrompt,
  isNativeImageAttachment,
  planAttachmentStoragePath,
  summarizeTelegramInput,
  type StagedTelegramAttachment,
  type TelegramInboundAttachment,
} from '../telegram/media.js';
import {
  TELEGRAM_MESSAGE_LIMIT,
  chunkTelegramMessage,
  chunkTelegramStreamMessage,
  clipTelegramDraftMessage,
} from '../telegram/text.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../telegram/addressing.js';
import { BridgeMessagingRouter } from '../channels/bridge_messaging_router.js';
import { BRIDGE_SCOPE_WEIXIN_PREFIX, parseTelegramTargetFromBridgeScope, parseWeixinBridgeScope } from '../core/bridge_scope.js';
import { resolveTelegramRenderRoute, type TelegramRenderRoute } from '../telegram/rendering.js';
import type { CodexAppClient, JsonRpcNotification, JsonRpcServerRequest, TurnInput } from '../codex_app/client.js';
import { readCodexLocalUsageStats, type CodexLocalUsageStats } from '../codex_app/local_usage.js';
import {
  normalizeTurnActivityEvent,
  type RawExecCommandEvent,
  type TurnActivityEvent,
  type TurnOutputKind,
} from './activity.js';
import { normalizeAccessPreset, resolveAccessMode } from './access.js';
import { diffObservedTurn, findLatestTurn, findLiveTurn, type ObservedTurnCursor } from './observer.js';
import {
  applySessionLog,
  bootstrapSessionLog,
  splitJsonlChunk,
  type SessionLogCursor,
} from './session_observer.js';
import { renderActiveTurnStatus } from './status.js';
import { writeRuntimeStatus } from '../runtime.js';

interface RenderedTelegramMessage {
  messageId: number;
  text: string;
}

interface ActiveTurnSegment {
  itemId: string;
  phase: string | null;
  outputKind: TurnOutputKind;
  isPlan: boolean;
  text: string;
  completed: boolean;
  messages: RenderedTelegramMessage[];
}

interface ToolBatchCounts {
  files: number;
  searches: number;
  edits: number;
  commands: number;
}

interface ToolBatchState {
  openCallIds: Set<string>;
  actionKeys: Set<string>;
  actionLines: string[];
  counts: ToolBatchCounts;
  finalizeTimer: NodeJS.Timeout | null;
}

interface ArchivedStatusContent {
  text: string;
  html: string | null;
}

interface ToolDescriptor {
  kind: keyof ToolBatchCounts;
  key: string;
  line: string;
}

interface ActiveTurn {
  scopeId: string;
  chatId: string;
  chatType: string;
  topicId: number | null;
  renderRoute: TelegramRenderRoute;
  isObserved: boolean;
  threadId: string;
  turnId: string;
  previewMessageId: number;
  previewActive: boolean;
  draftId: number | null;
  draftText: string | null;
  buffer: string;
  finalText: string | null;
  interruptRequested: boolean;
  authRetry: AuthRetryContext | null;
  statusMessageText: string | null;
  statusNeedsRebase: boolean;
  segments: ActiveTurnSegment[];
  reasoningActiveCount: number;
  pendingApprovalKinds: Set<PendingApprovalRecord['kind']>;
  toolBatch: ToolBatchState | null;
  pendingArchivedStatus: ArchivedStatusContent | null;
  renderRetryTimer: NodeJS.Timeout | null;
  lastStreamFlushAt: number;
  renderRequested: boolean;
  forceStatusFlush: boolean;
  forceStreamFlush: boolean;
  renderTask: Promise<void> | null;
  completion: Promise<void>;
  archivedMessageIds: number[];
  resolver: () => void;
}

interface ObservedThreadWatcher {
  scopeId: string;
  chatId: string;
  chatType: string;
  topicId: number | null;
  threadId: string;
  mode: 'app_snapshot' | 'session_file';
  timer: NodeJS.Timeout | null;
  cursor: ObservedTurnCursor | null;
  activeTurnId: string | null;
  waitingOnApproval: boolean;
  sessionPath: string | null;
  sessionOffset: number;
  sessionRemainder: string;
  sessionCursor: SessionLogCursor;
  stopped: boolean;
}

interface QueuedPromptRequest {
  event: TelegramTextEvent;
  text: string;
}

interface PendingUserInputOption {
  label: string;
  description: string | null;
}

interface PendingUserInputQuestion {
  id: string;
  header: string | null;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: PendingUserInputOption[];
}

type PendingUserInputStatus = 'pending' | 'submitted' | 'resolved' | 'interrupted';
type ServerRequestId = string | number;

interface PendingUserInputRequest {
  localId: string;
  serverRequestId: ServerRequestId;
  chatId: string;
  threadId: string;
  turnId: string | null;
  itemId: string;
  questions: PendingUserInputQuestion[];
  answers: Map<string, string>;
  messageId: number | null;
  status: PendingUserInputStatus;
  createdAt: number;
  submittedAt: number | null;
}

interface PendingMcpElicitation {
  localId: string;
  serverRequestId: ServerRequestId;
  chatId: string;
  threadId: string;
  turnId: string | null;
  serverName: string;
  mode: 'form' | 'url';
  message: string;
  url: string | null;
  requestedSchema: unknown;
  content: unknown;
  messageId: number | null;
  createdAt: number;
}

interface PendingPlanImplementation {
  localId: string;
  scopeId: string;
  chatId: string;
  chatType: string;
  topicId: number | null;
  threadId: string;
  turnId: string;
  cwd: string | null;
  planMarkdown: string;
  messageId: number | null;
  createdAt: number;
}

interface CodexAuthCandidate {
  name: string;
  path: string;
  isCurrent: boolean;
  mtimeMs: number;
}

interface CodexAuthState {
  authDir: string;
  authPath: string;
  currentTargetPath: string | null;
  currentLabel: string | null;
  candidates: CodexAuthCandidate[];
}

interface PendingAuthChoiceList {
  localId: string;
  chatId: string;
  messageId: number | null;
  candidates: CodexAuthCandidate[];
  createdAt: number;
}

interface PendingThreadRename {
  scopeId: string;
  threadId: string;
  messageId: number | null;
  createdAt: number;
}

interface PendingAuthAdd {
  loginId: string;
  scopeId: string;
  name: string;
  path: string;
  previousTargetPath: string | null;
  createdAt: number;
}

interface AuthRetryContext {
  input: TurnInput[];
  threadId: string;
  cwd: string | null;
  chatId: string;
  chatType: string;
  topicId: number | null;
  collaborationMode: CollaborationModeValue | null | undefined;
  failedAuthTargets: Set<string>;
}

interface PendingAuthRotation {
  scopeId: string;
  reason: string;
  retry: AuthRetryContext | null;
}

interface RemoteControlStatusState {
  status: string;
  installationId: string | null;
  environmentId: string | null;
}

type ApprovalAction = 'accept' | 'session' | 'deny';
type McpElicitationAction = 'accept' | 'decline' | 'cancel';
class UserFacingError extends Error {}
const OBSERVED_THREAD_POLL_MS = 1500;
const OBSERVED_CLI_USER_LABEL = 'codex-cli-user';
const DEFAULT_COLLABORATION_MODE: CollaborationModeValue = 'default';
const CODEX_LOCAL_USAGE_CACHE_MS = 30_000;
const USER_INPUT_SUBMITTED_NOTICE_MS = 90_000;
const PLAN_IMPLEMENTATION_CODING_MESSAGE = 'Implement the plan.';
const PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX = 'A previous agent produced the plan below to accomplish the user\'s task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.';

export class BridgeSessionCore {
  private activeTurns = new Map<string, ActiveTurn>();
  private observedThreadWatchers = new Map<string, ObservedThreadWatcher>();
  private queuedPrompts = new Map<string, QueuedPromptRequest>();
  private pendingTurnErrors = new Map<string, string>();
  private pendingUserInputs = new Map<string, PendingUserInputRequest>();
  private pendingMcpElicitations = new Map<string, PendingMcpElicitation>();
  private pendingPlanImplementations = new Map<string, PendingPlanImplementation>();
  private pendingLoginsByScope = new Map<string, string>();
  private pendingLoginScopesById = new Map<string, string>();
  private pendingAuthAddsByLoginId = new Map<string, PendingAuthAdd>();
  private latestTurnDiffs = new Map<string, { scopeId: string; threadId: string; turnId: string; diff: string; updatedAt: number }>();
  private threadTokenUsageAlerts = new Map<string, { turnId: string | null; bucket: number; limit: number }>();
  private pendingAuthChoiceLists = new Map<string, PendingAuthChoiceList>();
  private pendingAuthRotation: PendingAuthRotation | null = null;
  private authRotationInProgress = false;
  private authRotationFailedTargets = new Set<string>();
  private localUsageCache: { expiresAt: number; stats: CodexLocalUsageStats } | null = null;
  private lastRemoteControlStatus: RemoteControlStatusState | null = null;
  private pendingThreadRenames = new Map<string, PendingThreadRename>();
  private locks = new Map<string, Promise<void>>();
  private approvalTimers = new Map<string, NodeJS.Timeout>();
  private submittedUserInputTimers = new Map<string, NodeJS.Timeout>();
  private attachedThreads = new Set<string>();
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
  ) {
    this.messaging = outbound;
  }

  /** Wire Telegram inbound events. Call before {@link startCodexApp}. */
  registerTelegramInboundHandlers(): void {
    this.bot.on('text', (event: TelegramTextEvent) => {
      void this.withLock(event.scopeId, async () => this.handleText(event)).catch((error) => {
        void this.handleAsyncError('telegram.text', error, event.scopeId);
      });
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
    void this.withLock(event.scopeId, async () => this.handleText(event)).catch((error) => {
      void this.handleAsyncError('channel.text', error, event.scopeId);
    });
  }

  /** Start Codex app-server transport and attach RPC listeners. */
  async startCodexApp(): Promise<void> {
    this.app.on('notification', (msg: JsonRpcNotification) => {
      void this.handleNotification(msg).catch((error) => {
        void this.handleAsyncError('codex.notification', error);
      });
    });
    this.app.on('serverRequest', (msg: JsonRpcServerRequest) => {
      void this.handleServerRequest(msg).catch((error) => {
        void this.handleAsyncError('codex.server_request', error);
      });
    });
    this.app.on('connected', () => {
      this.attachedThreads.clear();
      this.lastError = null;
      this.updateStatus();
    });
    this.app.on('disconnected', () => {
      this.attachedThreads.clear();
      this.queuedPrompts.clear();
      this.threadTokenUsageAlerts.clear();
      this.clearObservedThreadWatchers();
      void this.abandonActiveTurns().catch((error) => {
        this.logger.error('codex.disconnect_cleanup_failed', { error: toErrorMeta(error) });
      });
      this.updateStatus();
    });

    await this.app.start();
    await this.restorePendingUserInputs();
    await this.cleanupStaleTurnPreviews();
    this.updateStatus();
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

  async stop(): Promise<void> {
    this.queuedPrompts.clear();
    this.pendingTurnErrors.clear();
    this.pendingUserInputs.clear();
    this.pendingMcpElicitations.clear();
    this.pendingPlanImplementations.clear();
    this.pendingLoginsByScope.clear();
    this.pendingLoginScopesById.clear();
    this.pendingAuthAddsByLoginId.clear();
    this.latestTurnDiffs.clear();
    this.threadTokenUsageAlerts.clear();
    this.pendingAuthChoiceLists.clear();
    this.pendingThreadRenames.clear();
    this.pendingAuthRotation = null;
    this.clearObservedThreadWatchers();
    this.releaseActiveTurnsForBridgeShutdown();
    this.bot.stop();
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
    for (const timer of this.submittedUserInputTimers.values()) {
      clearTimeout(timer);
    }
    this.submittedUserInputTimers.clear();
    await this.app.stop({ terminateServer: false });
    this.updateStatus();
  }

  getRuntimeStatus(): RuntimeStatus {
    return {
      running: true,
      connected: this.app.isConnected(),
      userAgent: this.app.getUserAgent(),
      codexAppServer: this.app.getServerStatus(),
      botUsername: this.botUsername,
      currentBindings: this.store.countBindings(),
      pendingApprovals: this.store.countPendingApprovals(),
      pendingUserInputs: this.store.countPendingUserInputs(),
      activeTurns: this.activeTurns.size,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
      channels: {
        telegram: true,
        weixin: Boolean(this.config.wxEnabled && this.messaging.hasWeixinTransport),
      },
    };
  }

  private async handleText(event: TelegramTextEvent): Promise<void> {
    const scopeId = event.scopeId;
    const locale = this.localeForChat(scopeId, event.languageCode);
    if (scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      this.store.insertAudit('inbound', scopeId, 'weixin.message', summarizeTelegramInput(event.text, event.attachments));
      const command = event.attachments.length === 0 ? parseCommand(event.text) : null;
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

    if (this.findActiveTurn(scopeId)) {
      await this.handleActiveTurnInboundMessage(event, locale, decision.text);
      return;
    }

    await this.startBoundTurnFromEvent(event, locale, decision.text);
  }

  private async handleCommand(event: TelegramTextEvent, locale: AppLocale, name: string, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    switch (name) {
      case 'start':
      case 'help': {
        const weixinNote = scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX) ? t(locale, 'help_weixin_note') : '';
        const lines = [
          t(locale, 'help_commands_title'),
          '/help',
          '/setup',
          '/fast <on|off|toggle>',
          '/active <steer|queue>',
          '/status',
          '/account',
          '/quota',
          '/login_device',
          '/threads [query]',
          '/threads archived [query]',
          '/open <n>',
          '/goal [objective|pause|resume|done|budget <tokens|off>|clear confirm]',
          '/history [limit]',
          '/files <query>',
          '/remote',
          '/watch',
          '/unwatch',
          '/steer <message>',
          '/takeover <message>',
          '/queue <message>',
          '/new [cwd]',
          '/mode [default|plan]',
          '/plan',
          '/agent',
          '/auth',
          '/auth_reload',
          '/logout confirm',
          '/loaded',
          '/skills [query]',
          '/skill <name>',
          '/hooks',
          '/plugins [query]',
          '/plugin <name>',
          '/apps',
          '/features',
          '/config',
          '/requirements',
          '/provider',
          '/mcp',
          '/review',
          '/fork [name]',
          '/undo [n]',
          '/rename <name>',
          '/compact',
          '/archive',
          '/models',
          '/permissions',
          '/permissions <read-only|default|full-access>',
          '/reveal',
          '/where',
          '/interrupt',
          t(locale, 'help_advanced_aliases'),
          t(locale, 'help_plain_text_hint'),
        ];
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
        const fastStatus = await this.resolveFastStatusLabel(locale, settings);
        const appServer = this.app.getServerStatus();
        const appServerLabel = appServer.pid && appServer.port
          ? `${appServer.running ? t(locale, 'status_app_server_running') : t(locale, 'status_app_server_stale')} pid=${appServer.pid} port=${appServer.port}`
          : t(locale, 'none');
        const lines = [
          t(locale, 'status_connected', { value: t(locale, this.app.isConnected() ? 'yes' : 'no') }),
          t(locale, 'status_app_server', { value: appServerLabel }),
          t(locale, 'status_user_agent', { value: this.app.getUserAgent() ?? t(locale, 'unknown') }),
          t(locale, 'status_current_thread', { value: binding?.threadId ?? t(locale, 'none') }),
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
          t(locale, 'status_active_turns', { value: this.activeTurns.size }),
        ];
        lines.push(...await this.buildCodexUsageStatusLines(locale));
        lines.push(...await this.buildCodexLocalUsageStatusLines(locale));
        await this.sendMessage(scopeId, lines.join('\n'));
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
      case 'quota_nudge': {
        await this.handleQuotaNudgeCommand(scopeId, locale, args);
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
        this.queuedPrompts.delete(scopeId);
        await this.stopWatchingScopeThread(scopeId, thread.threadId);
        let binding: ThreadBinding;
        try {
          binding = await this.bindCachedThread(scopeId, thread.threadId);
        } catch (error) {
          if (isThreadNotFoundError(error)) {
            await this.sendMessage(scopeId, t(locale, 'cached_thread_unavailable'));
            return;
          }
          throw error;
        }
        const settings = this.store.getChatSettings(scopeId);
        const lines = [
          t(locale, 'bound_to_thread', { threadId: binding.threadId }),
          t(locale, 'line_title', { value: thread.name || thread.preview || t(locale, 'empty') }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
          t(locale, 'line_cwd', { value: binding.cwd ?? this.config.defaultCwd }),
        ];
        if (this.config.codexAppSyncOnOpen) {
          const revealError = await this.tryRevealThread(scopeId, binding.threadId, 'open');
          lines.push(revealError ? t(locale, 'codex_sync_failed', { error: revealError }) : t(locale, 'opened_in_codex'));
        }
        await this.sendMessage(scopeId, lines.join('\n'));
        return;
      }
      case 'watch': {
        const binding = this.store.getBinding(scopeId);
        if (!binding) {
          await this.sendMessage(scopeId, t(locale, 'watch_no_thread_bound'));
          return;
        }
        const watch = await this.watchThread(scopeId, event.chatId, event.chatType, event.topicId, binding);
        const watchedThreadId = watch.threadId;
        const mode = watch.mode;
        if (mode === 'already') {
          await this.sendMessage(scopeId, t(locale, 'watch_already_enabled', { threadId: watchedThreadId }));
          return;
        }
        if (mode === 'active') {
          await this.sendMessage(scopeId, t(locale, 'watch_started_active', { threadId: watchedThreadId }));
          return;
        }
        await this.sendMessage(scopeId, t(locale, 'watch_started_idle', { threadId: watchedThreadId }));
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
        this.queuedPrompts.delete(scopeId);
        await this.stopWatchingScopeThread(scopeId);
        const binding = await this.createBinding(scopeId, cwd);
        const settings = this.store.getChatSettings(scopeId);
        await this.sendMessage(scopeId, [
          t(locale, 'started_new_thread', { threadId: binding.threadId }),
          t(locale, 'line_cwd', { value: binding.cwd ?? cwd }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
        ].join('\n'));
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
      case 'review': {
        await this.handleReviewCommand(event, locale, args);
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
        await this.handleConfigCommand(scopeId, locale);
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
        await this.showSetupPanel(scopeId, 'mode', undefined, locale);
        return;
      }
      case 'agent': {
        await this.showSetupPanel(scopeId, 'mode', undefined, locale);
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
          this.store.setChatAccessPreset(scopeId, preset);
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
        await this.requestInterrupt(active);
        await this.sendMessage(scopeId, t(locale, 'interrupt_requested_for', { turnId: active.turnId }));
        return;
      }
      default: {
        await this.sendMessage(scopeId, t(locale, 'unknown_command', { name }));
      }
    }
  }

  private async handleCallback(event: TelegramCallbackEvent): Promise<void> {
    const scopeId = event.scopeId;
    const locale = this.localeForChat(scopeId, event.languageCode);
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
    const threadActionMatch = /^thread:(rename|archive|unarchive):(.+)$/.exec(event.data);
    if (threadActionMatch) {
      await this.handleThreadActionCallback(
        event,
        threadActionMatch[1]! as 'rename' | 'archive' | 'unarchive',
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
    const settingsMatch = /^settings:(model|effort|access):(.+)$/.exec(event.data);
    if (settingsMatch) {
      await this.handleSettingsCallback(event, settingsMatch[1]! as 'model' | 'effort' | 'access', settingsMatch[2]!, locale);
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
    if (approval.chatId !== scopeId || (approval.messageId !== null && approval.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'approval_mismatch'));
      return;
    }

    const result = mapApprovalDecision(approval, action);
    await this.app.respond(parseStoredServerRequestId(approval.serverRequestId), result);
    this.store.markApprovalResolved(localId);
    this.clearApprovalTimer(localId);
    await this.clearPendingApprovalStatus(approval.threadId, approval.kind);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    if (approval.messageId !== null) {
      await this.editMessage(scopeId, approval.messageId, renderApprovalMessage(locale, approval, action));
    }
    this.updateStatus();
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    const activity = normalizeTurnActivityEvent(notification);
    if (activity) {
      await this.handleTurnActivityEvent(activity);
      return;
    }

    switch (notification.method) {
      case 'sessionConfigured': {
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
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const params = request.params as any;
        const approval = this.createApprovalRecord('command', request.id, params);
        await this.notePendingApprovalStatus(approval.threadId, approval.kind);
        const locale = this.localeForChat(approval.chatId);
        const messageId = await this.sendMessage(approval.chatId, renderApprovalMessage(locale, approval), approvalKeyboard(locale, approval.localId));
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/fileChange/requestApproval': {
        const params = request.params as any;
        const approval = this.createApprovalRecord('fileChange', request.id, params);
        await this.notePendingApprovalStatus(approval.threadId, approval.kind);
        const locale = this.localeForChat(approval.chatId);
        const messageId = await this.sendMessage(approval.chatId, renderApprovalMessage(locale, approval), approvalKeyboard(locale, approval.localId));
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/permissions/requestApproval': {
        const params = request.params as any;
        const approval = this.createPermissionApprovalRecord(request.id, params);
        await this.notePendingApprovalStatus(approval.threadId, approval.kind);
        const locale = this.localeForChat(approval.chatId);
        const messageId = await this.sendMessage(approval.chatId, renderApprovalMessage(locale, approval), approvalKeyboard(locale, approval.localId));
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
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

  private async handleCodexErrorNotification(params: any): Promise<void> {
    const message = formatCodexNotificationError(params);
    this.lastError = message;
    this.logger.error('codex.notification.error', params);

    const turnId = stringOrNull(params?.turnId);
    const threadId = stringOrNull(params?.threadId);
    const active = turnId
      ? this.activeTurns.get(turnId) ?? null
      : threadId
        ? this.findActiveTurnByThreadId(threadId)
        : null;

    if (active) {
      await this.recordActiveTurnError(active, message);
    } else if (turnId) {
      this.pendingTurnErrors.set(turnId, message);
    }
    if (isCodexAuthRotationError(params)) {
      const scopeId = active?.scopeId ?? (threadId ? this.findChatByThread(threadId) : null);
      if (scopeId) {
        this.pendingAuthRotation = {
          scopeId,
          reason: message,
          retry: active?.authRetry ? cloneAuthRetryContext(active.authRetry) : null,
        };
      }
    }
    this.updateStatus();
    await this.maybeRunPendingAuthRotation();
  }

  private async handleTurnStartedNotification(params: any): Promise<void> {
    const turnId = stringOrNull(params?.turn?.id);
    const threadId = stringOrNull(params?.threadId);
    if (!turnId || !threadId || this.activeTurns.has(turnId)) {
      return;
    }
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId || this.findActiveTurn(scopeId)) {
      return;
    }
    const target = resolveScopeMessageTarget(scopeId);
    if (!target) {
      return;
    }
    await this.registerActiveTurn(scopeId, target.chatId, target.chatType, target.topicId, threadId, turnId, 0);
  }

  private async handleTurnDiffUpdated(params: any): Promise<void> {
    const threadId = stringOrNull(params?.threadId);
    const turnId = stringOrNull(params?.turnId);
    const diff = typeof params?.diff === 'string' ? params.diff : '';
    if (!threadId || !turnId) {
      return;
    }
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      return;
    }
    this.latestTurnDiffs.set(scopeId, { scopeId, threadId, turnId, diff, updatedAt: Date.now() });
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
      await this.sendMessage(scopeId, t(locale, 'goal_cleared_notification', { threadId }));
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
    const active = this.findActiveTurnByThreadId(threadId);
    if (!active) {
      const scopeId = this.findChatByThread(threadId);
      if (scopeId) {
        await this.sendMessage(scopeId, t(this.localeForChat(scopeId), 'mcp_tool_progress', {
          message: truncateInline(message, 220),
        }));
      }
      return;
    }
    active.pendingArchivedStatus = {
      text: t(this.localeForChat(active.scopeId), 'mcp_tool_progress', {
        message: truncateInline(message, 220),
      }),
      html: null,
    };
    await this.queueTurnRender(active, { forceStatus: true });
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
          t(locale, 'auth_add_failed', { value: pendingAuthAdd.name, error: params?.error ?? t(locale, 'unknown') }),
          t(locale, 'auth_add_reverted'),
        ].join('\n'));
        return;
      }
      const stat = await fs.stat(pendingAuthAdd.path).catch(() => null);
      if (!stat?.isFile()) {
        await this.restorePendingAuthAdd(pendingAuthAdd);
        await this.sendMessage(scopeId, [
          t(locale, 'auth_add_missing_file', { value: pendingAuthAdd.name }),
          t(locale, 'auth_add_reverted'),
        ].join('\n'));
        return;
      }
      const lines = [t(locale, 'auth_add_done', { value: pendingAuthAdd.name })];
      lines.push(...await this.buildCodexUsageStatusLines(locale));
      await this.sendMessage(scopeId, lines.join('\n'));
      return;
    }
    await this.sendMessage(scopeId, success
      ? t(locale, 'login_completed')
      : t(locale, 'login_failed', { error: params?.error ?? t(locale, 'unknown') }));
  }

  private async restorePendingAuthAdd(record: PendingAuthAdd): Promise<void> {
    const state = await listCodexAuthState();
    await this.restoreAuthAfterAddFailure(state.authDir, state.authPath, record.previousTargetPath);
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
    this.localUsageCache = null;
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
    await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
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
    if (active.interruptRequested || this.queuedPrompts.has(active.scopeId)) {
      return false;
    }
    if (this.hasPendingUserInputForTurn(active.scopeId, active.turnId)) {
      return false;
    }
    if (this.findPendingPlanImplementation(active.scopeId, active.turnId)) {
      return false;
    }
    const settings = this.store.getChatSettings(active.scopeId);
    if (resolveCollaborationMode(settings?.collaborationMode ?? null) !== 'plan') {
      return false;
    }
    const planMarkdown = extractLatestPlanMarkdown(active);
    if (!planMarkdown) {
      return false;
    }

    const binding = this.store.getBinding(active.scopeId);
    const record: PendingPlanImplementation = {
      localId: crypto.randomBytes(8).toString('hex'),
      scopeId: active.scopeId,
      chatId: active.chatId,
      chatType: active.chatType,
      topicId: active.topicId,
      threadId: active.threadId,
      turnId: active.turnId,
      cwd: binding?.cwd ?? null,
      planMarkdown,
      messageId: null,
      createdAt: Date.now(),
    };
    this.pendingPlanImplementations.set(record.localId, record);
    const locale = this.localeForChat(active.scopeId);
    const messageId = await this.sendMessage(
      active.scopeId,
      renderPlanImplementationPrompt(locale, record),
      planImplementationKeyboard(locale, record.localId),
    );
    record.messageId = messageId;
    return true;
  }

  private findPendingPlanImplementation(scopeId: string, turnId?: string): PendingPlanImplementation | null {
    for (const record of this.pendingPlanImplementations.values()) {
      if (record.scopeId !== scopeId) {
        continue;
      }
      if (turnId !== undefined && record.turnId !== turnId) {
        continue;
      }
      return record;
    }
    return null;
  }

  private clearPlanImplementationPromptsForScope(scopeId: string): void {
    for (const [localId, record] of this.pendingPlanImplementations.entries()) {
      if (record.scopeId === scopeId) {
        this.pendingPlanImplementations.delete(localId);
      }
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
    const record = this.pendingPlanImplementations.get(localId);
    if (!record) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'plan_impl_expired'));
      return;
    }
    if (record.scopeId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'plan_impl_mismatch'));
      return;
    }
    if (action === 'stay') {
      this.pendingPlanImplementations.delete(localId);
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

    this.pendingPlanImplementations.delete(localId);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    const turn = await this.startPlanImplementationTurn(record, action === 'fresh');
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

  private async startPlanImplementationTurn(
    record: PendingPlanImplementation,
    freshContext: boolean,
  ): Promise<{ threadId: string; turnId: string }> {
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
    overrides: { collaborationMode?: CollaborationModeValue | null | undefined; recoverMissingThread?: boolean | undefined } = {},
  ): Promise<{ threadId: string; turnId: string }> {
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    const cwd = binding.cwd ?? this.config.defaultCwd;
    const collaborationMode = await this.buildNativeCollaborationMode(settings, cwd, overrides.collaborationMode);
    const serviceTier = await this.resolveServiceTierForTurn(scopeId, settings);
    try {
      const turn = await this.app.startTurn({
        threadId: binding.threadId,
        input,
        approvalPolicy: access.approvalPolicy,
        sandboxMode: access.sandboxMode,
        cwd,
        model: settings?.model ?? null,
        effort: settings?.reasoningEffort ?? null,
        serviceTier,
        collaborationMode,
      });
      return { threadId: binding.threadId, turnId: turn.id };
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
        overrides.collaborationMode,
      );
      const replacementServiceTier = await this.resolveServiceTierForTurn(scopeId, nextSettings);
      const turn = await this.app.startTurn({
        threadId: replacement.threadId,
        input,
        approvalPolicy: nextAccess.approvalPolicy,
        sandboxMode: nextAccess.sandboxMode,
        cwd: replacementCwd,
        model: nextSettings?.model ?? null,
        effort: nextSettings?.reasoningEffort ?? null,
        serviceTier: replacementServiceTier,
        collaborationMode: replacementCollaborationMode,
      });
      return { threadId: replacement.threadId, turnId: turn.id };
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

  private async registerActiveTurn(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    threadId: string,
    turnId: string,
    previewMessageId: number,
    authRetry: AuthRetryContext | null = null,
  ): Promise<void> {
    const active = this.createActiveTurnState(
      scopeId,
      chatId,
      chatType,
      topicId,
      threadId,
      turnId,
      previewMessageId,
    );
    active.authRetry = authRetry;
    this.activeTurns.set(turnId, active);
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
      previewMessageId,
      previewActive: previewMessageId > 0,
      draftId: null,
      draftText: null,
      buffer: '',
      finalText: null,
      interruptRequested: false,
      authRetry: null,
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

  private async completeTurn(active: ActiveTurn): Promise<void> {
    const locale = this.localeForChat(active.scopeId);
    let shouldMarkPartialOutput = false;
    try {
      await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
      const renderedMessages = active.segments.reduce((count, segment) => count + segment.messages.length, 0);
      if (renderedMessages === 0) {
        const fallbackKey = active.interruptRequested ? 'interrupted' : 'completed';
        const finalChunks = chunkTelegramMessage(active.finalText || active.buffer, undefined, t(locale, fallbackKey));
        for (const chunk of finalChunks) {
          await this.sendMessage(active.scopeId, chunk);
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

  private async handleTurnActivityEvent(activity: TurnActivityEvent): Promise<void> {
    const active = this.activeTurns.get(activity.turnId);
    if (!active) {
      return;
    }

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
          await this.cleanupObservedTransientMessages(active);
          await this.finalizeUserInputsForTurn(active, active.interruptRequested ? 'interrupted' : 'resolved');
          await this.maybeSendPlanImplementationPrompt(active);
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
          this.clearObservedTurnWatcher(active.turnId);
          active.resolver();
          this.activeTurns.delete(active.turnId);
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
    for (const turn of this.activeTurns.values()) {
      if (turn.threadId === threadId) return turn.scopeId;
    }
    return this.store.findChatIdByThreadId(threadId);
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
    writeRuntimeStatus(this.config.statusPath, this.getRuntimeStatus());
  }

  private async sendMessage(
    scopeId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    return this.messaging.sendPlain(scopeId, text, inlineKeyboard);
  }

  private async sendHtmlMessage(
    scopeId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    return this.messaging.sendHtml(scopeId, text, inlineKeyboard);
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
        ? `<b>${escapeTelegramHtml(OBSERVED_CLI_USER_LABEL)}</b>\n<pre>${escapeTelegramHtml(chunk)}</pre>`
        : `<pre>${escapeTelegramHtml(chunk)}</pre>`;
      await this.sendHtmlMessage(scopeId, body);
    }
  }

  private async cleanupObservedTransientMessages(active: ActiveTurn): Promise<void> {
    if (!active.isObserved || !this.hasObservedPersistentReply(active)) {
      return;
    }

    const messageIds = new Set<number>();
    for (const segment of active.segments) {
      if (segment.outputKind === 'final_answer') {
        continue;
      }
      for (const message of segment.messages) {
        messageIds.add(message.messageId);
      }
    }
    for (const messageId of active.archivedMessageIds) {
      messageIds.add(messageId);
    }

    for (const messageId of messageIds) {
      try {
        await this.deleteMessage(active.scopeId, messageId);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.observed_cleanup_delete_failed', {
            error: String(error),
            turnId: active.turnId,
            messageId,
          });
        }
      }
    }
  }

  private hasObservedPersistentReply(active: ActiveTurn): boolean {
    if ((active.finalText || '').trim()) {
      return true;
    }
    return active.segments.some((segment) => (
      segment.outputKind === 'final_answer' && ((segment.text || '').trim().length > 0 || segment.messages.length > 0)
    ));
  }

  private async ensureThreadReady(scopeId: string, binding: ThreadBinding): Promise<ThreadBinding> {
    const attachmentKey = attachedThreadKey(scopeId, binding.threadId);
    if (this.attachedThreads.has(attachmentKey)) {
      return binding;
    }
    try {
      const session = await this.app.resumeThread({
        threadId: binding.threadId,
      });
      return this.storeThreadSession(scopeId, session, 'seed');
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
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
      await this.sendMessage(scopeId, t(this.localeForChat(scopeId), 'bridge_error', { error: formatUserError(error) }));
    } catch (notifyError) {
      this.logger.error('telegram.error_notification_failed', { error: toErrorMeta(notifyError), scopeId });
    }
  }

  private armApprovalTimer(localId: string): void {
    this.clearApprovalTimer(localId);
    const timer = setTimeout(() => {
      void this.expireApproval(localId);
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
    this.clearSubmittedUserInputTimer(localId);
    const timer = setTimeout(() => {
      void this.notifySubmittedUserInputStillWaiting(localId).catch((error) => {
        this.logger.warn('telegram.user_input_waiting_notice_failed', {
          localId,
          error: toErrorMeta(error),
        });
      });
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
      this.store.markApprovalResolved(localId);
      await this.clearPendingApprovalStatus(approval.threadId, approval.kind);
      const locale = this.localeForChat(approval.chatId);
      if (approval.messageId !== null) {
        await this.editMessage(approval.chatId, approval.messageId, renderApprovalMessage(locale, approval, 'deny'));
      } else {
        await this.sendMessage(approval.chatId, t(locale, 'approval_timed_out_denied', { threadId: approval.threadId }));
      }
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
    const session = await this.app.resumeThread({
      threadId,
    });
    return this.storeThreadSession(scopeId, session, 'replace');
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

  private clearObservedTurnWatcher(turnId: string): void {
    for (const watcher of this.observedThreadWatchers.values()) {
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
    const active = this.activeTurns.get(watcher.activeTurnId);
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
    this.activeTurns.delete(active.turnId);
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
    if (watcher.stopped) {
      return;
    }
    watcher.timer = setTimeout(() => {
      watcher.timer = null;
      void this.pollObservedThread(watcher).catch((error) => {
        this.logger.error('codex.observe_thread_failed', {
          scopeId: watcher.scopeId,
          threadId: watcher.threadId,
          error: toErrorMeta(error),
        });
      }).finally(() => {
        if (!watcher.stopped && this.observedThreadWatchers.get(watcher.scopeId) === watcher) {
          this.scheduleObservedThreadPoll(watcher);
        }
      });
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
      await this.stopWatchingScopeThread(watcher.scopeId);
      return 'idle';
    }

    const liveTurn = findLiveTurn(snapshot);
    const latestTurn = findLatestTurn(snapshot);
    if (!liveTurn) {
      if (watcher.activeTurnId && latestTurn && latestTurn.turnId === watcher.activeTurnId) {
        const active = this.activeTurns.get(watcher.activeTurnId);
        if (active) {
          await this.applyObservedTurnSnapshot(watcher, active, latestTurn, false);
          await this.handleTurnActivityEvent({
            kind: 'turn_completed',
            turnId: active.turnId,
            state: 'completed',
          });
        }
      }
      if (watcher.activeTurnId) {
        const staleActive = this.activeTurns.get(watcher.activeTurnId);
        if (staleActive) {
          staleActive.resolver();
          this.activeTurns.delete(staleActive.turnId);
          this.updateStatus();
        }
      }
      watcher.activeTurnId = null;
      watcher.cursor = null;
      watcher.waitingOnApproval = false;
      return 'idle';
    }

    let active = watcher.activeTurnId ? this.activeTurns.get(watcher.activeTurnId) ?? null : null;
    if (!active || watcher.activeTurnId !== liveTurn.turnId) {
      if (watcher.activeTurnId && watcher.activeTurnId !== liveTurn.turnId) {
        const staleActive = this.activeTurns.get(watcher.activeTurnId);
        if (staleActive) {
          staleActive.resolver();
          this.activeTurns.delete(staleActive.turnId);
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
      this.activeTurns.set(liveTurn.turnId, active);
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
    const existing = this.activeTurns.get(turnId);
    if (existing) {
      watcher.activeTurnId = turnId;
      return existing;
    }

    if (watcher.activeTurnId && watcher.activeTurnId !== turnId) {
      const staleActive = this.activeTurns.get(watcher.activeTurnId);
      if (staleActive) {
        staleActive.resolver();
        this.activeTurns.delete(staleActive.turnId);
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
    this.activeTurns.set(turnId, active);
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
      if (!this.activeTurns.has(event.turnId)) {
        await this.ensureObservedActiveTurnState(watcher, event.turnId);
      }
      await this.handleTurnActivityEvent(event);
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
    const scopeId = event.scopeId;
    const nextPrompt = args.join(' ').trim();
    if (!nextPrompt) {
      await this.sendMessage(scopeId, t(locale, 'usage_takeover'));
      return;
    }

    this.queuedPrompts.delete(scopeId);
    const active = this.findActiveTurn(scopeId);
    if (active) {
      if (!active.interruptRequested) {
        await this.requestInterrupt(active);
      }
      await this.sendMessage(scopeId, t(locale, 'interrupt_requested_waiting'));
      await active.completion;
    }

    await this.startBoundTurnFromEvent(event, locale, nextPrompt);
  }

  private async handleQueueCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    const nextPrompt = args.join(' ').trim();
    if (!nextPrompt) {
      await this.sendMessage(scopeId, t(locale, 'usage_queue'));
      return;
    }

    if (!this.findActiveTurn(scopeId)) {
      await this.startBoundTurnFromEvent(event, locale, nextPrompt);
      return;
    }

    const replaced = this.queuedPrompts.has(scopeId);
    this.queuedPrompts.set(scopeId, { event, text: nextPrompt });
    await this.sendMessage(scopeId, t(locale, replaced ? 'queued_prompt_replaced' : 'queued_prompt_set'));
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
    const settings = this.store.getChatSettings(event.scopeId);
    const mode = resolveActiveTurnMessageMode(settings?.activeTurnMessageMode ?? null);
    if (mode === 'queue') {
      await this.queuePromptAfterActiveTurn(event, locale, text);
      return;
    }
    await this.steerActiveTurn(active, event, locale, text);
  }

  private async queuePromptAfterActiveTurn(
    event: TelegramTextEvent,
    locale: AppLocale,
    text: string,
  ): Promise<void> {
    const replaced = this.queuedPrompts.has(event.scopeId);
    this.queuedPrompts.set(event.scopeId, { event, text });
    await this.sendMessage(event.scopeId, t(locale, replaced ? 'queued_prompt_replaced' : 'queued_prompt_set'));
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

  private async startQueuedPromptIfPresent(scopeId: string): Promise<void> {
    if (this.findActiveTurn(scopeId)) {
      return;
    }
    const queued = this.queuedPrompts.get(scopeId);
    if (!queued) {
      return;
    }
    this.queuedPrompts.delete(scopeId);
    await this.startBoundTurnFromEvent(
      queued.event,
      this.localeForChat(scopeId, queued.event.languageCode),
      queued.text,
    );
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
    await this.sendMessage(scopeId, [
      t(locale, 'mode_configured', { value: formatCollaborationModeLabel(locale, mode) }),
      t(locale, 'applies_next_turn'),
    ].join('\n'));
  }

  private async handleAuthReloadCommand(scopeId: string, locale: AppLocale): Promise<void> {
    if (this.activeTurns.size > 0 || this.store.countPendingApprovals() > 0 || this.pendingUserInputs.size > 0 || this.pendingMcpElicitations.size > 0) {
      await this.sendMessage(scopeId, t(locale, 'auth_reload_blocked_active'));
      return;
    }

    await this.sendMessage(scopeId, t(locale, 'auth_reload_restarting'));
    this.pendingTurnErrors.clear();
    this.attachedThreads.clear();
    await this.app.restart();

    const lines = [t(locale, 'auth_reload_done')];
    lines.push(...await this.buildCodexUsageStatusLines(locale));
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleAuthCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() ?? 'list';
    if (action === 'reload' || action === 'restart') {
      await this.handleAuthReloadCommand(scopeId, locale);
      return;
    }
    if (action === 'add') {
      await this.handleAuthAddCommand(scopeId, locale, args.slice(1));
      return;
    }
    if (action !== 'list') {
      await this.sendMessage(scopeId, t(locale, 'usage_auth'));
      return;
    }

    const state = await listCodexAuthState();
    if (state.candidates.length === 0) {
      await this.sendMessage(scopeId, renderAuthListMessage(locale, state));
      return;
    }

    const record: PendingAuthChoiceList = {
      localId: crypto.randomBytes(8).toString('hex'),
      chatId: scopeId,
      messageId: null,
      candidates: state.candidates,
      createdAt: Date.now(),
    };
    this.pendingAuthChoiceLists.set(record.localId, record);
    const messageId = await this.sendMessage(
      scopeId,
      renderAuthListMessage(locale, state),
      authChoiceKeyboard(record),
    );
    record.messageId = messageId;
  }

  private async handleAuthAddCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    if (this.activeTurns.size > 0 || this.store.countPendingApprovals() > 0 || this.pendingUserInputs.size > 0 || this.pendingMcpElicitations.size > 0) {
      await this.sendMessage(scopeId, t(locale, 'auth_reload_blocked_active'));
      return;
    }

    const requestedName = args.join(' ').trim();
    const candidateName = codexAuthCandidateNameFromAddName(requestedName);
    if (!candidateName) {
      await this.sendMessage(scopeId, t(locale, 'usage_auth_add'));
      return;
    }

    const state = await listCodexAuthState();
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
        createdAt: Date.now(),
      });
      await this.sendMessage(scopeId, [
        t(locale, 'auth_add_started', { value: candidateName }),
        t(locale, 'login_url', { value: login.verificationUrl }),
        t(locale, 'login_code', { value: login.userCode }),
        t(locale, 'login_id', { value: login.loginId }),
        t(locale, 'login_cancel_hint', { value: login.loginId }),
      ].join('\n'));
    } catch (error) {
      await this.restoreAuthAfterAddFailure(state.authDir, state.authPath, state.currentTargetPath);
      throw error;
    }
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

  private async handleLoginDeviceCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const login = await this.app.startDeviceLogin();
    const oldLoginId = this.pendingLoginsByScope.get(scopeId);
    if (oldLoginId) {
      this.pendingLoginScopesById.delete(oldLoginId);
    }
    this.pendingLoginsByScope.set(scopeId, login.loginId);
    this.pendingLoginScopesById.set(login.loginId, scopeId);
    await this.sendMessage(scopeId, [
      t(locale, 'login_device_started'),
      t(locale, 'login_url', { value: login.verificationUrl }),
      t(locale, 'login_code', { value: login.userCode }),
      t(locale, 'login_id', { value: login.loginId }),
      t(locale, 'login_cancel_hint', { value: login.loginId }),
    ].join('\n'));
  }

  private async handleLoginCancelCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const loginId = args[0]?.trim() || this.pendingLoginsByScope.get(scopeId) || null;
    if (!loginId) {
      await this.sendMessage(scopeId, t(locale, 'login_cancel_no_pending'));
      return;
    }
    const pendingAuthAdd = this.pendingAuthAddsByLoginId.get(loginId) ?? null;
    await this.app.cancelLogin(loginId);
    this.pendingLoginsByScope.delete(scopeId);
    this.pendingLoginScopesById.delete(loginId);
    this.pendingAuthAddsByLoginId.delete(loginId);
    if (pendingAuthAdd) {
      await this.restorePendingAuthAdd(pendingAuthAdd);
      await this.sendMessage(scopeId, t(locale, 'auth_add_cancelled'));
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

  private async handleDiffCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const diff = this.latestTurnDiffs.get(scopeId);
    if (!diff?.diff.trim()) {
      await this.sendMessage(scopeId, t(locale, 'diff_unavailable'));
      return;
    }
    await this.sendMessage(scopeId, formatDiffMessage(locale, diff.diff));
  }

  private async handleLoadedCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const threadIds = await this.app.listLoadedThreads();
    await this.sendMessage(scopeId, formatLoadedThreadsMessage(locale, threadIds));
  }

  private async handleSkillsCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const forceReload = args[0]?.toLowerCase() === 'reload';
    const query = (forceReload ? args.slice(1) : args).join(' ').trim();
    const entries = await this.listSkillsForScope(scopeId, forceReload);
    await this.sendMessage(scopeId, formatSkillsMessage(locale, entries, query || null, forceReload));
  }

  private async handleSkillCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.sendMessage(scopeId, t(locale, 'usage_skill'));
      return;
    }
    const skill = findSkill(await this.listSkillsForScope(scopeId, false), name);
    if (!skill) {
      await this.sendMessage(scopeId, t(locale, 'skill_not_found', { name }));
      return;
    }
    await this.sendMessage(scopeId, formatSkillDetailMessage(locale, skill));
  }

  private async handleSkillConfigCommand(scopeId: string, locale: AppLocale, args: string[], enabled: boolean): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.sendMessage(scopeId, enabled ? t(locale, 'usage_skill_enable') : t(locale, 'usage_skill_disable'));
      return;
    }
    await this.app.writeSkillConfig({ name }, enabled);
    await this.sendMessage(scopeId, t(locale, enabled ? 'skill_enabled' : 'skill_disabled', { name }));
  }

  private async handleHooksCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const entries = await this.app.listHooks(binding?.cwd ?? this.config.defaultCwd);
    await this.sendMessage(scopeId, formatHooksMessage(locale, entries));
  }

  private async handlePluginsCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const query = args.join(' ').trim() || null;
    const binding = this.store.getBinding(scopeId);
    const marketplaces = await this.app.listPlugins(binding?.cwd ?? this.config.defaultCwd);
    await this.sendMessage(scopeId, formatPluginsMessage(locale, marketplaces, query));
  }

  private async handlePluginCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.sendMessage(scopeId, t(locale, 'usage_plugin'));
      return;
    }
    const plugin = await this.app.readPlugin(name);
    if (!plugin) {
      await this.sendMessage(scopeId, t(locale, 'plugin_not_found', { name }));
      return;
    }
    await this.sendMessage(scopeId, formatPluginDetailMessage(locale, plugin));
  }

  private async handlePluginSkillCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const [marketplace, plugin, ...skillParts] = args;
    const skill = skillParts.join(' ').trim();
    if (!marketplace || !plugin || !skill) {
      await this.sendMessage(scopeId, t(locale, 'usage_plugin_skill'));
      return;
    }
    const contents = await this.app.readPluginSkill(marketplace, plugin, skill);
    await this.sendMessage(scopeId, formatPluginSkillMessage(locale, marketplace, plugin, skill, contents));
  }

  private async handleAppsCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const forceRefetch = args[0]?.toLowerCase() === 'reload';
    const binding = this.store.getBinding(scopeId);
    const apps = await this.app.listApps(binding?.threadId ?? null, forceRefetch);
    await this.sendMessage(scopeId, formatAppsMessage(locale, apps, forceRefetch));
  }

  private async handleFeaturesCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const features = await this.app.listExperimentalFeatures();
    await this.sendMessage(scopeId, formatFeaturesMessage(locale, features));
  }

  private async handleConfigCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const result = await this.app.readConfig(binding?.cwd ?? this.config.defaultCwd, true);
    await this.sendMessage(scopeId, formatConfigMessage(locale, result));
  }

  private async handleRequirementsCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const requirements = await this.app.readConfigRequirements();
    await this.sendMessage(scopeId, formatRequirementsMessage(locale, requirements));
  }

  private async handleProviderCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const capabilities = await this.app.readModelProviderCapabilities();
    await this.sendMessage(scopeId, formatProviderMessage(locale, capabilities));
  }

  private async handleMcpCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const detail = args[0]?.toLowerCase() === 'brief' ? 'toolsAndAuthOnly' : 'full';
    const statuses = await this.app.listMcpServerStatus(detail);
    await this.sendMessage(scopeId, formatMcpStatusMessage(locale, statuses));
  }

  private async handleMcpReloadCommand(scopeId: string, locale: AppLocale): Promise<void> {
    await this.app.reloadMcpServers();
    await this.sendMessage(scopeId, t(locale, 'mcp_reload_done'));
  }

  private async handleMcpLoginCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.sendMessage(scopeId, t(locale, 'usage_mcp_login'));
      return;
    }
    const url = await this.app.loginMcpServer(name);
    await this.sendMessage(scopeId, t(locale, 'mcp_login_started', { name, url: url || t(locale, 'unknown') }));
  }

  private async handleMcpResourceCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const [server, ...uriParts] = args;
    const uri = uriParts.join(' ').trim();
    if (!server || !uri) {
      await this.sendMessage(scopeId, t(locale, 'usage_mcp_resource'));
      return;
    }
    const binding = this.store.getBinding(scopeId);
    const contents = await this.app.readMcpResource(server, uri, binding?.threadId ?? null);
    await this.sendMessage(scopeId, formatMcpResourceMessage(locale, server, uri, contents));
  }

  private async listSkillsForScope(scopeId: string, forceReload: boolean): Promise<CodexSkillsListEntry[]> {
    const binding = this.store.getBinding(scopeId);
    return this.app.listSkills(binding?.cwd ?? this.config.defaultCwd, forceReload);
  }

  private async requireReadyBinding(scopeId: string, locale: AppLocale): Promise<ThreadBinding | null> {
    const binding = this.store.getBinding(scopeId);
    if (!binding) {
      await this.sendMessage(scopeId, t(locale, 'watch_no_thread_bound'));
      return null;
    }
    return this.ensureThreadReady(scopeId, binding);
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
    if (this.activeTurns.size > 0 || this.store.countPendingApprovals() > 0 || this.pendingUserInputs.size > 0 || this.pendingMcpElicitations.size > 0) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_reload_blocked_active'));
      return;
    }
    const candidate = record.candidates[index];
    if (!candidate) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }

    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'auth_choice_recorded'));
    this.pendingAuthChoiceLists.delete(localId);
    if (record.messageId !== null) {
      await this.editMessage(event.scopeId, record.messageId, t(locale, 'auth_switching', { value: candidate.name }), []);
    }
    await this.switchCodexAuthAndRestart(event.scopeId, locale, candidate, false);
  }

  private async maybeRunPendingAuthRotation(): Promise<boolean> {
    if (!this.pendingAuthRotation || this.authRotationInProgress) {
      return false;
    }
    if (this.activeTurns.size > 0 || this.store.countPendingApprovals() > 0 || this.pendingUserInputs.size > 0 || this.pendingMcpElicitations.size > 0) {
      return false;
    }

    const rotation = this.pendingAuthRotation;
    this.pendingAuthRotation = null;
    this.authRotationInProgress = true;
    try {
      const failedTargets = rotation.retry?.failedAuthTargets ?? this.authRotationFailedTargets;
      const candidate = await this.selectNextCodexAuthCandidate(failedTargets);
      const locale = this.localeForChat(rotation.scopeId);
      if (!candidate) {
        await this.sendMessage(rotation.scopeId, t(locale, 'auth_auto_no_candidate', {
          error: formatShortStatusError(rotation.reason),
        }));
        return false;
      }
      await this.sendMessage(rotation.scopeId, t(locale, 'auth_auto_switching', {
        value: candidate.name,
        error: formatShortStatusError(rotation.reason),
      }));
      await this.switchCodexAuthAndRestart(rotation.scopeId, locale, candidate, true);
      if (rotation.retry) {
        await this.retryTurnAfterAuthRotation(rotation.scopeId, locale, rotation.retry);
        return true;
      }
      return false;
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
    const binding = {
      threadId: retry.threadId,
      cwd: retry.cwd,
    };
    let turn: { threadId: string; turnId: string };
    try {
      turn = await this.startTurnWithRecovery(scopeId, binding, retry.input, {
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
    await this.registerActiveTurn(
      scopeId,
      retry.chatId,
      retry.chatType,
      retry.topicId,
      turn.threadId,
      turn.turnId,
      0,
      {
        ...retry,
        threadId: turn.threadId,
        cwd: this.store.getBinding(scopeId)?.cwd ?? retry.cwd,
        failedAuthTargets: new Set(retry.failedAuthTargets),
      },
    );
  }

  private async selectNextCodexAuthCandidate(failedTargets: Set<string>): Promise<CodexAuthCandidate | null> {
    const state = await listCodexAuthState();
    if (state.currentTargetPath) {
      failedTargets.add(state.currentTargetPath);
    }
    const candidates = state.candidates.filter(candidate => !failedTargets.has(candidate.path));
    if (candidates.length === 0) {
      return null;
    }

    const currentIndex = state.currentTargetPath
      ? state.candidates.findIndex(candidate => candidate.path === state.currentTargetPath)
      : -1;
    for (let offset = 1; offset <= state.candidates.length; offset += 1) {
      const candidate = state.candidates[(currentIndex + offset + state.candidates.length) % state.candidates.length];
      if (candidate && !failedTargets.has(candidate.path)) {
        return candidate;
      }
    }
    return candidates[0] ?? null;
  }

  private async switchCodexAuthAndRestart(
    scopeId: string,
    locale: AppLocale,
    candidate: CodexAuthCandidate,
    automatic: boolean,
  ): Promise<void> {
    await switchCodexAuth(candidate.path);
    this.authRotationFailedTargets.delete(candidate.path);
    this.pendingTurnErrors.clear();
    this.attachedThreads.clear();
    await this.app.restart();

    const lines = [t(locale, automatic ? 'auth_auto_done' : 'auth_switch_done', { value: candidate.name })];
    lines.push(...await this.buildCodexUsageStatusLines(locale));
    await this.sendMessage(scopeId, lines.join('\n'));
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
          reasoning_effort: reasoningEffort,
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
        percent: formatUsagePercent(window.usedPercent),
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
      const stats = await this.readCachedCodexLocalUsageStats();
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
          total: formatTokenCount(stats.totals.totalTokens),
          input: formatTokenCount(stats.totals.inputTokens),
          output: formatTokenCount(stats.totals.outputTokens),
          cached: formatTokenCount(stats.totals.cachedInputTokens),
          reasoning: formatTokenCount(stats.totals.reasoningOutputTokens),
        }),
      ];
    } catch (error) {
      this.logger.warn('codex.local_usage_failed', { error: formatUserError(error) });
      return [t(locale, 'status_codex_local_usage_unavailable', { error: formatShortStatusError(error) })];
    }
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

  private async readCachedCodexLocalUsageStats(): Promise<CodexLocalUsageStats> {
    const now = Date.now();
    if (this.localUsageCache && this.localUsageCache.expiresAt > now) {
      return this.localUsageCache.stats;
    }
    const stats = await readCodexLocalUsageStats();
    this.localUsageCache = { stats, expiresAt: now + CODEX_LOCAL_USAGE_CACHE_MS };
    return stats;
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
      const nextEffort = clampEffortToModel(defaultModel, settings?.reasoningEffort ?? null);
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

    const nextEffort = clampEffortToModel(selected, settings?.reasoningEffort ?? null);
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
    try {
      binding = await this.bindCachedThread(scopeId, threadId);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_no_longer_available'));
        return;
      }
      throw error;
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
        ? buildThreadsKeyboard(locale, threadLikes)
        : buildThreadListKeyboard(locale, threadLikes, listState);
      await this.editHtmlMessage(scopeId, event.messageId, text, keyboard);
    }

    let callbackText = t(locale, 'thread_opened');
    if (this.config.codexAppSyncOnOpen) {
      const revealError = await this.tryRevealThread(scopeId, binding.threadId, 'open');
      callbackText = revealError ? t(locale, 'opened_sync_failed_short') : t(locale, 'opened_in_codex_short');
    }
    await this.messaging.answerCallback(event.callbackQueryId, callbackText);
  }

  private async handleThreadActionCallback(
    event: TelegramCallbackEvent,
    action: 'rename' | 'archive' | 'unarchive',
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
    const active = this.activeTurns.get(turnId);
    if (!active || active.scopeId !== scopeId) {
      await this.cleanupStaleInterruptButton(scopeId, event.messageId, locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'turn_already_finished'));
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
        text += `\n\n${formatWeixinWhereNavCopyPaste(locale, false)}`;
      }
      if (messageId !== undefined) {
        await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, false));
        return;
      }
      await this.sendMessage(scopeId, text, whereKeyboard(locale, false));
      return;
    }

    const readyBinding = await this.ensureThreadReady(scopeId, binding);
    const thread = await this.app.readThread(readyBinding.threadId, false);
    if (!thread) {
      let text = t(locale, 'where_thread_unavailable', { threadId: readyBinding.threadId });
      if (parseWeixinBridgeScope(scopeId)) {
        text += `\n\n${formatWeixinWhereNavCopyPaste(locale, true)}`;
      }
      if (messageId !== undefined) {
        await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, false));
        return;
      }
      await this.sendMessage(scopeId, text, whereKeyboard(locale, false));
      return;
    }

    let text = formatWhereMessage(locale, thread, settings, this.config.defaultCwd, access, fastStatus);
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinWhereNavCopyPaste(locale, true)}`;
    }
    if (messageId !== undefined) {
      await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, true));
      return;
    }
    await this.sendMessage(scopeId, text, whereKeyboard(locale, true));
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

  private async showThreadsPanel(
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
      }));
      text += `\n\n${formatWeixinThreadsCopyPaste(locale, rows, searchTerm ?? null, offset)}`;
    }
    const keyboard = parseWeixinBridgeScope(scopeId)
      ? buildThreadsKeyboard(locale, forDisplay)
      : buildThreadListKeyboard(locale, forDisplay, presentationState);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async showModelSettingsPanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    let text = formatModelSettingsMessage(locale, models, settings);
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinModelCopyPaste(locale, models, settings)}`;
    }
    const keyboard = buildModelSettingsKeyboard(locale, models, settings);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
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
    }
    const keyboard = buildSetupPanelKeyboard(locale, { focus, models, settings, access });
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async showAccessSettingsPanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const access = this.resolveEffectiveAccess(scopeId);
    let text = formatAccessSettingsMessage(locale, access);
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinAccessCopyPaste(locale)}`;
    }
    const keyboard = buildAccessSettingsKeyboard(locale, access);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
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
      this.store.setChatAccessPreset(scopeId, nextPreset);
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
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'mode_configured', {
        value: formatCollaborationModeLabel(locale, mode),
      }));
      return;
    }

    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    const value = kind === 'model' ? decodeURIComponent(rawValue) : rawValue;

    if (kind === 'model') {
      if (value === 'default') {
        const defaultModel = resolveCurrentModel(models, null);
        const nextEffort = clampEffortToModel(defaultModel, settings?.reasoningEffort ?? null);
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
      const nextEffort = clampEffortToModel(selected, settings?.reasoningEffort ?? null);
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
    this.store.setChatAccessPreset(scopeId, nextPreset);
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
          collaborationMode: undefined,
          failedAuthTargets: new Set(),
        },
      );
    } catch (error) {
      if (previewMessageId > 0) {
        await this.cleanupTransientPreview(scopeId, previewMessageId);
      }
      throw error;
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
      await this.retirePreviewMessage(
        preview.scopeId,
        preview.messageId,
        t(this.localeForChat(preview.scopeId), 'stale_preview_restarted', { threadId: preview.threadId }),
        preview.turnId,
      );
    }
  }

  private async recoverLiveTurnPreview(preview: {
    scopeId: string;
    threadId: string;
    turnId: string;
    messageId: number;
  }): Promise<boolean> {
    if (this.activeTurns.has(preview.turnId)) {
      return true;
    }
    const target = resolveScopeMessageTarget(preview.scopeId);
    if (!target) {
      return false;
    }
    const snapshot = await this.app.readThreadSnapshot(preview.threadId);
    if (!snapshot) {
      return false;
    }
    const liveTurn = findLiveTurn(snapshot);
    if (!liveTurn || liveTurn.turnId !== preview.turnId) {
      return false;
    }
    if (
      snapshot.activeFlags.includes('waitingOnUserInput')
      && !this.hasPendingUserInputForTurn(preview.scopeId, preview.turnId)
    ) {
      return this.interruptOrphanWaitingUserInput(preview);
    }

    await this.stopWatchingScopeThread(preview.scopeId, preview.threadId);
    const active = this.createActiveTurnState(
      preview.scopeId,
      target.chatId,
      target.chatType,
      target.topicId,
      preview.threadId,
      preview.turnId,
      preview.messageId,
      true,
    );
    this.activeTurns.set(preview.turnId, active);
    const watcher: ObservedThreadWatcher = {
      scopeId: preview.scopeId,
      chatId: target.chatId,
      chatType: target.chatType,
      topicId: target.topicId,
      threadId: preview.threadId,
      mode: 'app_snapshot',
      timer: null,
      cursor: seedObservedTurnCursor(liveTurn),
      activeTurnId: preview.turnId,
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
      turnId: preview.turnId,
    });
    return true;
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

  private async abandonActiveTurns(): Promise<void> {
    const activeTurns = [...this.activeTurns.values()];
    for (const active of activeTurns) {
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
      this.activeTurns.delete(active.turnId);
    }
    if (activeTurns.length > 0) {
      this.updateStatus();
    }
  }

  private releaseActiveTurnsForBridgeShutdown(): void {
    const activeTurns = [...this.activeTurns.values()];
    for (const active of activeTurns) {
      this.clearToolBatchTimer(active.toolBatch);
      this.clearRenderRetry(active);
      active.resolver();
      this.activeTurns.delete(active.turnId);
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
        if (active.isObserved && messageId !== null) {
          active.archivedMessageIds.push(messageId);
        }
      } catch (error) {
        this.logger.warn('telegram.preview_archive_send_failed', { error: String(error), turnId: active.turnId });
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
      if (active.isObserved) {
        active.archivedMessageIds.push(active.previewMessageId);
      }
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        active.previewActive = false;
        active.statusMessageText = null;
        active.statusNeedsRebase = false;
        this.store.removeActiveTurnPreview(active.turnId);
        return this.archiveStatusMessage(active, content);
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
      const current = this.activeTurns.get(active.turnId);
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
      if (!this.activeTurns.has(active.turnId)) {
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
    const active = this.findActiveTurnByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingApprovalKinds.add(kind);
    await this.queueTurnRender(active, { forceStatus: true });
  }

  private async clearPendingApprovalStatus(threadId: string, kind: PendingApprovalRecord['kind']): Promise<void> {
    const active = this.findActiveTurnByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingApprovalKinds.delete(kind);
    await this.queueTurnRender(active, { forceStatus: true });
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
      await this.sendDraft(active.scopeId, active.draftId, draftText);
      active.draftText = draftText;
    } catch (error) {
      this.logger.warn('telegram.draft_send_failed', {
        error: String(error),
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
    for (const active of this.activeTurns.values()) {
      if (active.threadId === threadId) {
        return active;
      }
    }
    return null;
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
          segment.messages.push({ messageId, text: chunk });
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
  }
}

function ensureTurnSegment(
  active: ActiveTurn,
  itemId: string,
  phase?: string | null,
  outputKind?: TurnOutputKind,
  isPlan?: boolean,
): ActiveTurnSegment {
  let segment = active.segments.find((entry) => entry.itemId === itemId);
  if (segment) {
    if (phase !== undefined) {
      segment.phase = phase;
    }
    if (outputKind !== undefined) {
      segment.outputKind = outputKind;
    }
    if (isPlan !== undefined) {
      segment.isPlan = segment.isPlan || isPlan;
    }
    return segment;
  }
  segment = {
    itemId,
    phase: phase ?? null,
    outputKind: outputKind ?? 'commentary',
    isPlan: Boolean(isPlan),
    text: '',
    completed: false,
    messages: [],
  };
  active.segments.push(segment);
  return segment;
}

function createToolBatchState(): ToolBatchState {
  return {
    openCallIds: new Set<string>(),
    actionKeys: new Set<string>(),
    actionLines: [],
    counts: { files: 0, searches: 0, edits: 0, commands: 0 },
    finalizeTimer: null,
  };
}

function incrementToolBatchCount(counts: ToolBatchCounts, kind: keyof ToolBatchCounts): void {
  counts[kind] += 1;
}

function formatToolBatchStatus(
  locale: AppLocale,
  counts: ToolBatchCounts,
  actionLines: string[],
  inProgress: boolean,
): string {
  const heading = formatToolBatchHeading(locale, counts, inProgress);
  const detailLines = actionLines.slice(0, 6);
  if (detailLines.length === 0) {
    return heading;
  }
  return [heading, ...detailLines].join('\n');
}

function renderArchivedToolBatchStatus(
  locale: AppLocale,
  counts: ToolBatchCounts,
  actionLines: string[],
): ArchivedStatusContent {
  const text = formatToolBatchStatus(locale, counts, actionLines, false);
  if (actionLines.length === 0) {
    return { text, html: null };
  }
  const heading = formatToolBatchHeading(locale, counts, false);
  const detailLines = actionLines.slice(0, 12).map(line => escapeTelegramHtml(line));
  const html = [
    `<b>${escapeTelegramHtml(heading)}</b>`,
    `<blockquote expandable>${detailLines.join('\n')}</blockquote>`,
  ].join('\n');
  return { text, html };
}

function formatToolBatchHeading(locale: AppLocale, counts: ToolBatchCounts, inProgress: boolean): string {
  const parts = formatToolBatchCountParts(locale, counts);
  const hasBrowse = counts.files > 0 || counts.searches > 0;
  const hasEdit = counts.edits > 0;
  const hasCommand = counts.commands > 0;
  let verb: string;
  if (hasEdit && !hasBrowse && !hasCommand) {
    verb = locale === 'zh' ? (inProgress ? '正在编辑' : '已编辑') : (inProgress ? 'Editing' : 'Edited');
  } else if (hasBrowse && !hasEdit && !hasCommand) {
    verb = locale === 'zh' ? (inProgress ? '正在浏览' : '已浏览') : (inProgress ? 'Browsing' : 'Browsed');
  } else if (hasCommand && !hasBrowse && !hasEdit) {
    verb = locale === 'zh' ? (inProgress ? '正在运行' : '已运行') : (inProgress ? 'Running' : 'Ran');
  } else {
    verb = locale === 'zh' ? (inProgress ? '正在处理' : '已处理') : (inProgress ? 'Processing' : 'Processed');
  }
  if (parts.length === 0) {
    return locale === 'zh'
      ? `${verb}操作...`
      : `${verb} operations...`;
  }
  return locale === 'zh'
    ? `${verb} ${parts.join('，')}`
    : `${verb} ${parts.join(', ')}`;
}

function formatToolBatchCountParts(locale: AppLocale, counts: ToolBatchCounts): string[] {
  const parts: string[] = [];
  if (counts.files > 0) {
    parts.push(locale === 'zh' ? `${counts.files} 个文件` : pluralize(counts.files, 'file'));
  }
  if (counts.searches > 0) {
    parts.push(locale === 'zh' ? `${counts.searches} 个搜索` : pluralize(counts.searches, 'search'));
  }
  if (counts.edits > 0) {
    parts.push(locale === 'zh' ? `${counts.edits} 个编辑` : pluralize(counts.edits, 'edit'));
  }
  if (counts.commands > 0) {
    parts.push(locale === 'zh' ? `${counts.commands} 个命令` : pluralize(counts.commands, 'command'));
  }
  return parts;
}

function pluralize(count: number, noun: string): string {
  if (count === 1) {
    return `1 ${noun}`;
  }
  const plural = noun === 'search'
    ? 'searches'
    : noun === 'file'
      ? 'files'
      : `${noun}s`;
  return `${count} ${plural}`;
}

function describeExecCommand(event: RawExecCommandEvent): ToolDescriptor[] {
  const descriptors = (event.parsedCmd ?? [])
    .map((entry) => describeParsedCommand(entry))
    .filter((entry): entry is ToolDescriptor => entry !== null);
  if (descriptors.length > 0) {
    return descriptors;
  }
  const commandText = renderShellCommand(event.command);
  return [{
    kind: 'commands',
    key: `command:${commandText}`,
    line: `$ ${commandText}`,
  }];
}

function describeParsedCommand(entry: any): ToolDescriptor | null {
  const type = typeof entry?.type === 'string' ? entry.type : '';
  const path = compactPath(entry?.path ?? entry?.name ?? null);
  const query = typeof entry?.query === 'string' ? entry.query : null;
  switch (type) {
    case 'search':
      return {
        kind: 'searches',
        key: `search:${path ?? '.'}:${query ?? ''}`,
        line: path ? `Searched for ${truncateInline(query || '', 80)} in ${path}` : `Searched for ${truncateInline(query || '', 80)}`,
      };
    case 'read':
      return {
        kind: 'files',
        key: `read:${path ?? 'unknown'}`,
        line: `Read ${path ?? 'file'}`,
      };
    case 'list_files':
      return {
        kind: 'files',
        key: `list:${path ?? 'workspace'}`,
        line: path ? `Listed ${path}` : 'Listed files',
      };
    case 'write':
    case 'edit':
    case 'apply_patch':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Edited ${path ?? 'files'}`,
      };
    case 'move':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Moved ${path ?? 'files'}`,
      };
    case 'copy':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Copied ${path ?? 'files'}`,
      };
    case 'delete':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Deleted ${path ?? 'files'}`,
      };
    case 'mkdir':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Created ${path ?? 'files'}`,
      };
    default:
      return null;
  }
}

function compactPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  return value.replace(/^\.\//, '');
}

function renderShellCommand(command: string[]): string {
  if (command.length >= 3 && (command[0] === '/bin/zsh' || command[0] === 'zsh') && command[1] === '-lc') {
    return command[2] ?? command.join(' ');
  }
  return command.join(' ');
}

function truncateInline(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function parseReviewTarget(args: string[]): ReviewTarget | null {
  if (args.length === 0) {
    return { type: 'uncommittedChanges' };
  }
  const [kind, ...rest] = args;
  if (kind === 'base') {
    const branch = rest.join(' ').trim();
    return branch ? { type: 'baseBranch', branch } : null;
  }
  if (kind === 'commit') {
    const sha = rest[0]?.trim();
    return sha ? { type: 'commit', sha, title: rest.slice(1).join(' ').trim() || null } : null;
  }
  if (kind === 'custom') {
    const instructions = rest.join(' ').trim();
    return instructions ? { type: 'custom', instructions } : null;
  }
  return { type: 'custom', instructions: args.join(' ').trim() };
}

function findSkill(entries: CodexSkillsListEntry[], name: string): CodexSkillMetadata | null {
  const normalized = name.trim().toLowerCase();
  for (const entry of entries) {
    const skill = entry.skills.find(candidate =>
      candidate.name.toLowerCase() === normalized
      || candidate.displayName?.toLowerCase() === normalized);
    if (skill) return skill;
  }
  return null;
}

function formatSkillsMessage(locale: AppLocale, entries: CodexSkillsListEntry[], query: string | null, forceReload: boolean): string {
  const skills = entries.flatMap(entry => entry.skills.map(skill => ({ cwd: entry.cwd, skill })))
    .filter(entry => !query
      || entry.skill.name.toLowerCase().includes(query.toLowerCase())
      || entry.skill.description.toLowerCase().includes(query.toLowerCase()));
  const lines = [
    t(locale, 'skills_title'),
    forceReload ? t(locale, 'skills_reloaded') : null,
    query ? t(locale, 'skills_filter', { value: query }) : null,
  ].filter((line): line is string => Boolean(line));
  if (skills.length === 0) {
    lines.push(t(locale, 'skills_empty'));
  } else {
    for (const { skill } of skills.slice(0, 30)) {
      const enabled = skill.enabled ? 'on' : 'off';
      const label = skill.displayName || skill.name;
      lines.push(`${skill.enabled ? '*' : '-'} ${label} (${enabled})`);
      const desc = skill.shortDescription || skill.description;
      if (desc) {
        lines.push(`  ${truncateInline(desc, 120)}`);
      }
    }
    if (skills.length > 30) {
      lines.push(t(locale, 'list_truncated', { count: skills.length - 30 }));
    }
  }
  const errors = entries.flatMap(entry => entry.errors);
  if (errors.length > 0) {
    lines.push('', t(locale, 'skills_errors'));
    lines.push(...errors.slice(0, 5).map(error => `- ${truncateInline(error, 160)}`));
  }
  return lines.join('\n');
}

function formatSkillDetailMessage(locale: AppLocale, skill: CodexSkillMetadata): string {
  return [
    t(locale, 'skill_title', { name: skill.displayName || skill.name }),
    t(locale, 'skill_name', { value: skill.name }),
    t(locale, 'skill_enabled_state', { value: skill.enabled ? t(locale, 'yes') : t(locale, 'no') }),
    t(locale, 'skill_scope', { value: skill.scope || t(locale, 'unknown') }),
    t(locale, 'skill_path', { value: skill.path || t(locale, 'unknown') }),
    '',
    skill.description || skill.shortDescription || t(locale, 'empty'),
    skill.defaultPrompt ? `\n${t(locale, 'skill_default_prompt', { value: skill.defaultPrompt })}` : '',
  ].filter(Boolean).join('\n');
}

function formatMcpStatusMessage(locale: AppLocale, statuses: CodexMcpServerStatus[]): string {
  const lines = [t(locale, 'mcp_title')];
  if (statuses.length === 0) {
    lines.push(t(locale, 'mcp_empty'));
    return lines.join('\n');
  }
  for (const status of statuses) {
    lines.push(`${status.name}: ${status.authStatus}`);
    lines.push(`  tools: ${status.toolNames.length ? status.toolNames.slice(0, 12).join(', ') : '-'}`);
    if (status.resourceUris.length > 0) {
      lines.push(`  resources: ${status.resourceUris.slice(0, 5).join(', ')}`);
    }
    if (status.resourceTemplateUris.length > 0) {
      lines.push(`  templates: ${status.resourceTemplateUris.slice(0, 5).join(', ')}`);
    }
  }
  return lines.join('\n');
}

function formatMcpResourceMessage(
  locale: AppLocale,
  server: string,
  uri: string,
  contents: CodexMcpResourceContent[],
): string {
  const lines = [t(locale, 'mcp_resource_title', { server, uri })];
  if (contents.length === 0) {
    lines.push(t(locale, 'mcp_resource_empty'));
    return lines.join('\n');
  }
  for (const content of contents.slice(0, 5)) {
    lines.push(`- ${content.type}${content.mimeType ? ` (${content.mimeType})` : ''}${content.uri ? ` ${content.uri}` : ''}`);
    if (content.text) {
      lines.push(truncateInline(content.text, 1500));
    } else if (content.blob) {
      lines.push(t(locale, 'mcp_resource_blob', { size: content.blob.length }));
    }
  }
  return lines.join('\n');
}

function formatDiffMessage(locale: AppLocale, diff: string): string {
  const clipped = diff.length > 3500 ? `${diff.slice(0, 3500)}\n...` : diff;
  return `${t(locale, 'diff_title')}\n${clipped}`;
}

function formatLoadedThreadsMessage(locale: AppLocale, threadIds: string[]): string {
  const lines = [t(locale, 'loaded_title')];
  if (threadIds.length === 0) {
    lines.push(t(locale, 'loaded_empty'));
    return lines.join('\n');
  }
  for (const threadId of threadIds.slice(0, 30)) {
    lines.push(`- ${threadId}`);
  }
  if (threadIds.length > 30) {
    lines.push(t(locale, 'list_truncated', { count: threadIds.length - 30 }));
  }
  return lines.join('\n');
}

function formatHooksMessage(locale: AppLocale, entries: CodexHooksListEntry[]): string {
  const hooks = entries.flatMap(entry => entry.hooks.map(hook => ({ cwd: entry.cwd, hook })));
  const lines = [t(locale, 'hooks_title')];
  if (hooks.length === 0) {
    lines.push(t(locale, 'hooks_empty'));
  } else {
    for (const { hook } of hooks.slice(0, 30)) {
      lines.push(`${hook.enabled ? '*' : '-'} ${hook.key} (${hook.eventName}, ${hook.trustStatus})`);
      const detail = [hook.pluginId ? `plugin=${hook.pluginId}` : null, hook.statusMessage, hook.command].filter(Boolean).join(' · ');
      if (detail) {
        lines.push(`  ${truncateInline(detail, 140)}`);
      }
    }
    if (hooks.length > 30) {
      lines.push(t(locale, 'list_truncated', { count: hooks.length - 30 }));
    }
  }
  const warnings = entries.flatMap(entry => entry.warnings);
  const errors = entries.flatMap(entry => entry.errors);
  if (warnings.length > 0) {
    lines.push('', t(locale, 'hooks_warnings'));
    lines.push(...warnings.slice(0, 5).map(warning => `- ${truncateInline(warning, 160)}`));
  }
  if (errors.length > 0) {
    lines.push('', t(locale, 'hooks_errors'));
    lines.push(...errors.slice(0, 5).map(error => `- ${truncateInline(`${error.path}: ${error.message}`, 180)}`));
  }
  return lines.join('\n');
}

function formatPluginsMessage(locale: AppLocale, marketplaces: CodexPluginMarketplace[], query: string | null): string {
  const plugins = marketplaces.flatMap(marketplace => marketplace.plugins.map(plugin => ({ marketplace, plugin })))
    .filter(entry => !query
      || entry.plugin.name.toLowerCase().includes(query.toLowerCase())
      || entry.plugin.id.toLowerCase().includes(query.toLowerCase()));
  const lines = [t(locale, 'plugins_title')];
  if (query) lines.push(t(locale, 'plugins_filter', { value: query }));
  if (plugins.length === 0) {
    lines.push(t(locale, 'plugins_empty'));
  } else {
    for (const { marketplace, plugin } of plugins.slice(0, 30)) {
      const state = `${plugin.installed ? 'installed' : 'not-installed'}, ${plugin.enabled ? 'on' : 'off'}`;
      lines.push(`${plugin.enabled ? '*' : '-'} ${plugin.name} (${state})`);
      lines.push(`  ${plugin.id} · ${marketplace.displayName || marketplace.name}`);
    }
    if (plugins.length > 30) {
      lines.push(t(locale, 'list_truncated', { count: plugins.length - 30 }));
    }
  }
  return lines.join('\n');
}

function formatPluginDetailMessage(locale: AppLocale, plugin: CodexPluginDetail): string {
  const lines = [
    t(locale, 'plugin_title', { name: plugin.summary.name || plugin.summary.id }),
    `id: ${plugin.summary.id}`,
    `marketplace: ${plugin.marketplaceName}`,
    `state: ${plugin.summary.installed ? 'installed' : 'not-installed'}, ${plugin.summary.enabled ? 'on' : 'off'}`,
    plugin.description ? truncateInline(plugin.description, 400) : null,
  ].filter((line): line is string => Boolean(line));
  if (plugin.skills.length > 0) {
    lines.push('', `skills: ${plugin.skills.slice(0, 12).map(skill => skill.name).join(', ')}`);
  }
  if (plugin.hooks.length > 0) {
    lines.push(`hooks: ${plugin.hooks.slice(0, 12).map(hook => `${hook.eventName}:${hook.key}`).join(', ')}`);
  }
  if (plugin.apps.length > 0) {
    lines.push(`apps: ${plugin.apps.slice(0, 12).map(app => app.name || app.id).join(', ')}`);
  }
  if (plugin.mcpServers.length > 0) {
    lines.push(`mcp: ${plugin.mcpServers.slice(0, 12).join(', ')}`);
  }
  return lines.join('\n');
}

function formatPluginSkillMessage(locale: AppLocale, marketplace: string, plugin: string, skill: string, contents: string | null): string {
  const lines = [t(locale, 'plugin_skill_title', { marketplace, plugin, skill })];
  if (!contents) {
    lines.push(t(locale, 'plugin_skill_empty'));
    return lines.join('\n');
  }
  lines.push(truncateInline(contents, 3500));
  return lines.join('\n');
}

function formatAppsMessage(locale: AppLocale, apps: CodexAppInfo[], forceRefetch: boolean): string {
  const lines = [t(locale, 'apps_title')];
  if (forceRefetch) lines.push(t(locale, 'apps_reloaded'));
  if (apps.length === 0) {
    lines.push(t(locale, 'apps_empty'));
  } else {
    for (const app of apps.slice(0, 30)) {
      const state = `${app.isEnabled ? 'on' : 'off'}, ${app.isAccessible ? 'accessible' : 'blocked'}`;
      lines.push(`${app.isEnabled ? '*' : '-'} ${app.name} (${state})`);
      if (app.description) lines.push(`  ${truncateInline(app.description, 120)}`);
    }
    if (apps.length > 30) {
      lines.push(t(locale, 'list_truncated', { count: apps.length - 30 }));
    }
  }
  return lines.join('\n');
}

function formatFeaturesMessage(locale: AppLocale, features: CodexExperimentalFeature[]): string {
  const lines = [t(locale, 'features_title')];
  if (features.length === 0) {
    lines.push(t(locale, 'features_empty'));
    return lines.join('\n');
  }
  for (const feature of features.slice(0, 40)) {
    lines.push(`${feature.enabled ? '*' : '-'} ${feature.displayName || feature.name} (${feature.stage})`);
    if (feature.description) lines.push(`  ${truncateInline(feature.description, 120)}`);
  }
  if (features.length > 40) {
    lines.push(t(locale, 'list_truncated', { count: features.length - 40 }));
  }
  return lines.join('\n');
}

function formatConfigMessage(locale: AppLocale, result: Record<string, unknown>): string {
  const config = result.config && typeof result.config === 'object' ? result.config as Record<string, unknown> : {};
  const layers = Array.isArray(result.layers) ? result.layers : [];
  const keys = ['model', 'model_provider', 'approval_policy', 'sandbox_mode', 'web_search', 'service_tier', 'profile', 'review_model'];
  const lines = [t(locale, 'config_title')];
  for (const key of keys) {
    const value = config[key];
    lines.push(`${key}: ${value === null || value === undefined ? '-' : formatConfigValue(value)}`);
  }
  lines.push(t(locale, 'config_layers', { count: layers.length }));
  return lines.join('\n');
}

function formatRequirementsMessage(locale: AppLocale, requirements: CodexConfigRequirements | null): string {
  const lines = [t(locale, 'requirements_title')];
  if (!requirements) {
    lines.push(t(locale, 'requirements_empty'));
    return lines.join('\n');
  }
  lines.push(`approval: ${requirements.allowedApprovalPolicies?.join(', ') ?? '-'}`);
  lines.push(`sandbox: ${requirements.allowedSandboxModes?.join(', ') ?? '-'}`);
  lines.push(`web_search: ${requirements.allowedWebSearchModes?.join(', ') ?? '-'}`);
  lines.push(`residency: ${requirements.enforceResidency ?? '-'}`);
  if (requirements.featureRequirements) {
    const features = Object.entries(requirements.featureRequirements)
      .map(([key, value]) => `${key}=${value ? 'on' : 'off'}`)
      .join(', ');
    lines.push(`features: ${truncateInline(features, 500)}`);
  }
  return lines.join('\n');
}

function formatProviderMessage(locale: AppLocale, capabilities: CodexModelProviderCapabilities): string {
  return [
    t(locale, 'provider_title'),
    `webSearch: ${t(locale, capabilities.webSearch ? 'yes' : 'no')}`,
    `imageGeneration: ${t(locale, capabilities.imageGeneration ? 'yes' : 'no')}`,
    `namespaceTools: ${t(locale, capabilities.namespaceTools ? 'yes' : 'no')}`,
  ].join('\n');
}

function formatGoalMessage(locale: AppLocale, goal: CodexThreadGoal | null, prefix?: string): string {
  const lines = [t(locale, 'goal_title')];
  if (prefix) {
    lines.push(prefix);
  }
  if (!goal) {
    lines.push(t(locale, 'goal_empty'));
    return lines.join('\n');
  }
  lines.push(t(locale, 'goal_status', { value: formatGoalStatus(locale, goal.status) }));
  lines.push(t(locale, 'goal_objective', { value: goal.objective || t(locale, 'empty') }));
  lines.push(t(locale, 'goal_budget', {
    value: goal.tokenBudget === null ? t(locale, 'none') : t(locale, 'goal_tokens', { value: formatTokenCount(goal.tokenBudget) }),
  }));
  lines.push(t(locale, 'goal_usage', {
    tokens: formatTokenCount(goal.tokensUsed),
    seconds: formatCompactNumber(goal.timeUsedSeconds),
  }));
  if (goal.updatedAt > 0) {
    lines.push(t(locale, 'goal_updated_at', { value: formatLocalTimestamp(goal.updatedAt) }));
  }
  return lines.join('\n');
}

function formatHistoryMessage(locale: AppLocale, threadId: string, turns: AppTurnSnapshot[]): string {
  const lines = [t(locale, 'history_title', { threadId })];
  if (turns.length === 0) {
    lines.push(t(locale, 'history_empty'));
    return lines.join('\n');
  }
  for (const turn of turns.slice(0, 30)) {
    const time = turn.startedAt ? formatLocalTimestamp(turn.startedAt) : t(locale, 'unknown');
    const itemSummary = summarizeTurnItems(turn.items);
    const error = turn.error ? ` · ${truncateInline(turn.error, 80)}` : '';
    lines.push(`- ${turn.turnId} · ${turn.status} · ${time}${error}`);
    if (itemSummary) {
      lines.push(`  ${itemSummary}`);
    }
  }
  return lines.join('\n');
}

function formatFuzzyFilesMessage(
  locale: AppLocale,
  query: string,
  root: string,
  files: CodexFuzzyFileResult[],
): string {
  const lines = [t(locale, 'files_title', { query, root })];
  if (files.length === 0) {
    lines.push(t(locale, 'files_empty'));
    return lines.join('\n');
  }
  for (const file of files.slice(0, 25)) {
    const displayPath = file.path || file.fileName || '(unknown)';
    lines.push(`- ${displayPath}${file.matchType ? ` (${file.matchType})` : ''}`);
  }
  if (files.length > 25) {
    lines.push(t(locale, 'list_truncated', { count: files.length - 25 }));
  }
  return lines.join('\n');
}

function formatRemoteStatusMessage(locale: AppLocale, status: RemoteControlStatusState | null): string {
  const lines = [t(locale, 'remote_title')];
  if (!status) {
    lines.push(t(locale, 'remote_unknown'));
    return lines.join('\n');
  }
  lines.push(t(locale, 'remote_status', { value: status.status }));
  lines.push(t(locale, 'remote_environment', { value: status.environmentId ?? t(locale, 'none') }));
  lines.push(t(locale, 'remote_installation', { value: status.installationId ?? t(locale, 'none') }));
  return lines.join('\n');
}

function formatGoalStatus(locale: AppLocale, status: ThreadGoalStatusValue): string {
  switch (status) {
    case 'paused':
      return t(locale, 'goal_status_paused');
    case 'budgetLimited':
      return t(locale, 'goal_status_budget_limited');
    case 'complete':
      return t(locale, 'goal_status_complete');
    default:
      return t(locale, 'goal_status_active');
  }
}

function summarizeTurnItems(items: AppTurnSnapshot['items']): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const type = item.type || 'item';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .slice(0, 8)
    .map(([type, count]) => `${type}=${count}`)
    .join(', ');
}

function mapGoalNotification(raw: any): CodexThreadGoal | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const status = raw.status === 'paused' || raw.status === 'budgetLimited' || raw.status === 'complete'
    ? raw.status
    : 'active';
  return {
    threadId: String(raw.threadId ?? ''),
    objective: String(raw.objective ?? ''),
    status,
    tokenBudget: numberOrNull(raw.tokenBudget),
    tokensUsed: numberOrNull(raw.tokensUsed) ?? 0,
    timeUsedSeconds: numberOrNull(raw.timeUsedSeconds) ?? 0,
    createdAt: numberOrNull(raw.createdAt) ?? 0,
    updatedAt: numberOrNull(raw.updatedAt) ?? 0,
  };
}

function formatWarningNotification(locale: AppLocale, method: string, params: any): string {
  if (method === 'configWarning') {
    return [
      t(locale, 'warning_config_title'),
      String(params?.summary ?? t(locale, 'unknown')),
      params?.path ? `path: ${String(params.path)}` : null,
      params?.details ? truncateInline(String(params.details), 600) : null,
    ].filter(Boolean).join('\n');
  }
  if (method === 'deprecationNotice') {
    return [
      t(locale, 'warning_deprecation_title'),
      String(params?.summary ?? t(locale, 'unknown')),
      params?.details ? truncateInline(String(params.details), 600) : null,
    ].filter(Boolean).join('\n');
  }
  if (method === 'guardianWarning') {
    return `${t(locale, 'warning_guardian_title')}\n${String(params?.message ?? t(locale, 'unknown'))}`;
  }
  return `${t(locale, 'warning_title')}\n${String(params?.message ?? t(locale, 'unknown'))}`;
}

function normalizeThreadStatusLabel(raw: any): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw?.type === 'string') {
    return raw.type;
  }
  return 'unknown';
}

function formatThreadTokenUsage(raw: any): { percent: number; total: number; limit: number } | null {
  const total = numberOrNull(raw?.last?.totalTokens ?? raw?.last?.total_tokens);
  const limit = numberOrNull(raw?.modelContextWindow ?? raw?.model_context_window);
  if (total === null || limit === null || total <= 0 || limit <= 0) {
    return null;
  }
  const rawPercent = Math.round((total / limit) * 100);
  const percent = Math.min(100, rawPercent);
  return rawPercent >= 85 ? { percent, total, limit } : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function formatConfigValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(formatConfigValue).join(', ');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      return keys[0]!;
    }
  }
  return truncateInline(JSON.stringify(value), 160);
}

function formatRawLabel(value: unknown): string {
  if (value === null || value === undefined) {
    return 'unknown';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      return keys[0]!;
    }
  }
  return truncateInline(JSON.stringify(value), 160);
}

function renderMcpElicitationMessage(
  locale: AppLocale,
  record: PendingMcpElicitation,
  decision?: McpElicitationAction,
): string {
  const lines = [
    t(locale, 'mcp_elicitation_requested'),
    t(locale, 'mcp_server_name', { value: record.serverName }),
    t(locale, 'line_thread', { value: record.threadId }),
  ];
  if (record.turnId) lines.push(t(locale, 'line_turn', { value: record.turnId }));
  lines.push(t(locale, 'mcp_elicitation_message', { value: record.message || t(locale, 'empty') }));
  if (record.url) {
    lines.push(t(locale, 'mcp_elicitation_url', { value: record.url }));
  }
  if (record.mode === 'form') {
    lines.push(t(locale, 'mcp_elicitation_schema', { value: truncateInline(JSON.stringify(record.requestedSchema ?? {}), 1200) }));
    lines.push(record.content === null
      ? t(locale, 'mcp_elicitation_reply_json')
      : t(locale, 'mcp_elicitation_json_ready'));
  }
  if (decision) {
    lines.push(t(locale, 'line_decision', { value: decision }));
  }
  return lines.join('\n');
}

function mcpElicitationKeyboard(locale: AppLocale, record: PendingMcpElicitation): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_accept'), callback_data: `mcpel:${record.localId}:accept` },
    { text: t(locale, 'button_decline'), callback_data: `mcpel:${record.localId}:decline` },
    { text: t(locale, 'button_cancel'), callback_data: `mcpel:${record.localId}:cancel` },
  ]];
}

function formatPermissionRequestSummary(locale: AppLocale, permissions: any): string {
  const lines: string[] = [];
  if (permissions?.network?.enabled !== undefined && permissions.network.enabled !== null) {
    lines.push(t(locale, 'permission_network', { value: permissions.network.enabled ? t(locale, 'yes') : t(locale, 'no') }));
  }
  const fsPerms = permissions?.fileSystem;
  if (fsPerms?.read?.length) {
    lines.push(t(locale, 'permission_read_paths', { value: fsPerms.read.slice(0, 5).join(', ') }));
  }
  if (fsPerms?.write?.length) {
    lines.push(t(locale, 'permission_write_paths', { value: fsPerms.write.slice(0, 5).join(', ') }));
  }
  if (Array.isArray(fsPerms?.entries) && fsPerms.entries.length > 0) {
    lines.push(t(locale, 'permission_entries', { value: truncateInline(JSON.stringify(fsPerms.entries.slice(0, 5)), 500) }));
  }
  return lines.join('\n');
}

function resolveScopeMessageTarget(scopeId: string): { chatId: string; chatType: string; topicId: number | null } | null {
  if (scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
    const parsed = parseWeixinBridgeScope(scopeId);
    return parsed ? { chatId: parsed.fromUserId, chatType: 'private', topicId: null } : null;
  }
  try {
    const parsed = parseTelegramTargetFromBridgeScope(scopeId);
    return { chatId: parsed.chatId, chatType: parsed.topicId === null ? 'private' : 'supergroup', topicId: parsed.topicId };
  } catch {
    return null;
  }
}

function seedObservedTurnCursor(turn: AppTurnSnapshot): ObservedTurnCursor {
  const agentItems = turn.items.filter((item) => {
    const type = item.type.toLowerCase();
    return type === 'agentmessage' || type === 'assistantmessage' || type === 'plan';
  });
  const itemTexts: Record<string, string> = {};
  for (const item of agentItems) {
    itemTexts[item.itemId] = item.text ?? '';
  }
  return {
    turnId: turn.turnId,
    itemTexts,
    completedItemIds: agentItems.map((item) => item.itemId),
  };
}

function approvalKeyboard(locale: AppLocale, localId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_allow'), callback_data: `approval:${localId}:accept` },
    { text: t(locale, 'button_allow_session'), callback_data: `approval:${localId}:session` },
    { text: t(locale, 'button_deny'), callback_data: `approval:${localId}:deny` },
  ]];
}

function activeTurnKeyboard(locale: AppLocale, turnId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_interrupt'), callback_data: `turn:interrupt:${turnId}` },
  ]];
}

function whereKeyboard(locale: AppLocale, hasBinding: boolean): Array<Array<{ text: string; callback_data: string }>> {
  const firstRow = [
    { text: t(locale, 'button_permissions'), callback_data: 'nav:permissions' },
    { text: t(locale, 'button_models'), callback_data: 'nav:models' },
  ];
  const secondRow = [{ text: t(locale, 'button_threads'), callback_data: 'nav:threads' }];
  if (!hasBinding) {
    return [firstRow, secondRow];
  }
  return [
    [{ text: t(locale, 'button_reveal'), callback_data: 'nav:reveal' }, { text: t(locale, 'button_permissions'), callback_data: 'nav:permissions' }],
    [{ text: t(locale, 'button_models'), callback_data: 'nav:models' }, { text: t(locale, 'button_threads'), callback_data: 'nav:threads' }],
  ];
}

function renderApprovalMessage(locale: AppLocale, record: PendingApprovalRecord, decision?: ApprovalAction): string {
  const lines = [
    t(locale, 'approval_requested', {
      kind: record.kind === 'fileChange'
        ? t(locale, 'approval_kind_fileChange')
        : record.kind === 'permissions'
          ? t(locale, 'approval_kind_permissions')
          : t(locale, 'approval_kind_command'),
    }),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
  ];
  if (record.command) lines.push(t(locale, 'line_command', { value: record.command }));
  if (record.cwd) lines.push(t(locale, 'line_cwd', { value: record.cwd }));
  if (record.reason) lines.push(t(locale, 'line_reason', { value: record.reason }));
  if (record.kind === 'permissions') {
    const permissions = parseApprovalPayload(record.payloadJson)?.permissions ?? {};
    const summary = formatPermissionRequestSummary(locale, permissions);
    if (summary) {
      lines.push(summary);
    }
  }
  if (decision) {
    const decisionKey = decision === 'accept'
      ? 'approval_decision_accept'
      : decision === 'session'
        ? 'approval_decision_session'
        : 'approval_decision_deny';
    lines.push(t(locale, 'line_decision', { value: t(locale, decisionKey) }));
  }
  return lines.join('\n');
}

function mapApprovalDecision(record: PendingApprovalRecord, action: ApprovalAction): unknown {
  if (record.kind === 'permissions') {
    const requested = parseApprovalPayload(record.payloadJson)?.permissions ?? {};
    if (action === 'deny') {
      return { permissions: {}, scope: 'turn' };
    }
    return {
      permissions: grantedPermissionsFromRequest(requested),
      scope: action === 'session' ? 'session' : 'turn',
    };
  }
  const decision = action === 'accept'
    ? 'accept'
    : action === 'session'
      ? 'acceptForSession'
      : 'decline';
  return { decision };
}

function parseApprovalPayload(payloadJson: string | null): any {
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

function grantedPermissionsFromRequest(requested: any): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (requested?.network) {
    result.network = requested.network;
  }
  if (requested?.fileSystem) {
    result.fileSystem = requested.fileSystem;
  }
  return result;
}

function toErrorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}

function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeRequestedCollaborationMode(value: string): CollaborationModeValue | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'plan') {
    return 'plan';
  }
  if (normalized === 'default' || normalized === 'agent') {
    return 'default';
  }
  return null;
}

function normalizeRequestedActiveTurnMessageMode(value: string): ActiveTurnMessageMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'steer' || normalized === 'guide' || normalized === '引导') {
    return 'steer';
  }
  if (normalized === 'queue' || normalized === '排队') {
    return 'queue';
  }
  return null;
}

function resolveCollaborationMode(mode: CollaborationModeValue | null | undefined): CollaborationModeValue {
  return mode ?? DEFAULT_COLLABORATION_MODE;
}

function attachedThreadKey(scopeId: string, threadId: string): string {
  return `${scopeId}:${threadId}`;
}

function codexAuthDir(): string {
  return process.env.CODEX_AUTH_DIR || path.join(os.homedir(), '.codex');
}

async function listCodexAuthState(): Promise<CodexAuthState> {
  const authDir = codexAuthDir();
  const authPath = path.join(authDir, 'auth.json');
  const currentTargetPath = await resolveCurrentAuthTarget(authDir, authPath);
  const candidates: CodexAuthCandidate[] = [];
  const entries = await fs.readdir(authDir, { withFileTypes: true }).catch((error) => {
    if (isFileMissingError(error)) {
      return [];
    }
    throw error;
  });

  for (const entry of entries) {
    if (!isCodexAuthCandidateName(entry.name)) {
      continue;
    }
    const candidatePath = path.join(authDir, entry.name);
    const stat = await fs.stat(candidatePath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    candidates.push({
      name: entry.name,
      path: candidatePath,
      isCurrent: currentTargetPath === candidatePath,
      mtimeMs: stat.mtimeMs,
    });
  }

  candidates.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  return {
    authDir,
    authPath,
    currentTargetPath,
    currentLabel: currentTargetPath ? path.basename(currentTargetPath) : null,
    candidates,
  };
}

function isCodexAuthCandidateName(name: string): boolean {
  if (name === 'auth.json' || name.startsWith('.auth.json.')) {
    return false;
  }
  return name.startsWith('auth.json_') || name.startsWith('auth.json.') || name.startsWith('auth.json-');
}

function codexAuthCandidateNameFromAddName(raw: string): string | null {
  const normalized = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    return null;
  }
  const name = normalized.startsWith('auth.json_')
    || normalized.startsWith('auth.json.')
    || normalized.startsWith('auth.json-')
    ? normalized
    : `auth.json_${normalized}`;
  return isCodexAuthCandidateName(name) ? name : null;
}

async function resolveCurrentAuthTarget(authDir: string, authPath: string): Promise<string | null> {
  const stat = await fs.lstat(authPath).catch(() => null);
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(authPath);
    return path.resolve(authDir, target);
  }
  return authPath;
}

async function pointCodexAuthAtTarget(authDir: string, authPath: string, targetPath: string): Promise<void> {
  await fs.mkdir(authDir, { recursive: true });
  const tempLink = path.join(authDir, `.auth.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.symlink(targetPath, tempLink);
    await fs.rename(tempLink, authPath);
  } catch (error) {
    await fs.unlink(tempLink).catch(() => {});
    throw error;
  }
}

async function switchCodexAuth(targetPath: string): Promise<void> {
  const state = await listCodexAuthState();
  const candidate = state.candidates.find(entry => entry.path === targetPath);
  if (!candidate) {
    throw new Error(`Auth candidate is no longer available: ${path.basename(targetPath)}`);
  }
  await pointCodexAuthAtTarget(state.authDir, state.authPath, candidate.path);
}

function renderAuthListMessage(locale: AppLocale, state: CodexAuthState): string {
  const lines = [
    t(locale, 'auth_list_title'),
    t(locale, 'auth_current', { value: state.currentLabel ?? t(locale, 'none') }),
    t(locale, 'auth_dir', { value: state.authDir }),
  ];
  if (state.candidates.length === 0) {
    lines.push(t(locale, 'auth_no_candidates'));
    return lines.join('\n');
  }
  lines.push(t(locale, 'auth_candidate_count', { value: state.candidates.length }));
  state.candidates.forEach((candidate, index) => {
    const marker = candidate.isCurrent ? ' *' : '';
    lines.push(`${index + 1}. ${candidate.name}${marker}`);
  });
  return lines.join('\n');
}

function authChoiceKeyboard(record: PendingAuthChoiceList): Array<Array<{ text: string; callback_data: string }>> {
  return record.candidates.map((candidate, index) => [{
    text: clipButtonText(`${candidate.isCurrent ? '* ' : ''}${candidate.name}`),
    callback_data: `auth:${record.localId}:${index}`,
  }]);
}

function cloneAuthRetryContext(context: AuthRetryContext): AuthRetryContext {
  return {
    input: context.input,
    threadId: context.threadId,
    cwd: context.cwd,
    chatId: context.chatId,
    chatType: context.chatType,
    topicId: context.topicId,
    collaborationMode: context.collaborationMode,
    failedAuthTargets: new Set(context.failedAuthTargets),
  };
}

function isCodexAuthRotationError(params: any): boolean {
  const code = stringOrNull(params?.error?.codexErrorInfo) ?? stringOrNull(params?.error?.code);
  if (code && /usageLimitExceeded|auth|unauthorized|forbidden|login/i.test(code)) {
    return true;
  }
  const message = stringOrNull(params?.error?.message) ?? '';
  return /(usage limit|rate limit|not authenticated|unauthorized|forbidden|sign in|log in|login|auth)/i.test(message);
}

function formatCodexNotificationError(params: any): string {
  const message = stringOrNull(params?.error?.message);
  if (message) {
    return message;
  }
  const code = stringOrNull(params?.error?.codexErrorInfo) ?? stringOrNull(params?.error?.code);
  if (code) {
    return code;
  }
  return JSON.stringify(params?.error ?? params ?? {});
}

function parseUserInputQuestions(params: any): PendingUserInputQuestion[] {
  const rawQuestions = Array.isArray(params?.questions)
    ? params.questions
    : params?.question
      ? [params.question]
      : [];
  const seenIds = new Set<string>();
  return rawQuestions
    .map((raw: any, index: number): PendingUserInputQuestion | null => {
      const fallbackId = `q${index + 1}`;
      const rawId = stringOrNull(raw?.id) ?? fallbackId;
      const id = seenIds.has(rawId) ? `${rawId}_${index + 1}` : rawId;
      seenIds.add(id);
      const header = stringOrNull(raw?.header);
      const question = stringOrNull(raw?.question) ?? stringOrNull(raw?.prompt) ?? stringOrNull(raw?.text) ?? '';
      const isOther = raw?.isOther === true || raw?.is_other === true;
      const isSecret = raw?.isSecret === true || raw?.is_secret === true;
      const options = Array.isArray(raw?.options)
        ? raw.options
            .map((option: any): PendingUserInputOption | null => {
              const label = stringOrNull(option?.label) ?? stringOrNull(option?.value) ?? stringOrNull(option);
              if (!label) {
                return null;
              }
              return {
                label,
                description: stringOrNull(option?.description),
              };
            })
            .filter((option: PendingUserInputOption | null): option is PendingUserInputOption => option !== null)
        : [];
      if (!header && !question && options.length === 0) {
        return null;
      }
      return { id, header, question, isOther, isSecret, options };
    })
    .filter((question: PendingUserInputQuestion | null): question is PendingUserInputQuestion => question !== null);
}

function parseServerRequestId(raw: unknown): ServerRequestId | null {
  if (typeof raw === 'string' || typeof raw === 'number') {
    return raw;
  }
  return null;
}

function stringifyServerRequestId(id: ServerRequestId): string {
  return String(id);
}

function sameServerRequestId(left: ServerRequestId, right: ServerRequestId): boolean {
  return stringifyServerRequestId(left) === stringifyServerRequestId(right);
}

function parseStoredServerRequestId(raw: string): ServerRequestId {
  if (/^(0|[1-9]\d*)$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) {
      return value;
    }
  }
  return raw;
}

function serializePendingUserInput(record: PendingUserInputRequest): PendingUserInputStoredRecord {
  return {
    localId: record.localId,
    serverRequestId: stringifyServerRequestId(record.serverRequestId),
    chatId: record.chatId,
    threadId: record.threadId,
    turnId: record.turnId,
    itemId: record.itemId,
    messageId: record.messageId,
    questionsJson: JSON.stringify(record.questions),
    answersJson: stringifyPendingUserInputAnswers(record.answers),
    currentQuestionIndex: pendingUserInputCurrentQuestionIndex(record),
    awaitingFreeText: false,
    status: record.status,
    createdAt: record.createdAt,
    submittedAt: record.submittedAt,
    resolvedAt: null,
  };
}

function parseStoredPendingUserInput(record: PendingUserInputStoredRecord): PendingUserInputRequest | null {
  const questions = parseStoredUserInputQuestions(record.questionsJson);
  if (questions.length === 0) {
    return null;
  }
  return {
    localId: record.localId,
    serverRequestId: parseStoredServerRequestId(record.serverRequestId),
    chatId: record.chatId,
    threadId: record.threadId,
    turnId: record.turnId,
    itemId: record.itemId,
    questions,
    answers: parseStoredUserInputAnswers(record.answersJson),
    messageId: record.messageId,
    status: normalizePendingUserInputStatus(record.status),
    createdAt: record.createdAt,
    submittedAt: record.submittedAt,
  };
}

function normalizePendingUserInputStatus(raw: string | null | undefined): PendingUserInputStatus {
  if (raw === 'submitted' || raw === 'resolved' || raw === 'interrupted') {
    return raw;
  }
  return 'pending';
}

function parseStoredUserInputQuestions(rawJson: string): PendingUserInputQuestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((raw: any, index): PendingUserInputQuestion | null => {
      const id = stringOrNull(raw?.id) ?? `q${index + 1}`;
      const question = stringOrNull(raw?.question) ?? '';
      const options = Array.isArray(raw?.options)
        ? raw.options
            .map((option: any): PendingUserInputOption | null => {
              const label = stringOrNull(option?.label);
              if (!label) {
                return null;
              }
              return {
                label,
                description: stringOrNull(option?.description),
              };
            })
            .filter((option: PendingUserInputOption | null): option is PendingUserInputOption => option !== null)
        : [];
      return {
        id,
        header: stringOrNull(raw?.header),
        question,
        isOther: raw?.isOther === true,
        isSecret: raw?.isSecret === true,
        options,
      };
    })
    .filter((question: PendingUserInputQuestion | null): question is PendingUserInputQuestion => question !== null);
}

function stringifyPendingUserInputAnswers(answers: Map<string, string>): string {
  return JSON.stringify(Object.fromEntries(answers.entries()));
}

function parseStoredUserInputAnswers(rawJson: string): Map<string, string> {
  const answers = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return answers;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return answers;
  }
  for (const [id, rawAnswer] of Object.entries(parsed)) {
    const answer = normalizeStoredUserInputAnswer(rawAnswer);
    if (answer !== null) {
      answers.set(id, answer);
    }
  }
  return answers;
}

function normalizeStoredUserInputAnswer(rawAnswer: unknown): string | null {
  if (typeof rawAnswer === 'string') {
    return rawAnswer;
  }
  if (Array.isArray(rawAnswer)) {
    const first = rawAnswer.find((entry): entry is string => typeof entry === 'string');
    return first ?? null;
  }
  if (rawAnswer && typeof rawAnswer === 'object') {
    const nested = (rawAnswer as { answers?: unknown }).answers;
    return normalizeStoredUserInputAnswer(nested);
  }
  return null;
}

function pendingUserInputCurrentQuestionIndex(record: PendingUserInputRequest): number {
  const index = record.questions.findIndex(question => !record.answers.has(question.id));
  return index === -1 ? record.questions.length : index;
}

function renderUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRequest,
): string {
  const lines = [
    t(locale, 'user_input_requested'),
    t(locale, 'line_thread', { value: record.threadId }),
  ];
  if (record.turnId) {
    lines.push(t(locale, 'line_turn', { value: record.turnId }));
  }

  record.questions.forEach((question, index) => {
    lines.push('');
    const title = question.header || question.question || question.id;
    lines.push(`${index + 1}. ${title}`);
    if (question.header && question.question) {
      lines.push(question.question);
    }
    if (question.isOther) {
      lines.push(t(locale, 'user_input_other_hint'));
    }
    if (question.isSecret) {
      lines.push(t(locale, 'user_input_secret_warning'));
    }
    question.options.forEach((option, optionIndex) => {
      const description = option.description ? ` - ${option.description}` : '';
      lines.push(`${optionIndex + 1}) ${option.label}${description}`);
    });
    const answer = record.answers.get(question.id);
    if (answer) {
      lines.push(t(locale, 'user_input_selected', { value: answer }));
    }
  });

  lines.push('');
  const statusKey = record.status === 'submitted'
    ? 'user_input_submitted_waiting'
    : record.status === 'interrupted'
      ? 'user_input_interrupted'
      : record.status === 'resolved'
        ? 'user_input_submitted'
        : 'user_input_reply_hint';
  lines.push(t(locale, statusKey));
  return lines.join('\n');
}

function userInputKeyboard(record: PendingUserInputRequest): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  record.questions.forEach((question, questionIndex) => {
    if (record.answers.has(question.id) || question.options.length === 0) {
      return;
    }
    rows.push(question.options.map((option, optionIndex) => ({
      text: clipButtonText(record.questions.length > 1 ? `${questionIndex + 1}. ${option.label}` : option.label),
      callback_data: `ui:${record.localId}:${questionIndex}:${optionIndex}`,
    })));
  });
  return rows;
}

function renderPlanImplementationPrompt(locale: AppLocale, record: PendingPlanImplementation): string {
  return [
    t(locale, 'plan_impl_title'),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
    '',
    t(locale, 'plan_impl_prompt'),
  ].join('\n');
}

function planImplementationKeyboard(locale: AppLocale, localId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [{ text: t(locale, 'plan_impl_button_run'), callback_data: `planimpl:${localId}:run` }],
    [{ text: t(locale, 'plan_impl_button_fresh'), callback_data: `planimpl:${localId}:fresh` }],
    [{ text: t(locale, 'plan_impl_button_stay'), callback_data: `planimpl:${localId}:stay` }],
  ];
}

function extractLatestPlanMarkdown(active: ActiveTurn): string | null {
  for (let index = active.segments.length - 1; index >= 0; index -= 1) {
    const segment = active.segments[index]!;
    if (!segment.isPlan) {
      continue;
    }
    const text = segment.text.trim();
    if (text) {
      return text;
    }
  }
  const tagged = extractLatestProposedPlanBlock([
    active.finalText,
    active.buffer,
    ...active.segments.map(segment => segment.text),
  ].filter((text): text is string => typeof text === 'string' && text.length > 0).join('\n'));
  return tagged;
}

function extractLatestProposedPlanBlock(text: string): string | null {
  const pattern = /<proposed_plan\b[^>]*>([\s\S]*?)<\/proposed_plan>/gi;
  let latest: string | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const plan = match[1]?.trim();
    if (plan) {
      latest = plan;
    }
  }
  return latest;
}

function clipButtonText(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}...` : trimmed;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function selectCodexRateLimitSnapshot(limits: CodexAccountRateLimits | null): CodexRateLimitSnapshot | null {
  return limits?.rateLimitsByLimitId?.codex
    ?? Object.values(limits?.rateLimitsByLimitId ?? {})[0]
    ?? limits?.rateLimits
    ?? null;
}

function formatCodexAccountLabel(account: CodexAccountInfo): string {
  if (account.type === 'chatgpt') {
    return 'ChatGPT';
  }
  if (account.type === 'apiKey') {
    return 'API key';
  }
  if (account.type === 'amazonBedrock') {
    return 'Amazon Bedrock';
  }
  return formatPlanTypeLabel(account.type || 'unknown');
}

function formatPlanTypeLabel(value: string): string {
  const words = value
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return 'Unknown';
  }
  return words
    .map((word) => word.toLowerCase() === 'api' ? 'API' : `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function formatRateLimitWindowLabel(locale: AppLocale, window: CodexRateLimitWindow, fallback: 'primary' | 'secondary'): string {
  const minutes = window.windowDurationMins;
  if (!minutes || minutes <= 0) {
    return fallback === 'primary'
      ? (locale === 'zh' ? '短周期' : 'Primary window')
      : (locale === 'zh' ? '长周期' : 'Secondary window');
  }
  if (minutes % 10080 === 0) {
    const days = minutes / 1440;
    return locale === 'zh' ? `${formatCompactNumber(days)}天` : `${formatCompactNumber(days)}d window`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return locale === 'zh' ? `${formatCompactNumber(days)}天` : `${formatCompactNumber(days)}d window`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return locale === 'zh' ? `${formatCompactNumber(hours)}小时` : `${formatCompactNumber(hours)}h window`;
  }
  return locale === 'zh' ? `${formatCompactNumber(minutes)}分钟` : `${formatCompactNumber(minutes)}m window`;
}

function formatUsagePercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '?';
  }
  return formatCompactNumber(value);
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '?';
  }
  return Math.round(value).toLocaleString('en-US');
}

function formatLocalTimestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatShortStatusError(error: unknown): string {
  const message = formatUserError(error).replace(/\s+/g, ' ').trim();
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && /(thread not found|no rollout found for thread id)/i.test(error.message);
}

function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}

function isFileMissingError(error: unknown): boolean {
  return error instanceof Error && /enoent|no such file or directory/i.test(error.message);
}

async function isReadableSessionPath(sessionPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(sessionPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export { BridgeSessionCore as BridgeController };
