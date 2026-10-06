import type { AppLocale, ActiveTurnMessageMode, CodexThreadGoal, CollaborationModeValue, AppTurnSnapshot, ReviewTarget } from '../types.js';
import { t } from '../i18n.js';
import { formatMetricTokenCount } from '../store/token_usage.js';
import fs from 'node:fs/promises';
import { truncateInline } from './turn_rendering.js';
import {
  ApprovalAction,
  McpElicitationAction,
  DEFAULT_COLLABORATION_MODE,
  PINNED_HELP_COMMANDS,
  DYNAMIC_HELP_COMMANDS,
  AuthRetryContext,
} from './state_types.js';
import { formatKnownCodexAccessError, cleanUserFacingError } from './auth_errors.js';

export function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || value.trim();
}

export function parseReviewTarget(args: string[]): ReviewTarget | null {
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

export function summarizeTurnItems(items: AppTurnSnapshot['items']): string {
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

export function turnHasRelayableOutcome(turn: AppTurnSnapshot): boolean {
  if (turn.error?.trim()) {
    return true;
  }
  return turn.items.some((item) => {
    const type = item.type.toLowerCase();
    if (!item.text?.trim()) {
      return false;
    }
    if (type === 'plan') {
      return true;
    }
    if (type !== 'agentmessage' && type !== 'assistantmessage') {
      return false;
    }
    const phase = item.phase?.toLowerCase() ?? null;
    return phase === null || phase.startsWith('final');
  });
}

export function mapGoalNotification(raw: any): CodexThreadGoal | null {
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

export function formatWarningNotification(locale: AppLocale, method: string, params: any): string {
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

export function isCodexTransportFallbackWarning(method: string, params: any): boolean {
  if (method !== 'warning') {
    return false;
  }
  return /falling back from websockets? to https transport/i.test(String(params?.message ?? ''));
}

export function normalizeThreadStatusLabel(raw: any): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw?.type === 'string') {
    return raw.type;
  }
  return 'unknown';
}

export function formatThreadTokenUsage(raw: any): { percent: number; total: number; limit: number } | null {
  const total = numberOrNull(raw?.last?.totalTokens ?? raw?.last?.total_tokens);
  const limit = numberOrNull(raw?.modelContextWindow ?? raw?.model_context_window);
  if (total === null || limit === null || total <= 0 || limit <= 0) {
    return null;
  }
  const rawPercent = Math.round((total / limit) * 100);
  const percent = Math.min(100, rawPercent);
  return rawPercent >= 85 ? { percent, total, limit } : null;
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function parsePositiveInt(
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

export function formatConfigValue(value: unknown): string {
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

export function formatRawLabel(value: unknown): string {
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

export function toErrorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}

export function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function normalizeRequestedCollaborationMode(value: string): CollaborationModeValue | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'plan' || normalized === '计划' || normalized === '规划') {
    return 'plan';
  }
  if (normalized === 'default' || normalized === 'agent' || normalized === '默认') {
    return 'default';
  }
  return null;
}

export function normalizeRequestedActiveTurnMessageMode(value: string): ActiveTurnMessageMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'steer' || normalized === 'guide' || normalized === '引导') {
    return 'steer';
  }
  if (normalized === 'queue' || normalized === '排队') {
    return 'queue';
  }
  return null;
}

export function normalizeApprovalTextAction(value: string): ApprovalAction | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'allow' || normalized === 'accept' || normalized === 'yes' || normalized === '同意' || normalized === '允许') {
    return 'accept';
  }
  if (normalized === 'session' || normalized === 'allow_session' || normalized === '本会话' || normalized === '本会话允许') {
    return 'session';
  }
  if (normalized === 'deny' || normalized === 'decline' || normalized === 'no' || normalized === '拒绝') {
    return 'deny';
  }
  return null;
}

export function normalizePlanImplementationTextAction(value: string): 'run' | 'fresh' | 'stay' | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'run' || normalized === 'execute' || normalized === '执行') {
    return 'run';
  }
  if (normalized === 'fresh' || normalized === 'clear' || normalized === '新上下文') {
    return 'fresh';
  }
  if (normalized === 'stay' || normalized === 'plan' || normalized === '继续规划') {
    return 'stay';
  }
  return null;
}

