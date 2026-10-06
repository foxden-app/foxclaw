import type { CollaborationModeValue, PendingApprovalRecord, RuntimeStatus } from '../types.js';
import { type AuthSyncClusterAuditResult } from '../auth/cross_node_sync.js';
import type { SelfUpdateStatus } from '../update.js';
import { type TurnOutputKind } from './activity.js';
import { type TelegramRenderRoute } from '../telegram/rendering.js';
import { type ObservedTurnCursor } from './observer.js';
import { type SessionLogCursor } from './session_observer.js';
import type { CodexAuthCandidateState } from '../store/database.js';
import type { TurnInput } from '../codex_app/client.js';

export const AUTH_DELETE_REASON_NEEDS_REPAIR = 'needs_repair';

export const RESTART_PREVIEW_RECOVERY_RETRY_DELAYS_MS = [3000, 7000, 15_000, 30_000, 45_000, 60_000, 60_000, 60_000];

export const TOOL_ARCHIVE_MAX_LINES = 12;

export const TOOL_ARCHIVE_LINE_LIMIT = 240;

export type AuthProactiveRefreshStatus = NonNullable<RuntimeStatus['authProactiveRefresh']>;

export interface CoreCoordinator {
  canSelfUpdate?: () => boolean;
  authCandidateUpdated?: (runtimeId: string, candidateName: string) => Promise<void>;
  authCandidateDeleted?: (runtimeId: string, candidateName: string, reason?: string | null) => Promise<void>;
  recoverAuthCandidate?: (runtimeId: string, candidateName: string, options?: { crossNode?: boolean }) => Promise<boolean>;
  acquireAuthRefreshLease?: (reason: string) => Promise<{ ok: boolean; leaseId: string | null; reason?: string | null }>;
  releaseAuthRefreshLease?: (leaseId: string | null) => Promise<void>;
  getAuthSyncStatus?: () => RuntimeStatus['authSync'];
  authSyncSafeAll?: () => Promise<{ localSynced: number; localSkipped: number; sent: number; skipped: number }>;
  authSyncPushAll?: () => Promise<{ sent: number; skipped: number }>;
  authSyncTest?: () => Promise<{ sent: number; replied: number; missing: string[] }>;
  authSyncAudit?: () => Promise<AuthSyncClusterAuditResult | null>;
  statusUpdated?: (status: RuntimeStatus) => void;
  getServiceStatus?: () => Promise<{
    currentVersion?: string;
    bots: NonNullable<RuntimeStatus['bots']>;
    weixinRuntime?: RuntimeStatus['weixinRuntime'];
    authMirror?: RuntimeStatus['authMirror'];
    authSync?: RuntimeStatus['authSync'];
    authProactiveRefresh?: AuthProactiveRefreshStatus | null;
    lastUpdate?: SelfUpdateStatus | null;
  }>;
  selfUpdateCompleted?: (status: SelfUpdateStatus) => void;
}

export type ServiceRuntimeStatus = NonNullable<Awaited<ReturnType<NonNullable<CoreCoordinator['getServiceStatus']>>>>;

export interface RenderedTelegramMessage {
  messageId: number;
  text: string;
  richHtml?: string | null;
  richFailedForText?: string | null;
}

export interface ActiveTurnSegment {
  itemId: string;
  phase: string | null;
  outputKind: TurnOutputKind;
  isPlan: boolean;
  text: string;
  completed: boolean;
  startedAtMs: number;
  completedAtMs: number | null;
  messages: RenderedTelegramMessage[];
  voiceSnippetId: string | null;
}

export interface ToolBatchCounts {
  files: number;
  searches: number;
  edits: number;
  commands: number;
}

export interface ToolBatchState {
  openCallIds: Set<string>;
  actionKeys: Set<string>;
  actionLines: string[];
  counts: ToolBatchCounts;
  finalizeTimer: NodeJS.Timeout | null;
}

export interface ArchivedStatusContent {
  text: string;
  html: string | null;
}

export interface SelfUpdateBroadcastSummary {
  state: 'sent' | 'pending' | 'disabled';
  sent: number;
  peers: string[];
}

export interface ToolDescriptor {
  kind: keyof ToolBatchCounts;
  key: string;
  line: string;
}

