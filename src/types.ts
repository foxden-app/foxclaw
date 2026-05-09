/** Session row: `chatId` holds the bridge scope id (e.g. `telegram:…`). */
export interface ThreadBinding {
  chatId: string;
  threadId: string;
  cwd: string | null;
  updatedAt: number;
}

export type AppLocale = 'en' | 'zh';
export type ApprovalPolicyValue = 'on-request' | 'on-failure' | 'never' | 'untrusted';
export type SandboxModeValue = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AccessPresetValue = 'read-only' | 'default' | 'full-access';
export type CollaborationModeValue = 'default' | 'plan';
export type ReasoningEffortValue = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ThreadStatusKind = 'active' | 'idle' | 'notLoaded' | 'systemError';

export interface ChatSessionSettings {
  /** Bridge scope id (e.g. `telegram:…`). */
  chatId: string;
  model: string | null;
  reasoningEffort: ReasoningEffortValue | null;
  locale: AppLocale | null;
  accessPreset: AccessPresetValue | null;
  collaborationMode: CollaborationModeValue | null;
  serviceTier: string | null;
  updatedAt: number;
}

export interface CachedThread {
  index: number;
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  modelProvider: string | null;
  status: ThreadStatusKind;
  updatedAt: number;
}

export interface AppThread {
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  modelProvider: string | null;
  source: string | null;
  path: string | null;
  status: ThreadStatusKind;
  updatedAt: number;
}

export interface AppTurnItemSnapshot {
  itemId: string;
  type: string;
  phase: string | null;
  text: string | null;
  command: string | null;
  status: string | null;
  aggregatedOutput: string | null;
}

export interface AppTurnSnapshot {
  turnId: string;
  status: string;
  error: string | null;
  items: AppTurnItemSnapshot[];
}

export interface AppThreadSnapshot extends AppThread {
  activeFlags: string[];
  turns: AppTurnSnapshot[];
}

export interface ThreadSessionState {
  thread: AppThread;
  model: string;
  modelProvider: string;
  reasoningEffort: ReasoningEffortValue | null;
  cwd: string;
}

export interface CodexAccountInfo {
  type: string;
  email: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsSnapshot | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface CodexAccountRateLimits {
  rateLimits: CodexRateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
}

export interface CodexEffectiveConfig {
  model: string | null;
  modelReasoningEffort: ReasoningEffortValue | null;
  planModeReasoningEffort: ReasoningEffortValue | null;
  developerInstructions: string | null;
}

export interface CodexCollaborationModePreset {
  name: string;
  mode: CollaborationModeValue | null;
  model: string | null;
  reasoningEffort: ReasoningEffortValue | null;
}

export interface CodexCollaborationMode {
  mode: CollaborationModeValue;
  settings: {
    model: string;
    reasoning_effort: ReasoningEffortValue | null;
    developer_instructions: string | null;
  };
}

export interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: ReasoningEffortValue[];
  defaultReasoningEffort: ReasoningEffortValue;
  serviceTiers: ModelServiceTier[];
}

export interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export type ApprovalKind = 'command' | 'fileChange';

export interface PendingApprovalRecord {
  localId: string;
  serverRequestId: string;
  kind: ApprovalKind;
  /** Bridge scope id (e.g. `telegram:…`). */
  chatId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId: string | null;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  messageId: number | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface RuntimeStatus {
  running: boolean;
  connected: boolean;
  userAgent: string | null;
  botUsername: string | null;
  currentBindings: number;
  pendingApprovals: number;
  activeTurns: number;
  lastError: string | null;
  updatedAt: string;
  /** Which messaging transports are expected active in this process. */
  channels?: { telegram: boolean; weixin: boolean };
}
