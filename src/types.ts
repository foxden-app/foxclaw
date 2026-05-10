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
export type ActiveTurnMessageMode = 'steer' | 'queue';
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
  activeTurnMessageMode: ActiveTurnMessageMode | null;
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
  archived: boolean;
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
  itemsView?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
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

export interface CodexLoginDeviceCode {
  type: 'chatgptDeviceCode';
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface CodexSkillMetadata {
  name: string;
  description: string;
  shortDescription: string | null;
  path: string;
  scope: string;
  enabled: boolean;
  displayName: string | null;
  defaultPrompt: string | null;
}

export interface CodexSkillsListEntry {
  cwd: string;
  skills: CodexSkillMetadata[];
  errors: string[];
}

export interface CodexMcpServerStatus {
  name: string;
  authStatus: string;
  toolNames: string[];
  resourceUris: string[];
  resourceTemplateUris: string[];
}

export interface CodexMcpResourceContent {
  type: string;
  text: string | null;
  blob: string | null;
  mimeType: string | null;
  uri: string | null;
}

export interface CodexHookMetadata {
  key: string;
  eventName: string;
  handlerType: string;
  enabled: boolean;
  trustStatus: string;
  sourcePath: string;
  pluginId: string | null;
  command: string | null;
  statusMessage: string | null;
}

export interface CodexHooksListEntry {
  cwd: string;
  hooks: CodexHookMetadata[];
  errors: Array<{ path: string; message: string }>;
  warnings: string[];
}

export interface CodexPluginSummary {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  source: string;
  availability: string;
  authPolicy: string;
  installPolicy: string;
  keywords: string[];
}

export interface CodexPluginMarketplace {
  name: string;
  displayName: string | null;
  path: string | null;
  plugins: CodexPluginSummary[];
}

export interface CodexPluginSkillSummary {
  name: string;
  description: string;
  shortDescription: string | null;
  enabled: boolean;
  path: string | null;
}

export interface CodexPluginDetail {
  marketplaceName: string;
  marketplacePath: string | null;
  summary: CodexPluginSummary;
  description: string | null;
  skills: CodexPluginSkillSummary[];
  hooks: Array<{ key: string; eventName: string }>;
  apps: Array<{ id: string; name: string; description: string | null; needsAuth: boolean }>;
  mcpServers: string[];
}

export interface CodexAppInfo {
  id: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  isAccessible: boolean;
  installUrl: string | null;
  distributionChannel: string | null;
  pluginDisplayNames: string[];
}

export interface CodexExperimentalFeature {
  name: string;
  displayName: string | null;
  enabled: boolean;
  defaultEnabled: boolean;
  stage: string;
  description: string | null;
}

export interface CodexConfigRequirements {
  allowedApprovalPolicies: string[] | null;
  allowedSandboxModes: string[] | null;
  allowedWebSearchModes: string[] | null;
  enforceResidency: string | null;
  featureRequirements: Record<string, boolean> | null;
}

export interface CodexModelProviderCapabilities {
  webSearch: boolean;
  imageGeneration: boolean;
  namespaceTools: boolean;
}

export type ThreadGoalStatusValue = 'active' | 'paused' | 'budgetLimited' | 'complete';

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatusValue;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexFuzzyFileResult {
  root: string;
  path: string;
  matchType: string;
  fileName: string;
  score: number;
}

export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title: string | null }
  | { type: 'custom'; instructions: string };

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

export type ApprovalKind = 'command' | 'fileChange' | 'permissions';

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
  payloadJson: string | null;
  messageId: number | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface RuntimeStatus {
  running: boolean;
  connected: boolean;
  userAgent: string | null;
  codexAppServer?: {
    pid: number | null;
    port: number | null;
    running: boolean;
    managed: boolean;
  };
  botUsername: string | null;
  currentBindings: number;
  pendingApprovals: number;
  pendingUserInputs: number;
  activeTurns: number;
  lastError: string | null;
  updatedAt: string;
  /** Which messaging transports are expected active in this process. */
  channels?: { telegram: boolean; weixin: boolean };
}