export function normalizeMcpElicitationTextAction(value: string): McpElicitationAction | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'accept' || normalized === 'allow' || normalized === '同意' || normalized === '接受') {
    return 'accept';
  }
  if (normalized === 'decline' || normalized === 'deny' || normalized === '拒绝') {
    return 'decline';
  }
  if (normalized === 'cancel' || normalized === '取消') {
    return 'cancel';
  }
  return null;
}

export function resolveCollaborationMode(mode: CollaborationModeValue | null | undefined): CollaborationModeValue {
  return mode ?? DEFAULT_COLLABORATION_MODE;
}

export function attachedThreadKey(scopeId: string, threadId: string): string {
  return `${scopeId}:${threadId}`;
}

export function activeTurnKey(scopeId: string, turnId: string): string {
  return `${encodeURIComponent(scopeId)}:${encodeURIComponent(turnId)}`;
}

export function parseActiveTurnKey(key: string): { scopeId: string; turnId: string } | null {
  const split = key.indexOf(':');
  if (split === -1) {
    return null;
  }
  return {
    scopeId: decodeURIComponent(key.slice(0, split)),
    turnId: decodeURIComponent(key.slice(split + 1)),
  };
}

export function normalizeHelpUsageKey(name: string): string | null {
  const normalized = name.toLowerCase();
  switch (normalized) {
    case 'start':
      return 'help';
    case 'followup':
      return 'active';
    case 'login':
      return 'login_device';
    case 'codex_restart':
      return 'auth_reload';
    case 'file':
      return 'files';
    case 'rollback':
      return 'undo';
    case 'access':
      return 'permissions';
    case 'focus':
      return 'reveal';
    case 'model':
      return 'models';
    default:
      if (PINNED_HELP_COMMANDS.some(entry => entry.key === normalized)) {
        return normalized;
      }
      if (DYNAMIC_HELP_COMMANDS.some(entry => entry.key === normalized)) {
        return normalized;
      }
      return null;
  }
}

export function formatWatchCallbackText(locale: AppLocale, mode: 'already' | 'active' | 'idle', threadId: string): string {
  if (mode === 'already') {
    return t(locale, 'watch_already_enabled', { threadId });
  }
  if (mode === 'active') {
    return t(locale, 'watch_started_active', { threadId });
  }
  return t(locale, 'watch_started_idle', { threadId });
}

export function cloneAuthRetryContext(context: AuthRetryContext): AuthRetryContext {
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

export function clipButtonText(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}...` : trimmed;
}

export function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '?';
  }
  return Math.round(value).toLocaleString('en-US');
}

export function formatCodexTokenCountWithMetric(value: number): string {
  if (value >= 1_000_000) {
    return `${formatMetricTokenCount(value)} (${formatTokenCount(value)})`;
  }
  return formatTokenCount(value);
}

export function formatLocalTimestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatShortStatusError(error: unknown): string {
  const raw = formatUserError(error);
  const known = formatKnownCodexAccessError(raw);
  if (known) {
    return known.length > 120 ? `${known.slice(0, 117)}...` : known;
  }
  const message = cleanUserFacingError(raw);
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

export function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && /(thread not found|no rollout found for thread id)/i.test(error.message);
}

export function isThreadActiveWriterError(error: unknown): boolean {
  return error instanceof Error && /thread\s+\S+\s+already has an active writer/i.test(error.message);
}

export function isNoActiveTurnToSteerError(error: unknown): boolean {
  return error instanceof Error && /no active turn to steer/i.test(error.message);
}

export function isThreadQueueUnsupportedError(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('method not found')
    || message.includes('unknown method')
    || message.includes('thread/queue/add') && message.includes('not supported');
}

export function isThreadNewCwdCreateConfirmation(text: string): boolean {
  return /^(y|yes|ok|okay|confirm|create|mkdir|确定|确认|创建|新建|好)$/i.test(text.trim());
}

export function isThreadNewCwdCancelConfirmation(text: string): boolean {
  return /^(n|no|cancel|stop|取消|不要|不用|算了)$/i.test(text.trim());
}

export function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}

export function isTelegramMessageTooLong(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message_too_long')
    || message.includes('message is too long')
    || message.includes('message too long');
}

export function isFileMissingError(error: unknown): boolean {
  return error instanceof Error && /enoent|no such file or directory/i.test(error.message);
}

export async function isReadableSessionPath(sessionPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(sessionPath);
    return stats.isFile();
  } catch {
    return false;
  }
}