export interface ActiveTurn {
  scopeId: string;
  chatId: string;
  chatType: string;
  topicId: number | null;
  renderRoute: TelegramRenderRoute;
  isObserved: boolean;
  threadId: string;
  turnId: string;
  queuedInputId: string | null;
  previewMessageId: number;
  previewActive: boolean;
  draftId: number | null;
  draftText: string | null;
  richDraftDisabled: boolean;
  buffer: string;
  finalText: string | null;
  interruptRequested: boolean;
  authRetry: AuthRetryContext | null;
  collaborationMode: CollaborationModeValue;
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

export interface ObservedThreadWatcher {
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

export interface PendingUserInputOption {
  label: string;
  description: string | null;
}

export interface PendingUserInputQuestion {
  id: string;
  header: string | null;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: PendingUserInputOption[];
}

export type PendingUserInputStatus = 'pending' | 'submitted' | 'resolved' | 'interrupted';

export type ServerRequestId = string | number;

export interface PendingUserInputRequest {
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

export interface PendingMcpElicitation {
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

export interface PendingPlanImplementation {
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

export interface CodexAuthCandidate {
  name: string;
  path: string;
  isCurrent: boolean;
  disabled: boolean;
  state: CodexAuthCandidateState;
  mtimeMs: number;
  credentialKind: 'chatgpt' | 'api-key' | 'invalid';
  credentialLastRefreshMs: number | null;
  credentialExpiresAtMs: number | null;
  quota: CodexAuthQuotaSnapshot | null;
}

export interface CodexAuthQuotaSnapshot {
  capturedAtMs: number;
  accountId?: string | null;
  quotaIdentityId?: string | null;
  planType: string | null;
  primaryWindowDurationMins: number | null;
  primaryRemainingPercent: number | null;
  primaryResetsAt: number | null;
  secondaryWindowDurationMins: number | null;
  secondaryRemainingPercent: number | null;
  secondaryResetsAt: number | null;
}

export interface CodexAuthQuotaIdentity {
  accountId: string;
  quotaIdentityId: string;
}

export interface CodexAuthState {
  authDir: string;
  authPath: string;
  currentTargetPath: string | null;
  currentLabel: string | null;
  candidates: CodexAuthCandidate[];
}

export interface CodexAuthSwitchResult {
  fromLabel: string | null;
  toLabel: string;
}

export interface CodexAuthSwitchOutcome extends CodexAuthSwitchResult {
  ok: boolean;
  candidateName: string;
  recovered: boolean;
  error: string | null;
  validationFailureKind: CodexAuthRotationReason | null;
  restoredPrevious: boolean;
  autoDeleted: boolean;
  deleteRestarted: boolean;
}

export interface CodexAuthRepairDisposition {
  deleted: boolean;
  restarted: boolean;
}

export interface CodexAuthRefreshAllResult {
  refreshed: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

export interface CodexAuthClusterAuditOutcome {
  audit: AuthSyncClusterAuditResult;
  refresh: CodexAuthRefreshAllResult;
  push: { sent: number; skipped: number };
  refreshSkippedReason: string | null;
}

export interface CodexAuthSelection {
  candidate: CodexAuthCandidate;
  fromLabel: string | null;
  toLabel: string;
}

export type CodexAuthCandidateHealth = 'disabled' | 'needs_repair' | 'ready' | 'low' | 'exhausted' | 'stale' | 'unknown' | 'api-key' | 'invalid';

export type CodexAuthListFilter = 'all' | 'enabled' | 'attention';

export interface CodexAuthListView {
  offset: number;
  pageSize: number;
  filter: CodexAuthListFilter;
  searchTerm: string | null;
}

export interface PendingAuthChoiceList extends CodexAuthListView {
  localId: string;
  chatId: string;
  messageId: number | null;
  candidates: CodexAuthCandidate[];
  createdAt: number;
}

export interface PendingThreadRename {
  scopeId: string;
  threadId: string;
  messageId: number | null;
  createdAt: number;
}

export interface PendingThreadNewCwd {
  scopeId: string;
  messageId: number | null;
  cwdToCreate: string | null;
  confirmationMessageId: number | null;
  createdAt: number;
}

export interface PendingAuthAdd {
  loginId: string;
  scopeId: string;
  name: string;
  path: string;
  previousTargetPath: string | null;
  mode: 'add' | 'repair';
  createdAt: number;
}

export interface AuthRetryContext {
  input: TurnInput[];
  threadId: string;
  cwd: string | null;
  chatId: string;
  chatType: string;
  topicId: number | null;
  collaborationMode: CollaborationModeValue | null | undefined;
  failedAuthTargets: Set<string>;
}

export type CodexAuthRotationReason = 'auth_invalid' | 'quota_limited';

export interface PendingAuthRotation {
  scopeId: string;
  reason: string;
  reasonKind: CodexAuthRotationReason;
  retry: AuthRetryContext | null;
}

export interface RemoteControlStatusState {
  status: string;
  installationId: string | null;
  environmentId: string | null;
}

export type ApprovalAction = 'accept' | 'session' | 'deny';

export type McpElicitationAction = 'accept' | 'decline' | 'cancel';

export class UserFacingError extends Error {}

export const OBSERVED_THREAD_POLL_MS = 1500;

export const OBSERVED_CLI_USER_LABEL = 'codex-cli-user';

export const DEFAULT_COLLABORATION_MODE: CollaborationModeValue = 'default';

export const CODEX_LOCAL_USAGE_REFRESH_MS = 30 * 60_000;

export const CODEX_LOCAL_USAGE_SNAPSHOT_FILENAME = 'codex-local-usage.json';

export const CODEX_AUTH_QUOTA_SNAPSHOT_FILENAME = 'codex-auth-quota.json';

export const CODEX_AUTH_LIST_PAGE_SIZE = 8;

export const CODEX_AUTH_LOW_QUOTA_PERCENT = 10;

export const CODEX_AUTH_STALE_CREDENTIAL_DAYS = 8;

export const CODEX_AUTH_PROACTIVE_REFRESH_DAYS = 8;

export const CODEX_AUTH_PROACTIVE_REFRESH_INTERVAL_MS = 60 * 60_000;

export const CODEX_AUTH_PROACTIVE_REFRESH_INITIAL_DELAY_MS = 5 * 60_000;

export const USER_INPUT_SUBMITTED_NOTICE_MS = 90_000;

export const SELF_UPDATE_STATUS_POLL_MS = 1000;

export const ATTACHMENT_BATCH_MERGE_WINDOW_MS = 120_000;

export const PLAN_IMPLEMENTATION_CODING_MESSAGE = 'Implement the plan.';

export const PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX = 'A previous agent produced the plan below to accomplish the user\'s task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.';

export interface HelpCommandEntry {
  key: string;
  line: string;
}

export const PINNED_HELP_COMMANDS: HelpCommandEntry[] = [
  { key: 'help', line: '/help' },
  { key: 'setup', line: '/setup' },
  { key: 'status', line: '/status' },
  { key: 'threads', line: '/threads [query]' },
  { key: 'auth', line: '/auth' },
];

export const DYNAMIC_HELP_COMMANDS: HelpCommandEntry[] = [
  { key: 'fast', line: '/fast <on|off|toggle>' },
  { key: 'active', line: '/active <steer|queue>' },
  { key: 'rich', line: '/rich' },
  { key: 'account', line: '/account' },
  { key: 'quota', line: '/quota' },
  { key: 'update', line: '/update' },
  { key: 'login_device', line: '/login_device' },
  { key: 'login_cancel', line: '/login_cancel' },
  { key: 'cli', line: '/cli' },
  { key: 'threads_archived', line: '/threads archived [query]' },
  { key: 'open', line: '/open <n>' },
  { key: 'goal', line: '/goal [objective|pause|resume|done|budget <tokens|off>|clear confirm]' },
  { key: 'history', line: '/history [limit]' },
  { key: 'files', line: '/files <query>' },
  { key: 'remote', line: '/remote' },
  { key: 'watch', line: '/watch' },
  { key: 'unwatch', line: '/unwatch' },
  { key: 'steer', line: '/steer <message>' },
  { key: 'takeover', line: '/takeover <message>' },
  { key: 'queue', line: '/queue <message>' },
  { key: 'new', line: '/new [cwd]' },
  { key: 'mode', line: '/mode [default|plan]' },
  { key: 'plan', line: '/plan' },
  { key: 'agent', line: '/agent' },
  { key: 'auth_reload', line: '/auth_reload' },
  { key: 'logout', line: '/logout confirm' },
  { key: 'loaded', line: '/loaded' },
  { key: 'skills', line: '/skills [query]' },
  { key: 'skill', line: '/skill <name>' },
  { key: 'hooks', line: '/hooks' },
  { key: 'plugins', line: '/plugins [query]' },
  { key: 'plugin', line: '/plugin <name>' },
  { key: 'apps', line: '/apps' },
  { key: 'features', line: '/features' },
  { key: 'config', line: '/config' },
  { key: 'requirements', line: '/requirements' },
  { key: 'provider', line: '/provider' },
  { key: 'mcp', line: '/mcp' },
  { key: 'review', line: '/review' },
  { key: 'fork', line: '/fork [name]' },
  { key: 'undo', line: '/undo [n]' },
  { key: 'rename', line: '/rename <name>' },
  { key: 'compact', line: '/compact' },
  { key: 'archive', line: '/archive' },
  { key: 'models', line: '/models' },
  { key: 'permissions', line: '/permissions' },
  { key: 'permissions_arg', line: '/permissions <read-only|default|full-access>' },
  { key: 'reveal', line: '/reveal' },
  { key: 'where', line: '/where' },
  { key: 'interrupt', line: '/interrupt' },
];

export interface RichAuthCandidateRow {
  index: string;
  quotaA: string;
  quotaAReset: string;
  quotaB: string;
  quotaBReset: string;
  name: string;
  current: boolean;
  plan: string;
  health: string;
  refresh: string;
  expiry: string;
  risk: string;
  enabled: boolean | null;
}

export type AuthSyncRuntimeStatus = NonNullable<RuntimeStatus['authSync']>;

export type AuthSyncRuntimeEvent = NonNullable<AuthSyncRuntimeStatus['recentEvents']>[number];
