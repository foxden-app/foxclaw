import crypto from 'node:crypto';
import type {
  AppLocale,
  CodexAccountInfo,
  CodexAccountRateLimits,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  RuntimeStatus,
} from '../types.js';
import { t } from '../i18n.js';
import type { CodexAuthQuotaSnapshotRecord } from '../store/database.js';
import { type ChatGptAuthMetadata } from '../auth/mirror.js';
import {
  CodexAuthListView,
  CODEX_AUTH_LIST_PAGE_SIZE,
  CodexAuthCandidate,
  PendingAuthChoiceList,
  CodexAuthListFilter,
  CodexAuthState,
  CodexAuthCandidateHealth,
  CODEX_AUTH_LOW_QUOTA_PERCENT,
  CODEX_AUTH_STALE_CREDENTIAL_DAYS,
  CodexAuthRefreshAllResult,
  CodexAuthClusterAuditOutcome,
  AuthProactiveRefreshStatus,
  AuthSyncRuntimeEvent,
  CodexAuthQuotaSnapshot,
} from './state_types.js';
import { clipButtonText, formatShortStatusError, formatCompactNumber, formatLocalTimestamp } from './shared_helpers.js';
import { truncateInline } from './turn_rendering.js';

export function parseCodexAuthListRequest(action: string, args: string[]): Partial<CodexAuthListView> | null {
  if (action === 'list') {
    return { searchTerm: args.slice(1).join(' ').trim() || null };
  }
  if (action === 'filter') {
    const filter = args[1]?.toLowerCase();
    return filter === 'all' || filter === 'enabled' || filter === 'attention'
      ? { filter }
      : null;
  }
  if (action === 'page') {
    const page = Number.parseInt(args[1] ?? '', 10);
    return Number.isFinite(page) && page > 0
      ? { offset: (page - 1) * CODEX_AUTH_LIST_PAGE_SIZE }
      : null;
  }
  return null;
}

export function createPendingAuthChoiceList(
  chatId: string,
  candidates: CodexAuthCandidate[],
  view: Partial<CodexAuthListView> = {},
): PendingAuthChoiceList {
  const record: PendingAuthChoiceList = {
    localId: crypto.randomBytes(8).toString('hex'),
    chatId,
    messageId: null,
    candidates,
    createdAt: Date.now(),
    offset: Math.max(0, view.offset ?? 0),
    pageSize: CODEX_AUTH_LIST_PAGE_SIZE,
    filter: view.filter ?? 'all',
    searchTerm: view.searchTerm?.trim() || null,
  };
  clampCodexAuthListOffset(record);
  return record;
}

export function clampCodexAuthListOffset(view: PendingAuthChoiceList): void {
  const filteredCount = filterCodexAuthCandidates(view.candidates, view).length;
  const finalOffset = filteredCount > 0
    ? Math.floor((filteredCount - 1) / view.pageSize) * view.pageSize
    : 0;
  view.offset = Math.min(Math.max(0, view.offset), finalOffset);
}

export function codexAuthListPage(
  candidates: CodexAuthCandidate[],
  view: CodexAuthListView | null,
): {
  visible: Array<{ candidate: CodexAuthCandidate; index: number }>;
  filteredCount: number;
  offset: number;
  pageIndex: number;
  pageCount: number;
  filter: CodexAuthListFilter;
  searchTerm: string | null;
} {
  const pageSize = Math.max(1, view?.pageSize ?? CODEX_AUTH_LIST_PAGE_SIZE);
  const filter = view?.filter ?? 'all';
  const searchTerm = view?.searchTerm?.trim() || null;
  const indexed = filterCodexAuthCandidates(candidates, { filter, searchTerm });
  const finalOffset = indexed.length > 0
    ? Math.floor((indexed.length - 1) / pageSize) * pageSize
    : 0;
  const offset = Math.min(Math.max(0, view?.offset ?? 0), finalOffset);
  return {
    visible: indexed.slice(offset, offset + pageSize),
    filteredCount: indexed.length,
    offset,
    pageIndex: Math.floor(offset / pageSize),
    pageCount: Math.max(1, Math.ceil(indexed.length / pageSize)),
    filter,
    searchTerm,
  };
}

export function filterCodexAuthCandidates(
  candidates: CodexAuthCandidate[],
  view: Pick<CodexAuthListView, 'filter' | 'searchTerm'>,
): Array<{ candidate: CodexAuthCandidate; index: number }> {
  const searchTerm = view.searchTerm?.trim().toLowerCase() || null;
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => !searchTerm || candidate.name.toLowerCase().includes(searchTerm))
    .filter(({ candidate }) => view.filter === 'all'
      || (view.filter === 'enabled' && !candidate.disabled && candidate.state !== 'needs_repair')
      || (view.filter === 'attention' && codexAuthCandidateNeedsAttention(candidate)));
}

export function renderAuthListMessage(
  locale: AppLocale,
  state: CodexAuthState,
  botLabel: string | null = null,
  includeWeixinCopyPaste = false,
  view: CodexAuthListView | null = null,
): string {
  const lines = [
    t(locale, 'auth_list_title'),
  ];
  if (botLabel) {
    lines.push(t(locale, 'auth_bot', { value: botLabel }));
  }
  lines.push(
    t(locale, 'auth_current', {
      value: state.currentLabel
        ? formatCodexAuthCandidateDisplayName(state.currentLabel)
        : t(locale, 'none'),
    }),
    t(locale, 'auth_dir', { value: state.authDir }),
  );
  if (state.candidates.length === 0) {
    lines.push(t(locale, 'auth_no_candidates'));
    if (includeWeixinCopyPaste) {
      lines.push(
        '',
        t(locale, 'weixin_copy_paste_divider'),
        t(locale, 'weixin_copy_auth_title'),
        '/login_device',
        '/auth sync safe',
        '/auth reload',
        '/permissions',
      );
    }
    return lines.join('\n');
  }
  lines.push(t(locale, 'auth_candidate_count', { value: state.candidates.length }));
  lines.push(t(locale, 'auth_quota_legend'));
  const page = codexAuthListPage(state.candidates, view);
  if (page.searchTerm) {
    lines.push(t(locale, 'auth_search', { value: page.searchTerm }));
  }
  if (page.filter !== 'all') {
    lines.push(t(locale, 'auth_filter', { value: formatCodexAuthFilter(locale, page.filter) }));
  }
  if (page.filteredCount !== state.candidates.length || page.pageCount > 1) {
    lines.push(t(locale, 'auth_page', {
      from: page.filteredCount === 0 ? 0 : page.offset + 1,
      to: page.offset + page.visible.length,
      filtered: page.filteredCount,
      total: state.candidates.length,
      page: page.pageIndex + 1,
      pages: page.pageCount,
    }));
  }
  if (page.visible.length === 0) {
    lines.push(t(locale, 'auth_no_matches'));
  }
  page.visible.forEach(({ candidate, index }) => {
    const marker = candidate.isCurrent ? ' *' : '';
    lines.push(`${index + 1}. ${formatAuthQuotaPrefix(locale, candidate.quota)}|${formatCodexAuthCandidateDisplayName(candidate.name)}${marker} ${formatCodexAuthCandidateStatus(locale, candidate)}`);
  });
  if (includeWeixinCopyPaste) {
    lines.push(
        '',
        t(locale, 'weixin_copy_paste_divider'),
        t(locale, 'weixin_copy_auth_title'),
      ...page.visible.map(({ index }) => `/auth use ${index + 1}`),
      ...page.visible.map(({ candidate, index }) => candidate.disabled
        ? `/auth enable ${index + 1}`
        : `/auth disable ${index + 1}`),
      '/auth filter all',
      '/auth filter enabled',
      '/auth filter attention',
      '/auth list <keyword>',
      '/login_device',
      '/auth sync safe',
      '/auth reload',
      '/permissions',
    );
  }
  return lines.join('\n');
}

export function authChoiceKeyboard(locale: AppLocale, record: PendingAuthChoiceList): Array<Array<{ text: string; callback_data: string }>> {
  const page = codexAuthListPage(record.candidates, record);
  const rows = page.visible.map(({ candidate, index }) => [
    {
      text: clipButtonText(`${candidate.state === 'needs_repair' ? '? ' : candidate.isCurrent ? '✅ ' : '🔐 '}${formatAuthQuotaButtonPrefix(candidate.quota)}|${formatCodexAuthCandidateDisplayName(candidate.name)}${candidate.disabled ? ' · off' : ''}`),
      callback_data: candidate.state === 'needs_repair' ? `auth:${record.localId}:repair:${index}` : `auth:${record.localId}:${index}`,
    },
    {
      text: candidate.state === 'needs_repair' ? '?' : t(locale, candidate.disabled ? 'button_auth_disable' : 'button_auth_enable'),
      callback_data: candidate.state === 'needs_repair' ? `auth:${record.localId}:repair:${index}` : `auth:${record.localId}:toggle:${index}`,
    },
  ]);
  const navigationRow = [];
  if (page.offset > 0) {
    navigationRow.push({ text: t(locale, 'button_prev_page'), callback_data: `auth:${record.localId}:page:prev` });
  }
  if (page.offset + page.visible.length < page.filteredCount) {
    navigationRow.push({ text: t(locale, 'button_next_page'), callback_data: `auth:${record.localId}:page:next` });
  }
  if (navigationRow.length > 0) {
    rows.push(navigationRow);
  }
  rows.push([
    authFilterButton(locale, record, 'all'),
    authFilterButton(locale, record, 'enabled'),
    authFilterButton(locale, record, 'attention'),
  ]);
  if (record.searchTerm) {
    rows.push([{ text: t(locale, 'button_clear_filter'), callback_data: `auth:${record.localId}:clear_search` }]);
  }
  rows.push([{ text: t(locale, 'button_login_device'), callback_data: `auth:${record.localId}:login_device` }]);
  rows.push([{ text: t(locale, 'button_auth_safe_sync'), callback_data: `auth:${record.localId}:safe_sync` }]);
  return rows;
}

export function formatCodexAuthCandidateDisplayName(name: string): string {
  const prefix = 'auth.json_';
  return name.length > prefix.length && name.startsWith(prefix)
    ? name.slice(prefix.length)
    : name;
}

export function authFilterButton(
  locale: AppLocale,
  record: PendingAuthChoiceList,
  filter: CodexAuthListFilter,
): { text: string; callback_data: string } {
  const label = t(locale, `button_auth_filter_${filter}` as 'button_auth_filter_all' | 'button_auth_filter_enabled' | 'button_auth_filter_attention');
  return {
    text: record.filter === filter ? `☑️ ${label}` : label,
    callback_data: `auth:${record.localId}:filter:${filter}`,
  };
}

export function codexAuthCandidateHealth(candidate: CodexAuthCandidate): CodexAuthCandidateHealth {
  if (candidate.state === 'needs_repair') {
    return 'needs_repair';
  }
  if (candidate.disabled) {
    return 'disabled';
  }
  if (candidate.credentialKind === 'api-key') {
    return 'api-key';
  }
  if (candidate.credentialKind === 'invalid') {
    return 'invalid';
  }
  const remaining = [
    candidate.quota?.primaryRemainingPercent,
    candidate.quota?.secondaryRemainingPercent,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (remaining.some(value => value <= 0)) {
    return 'exhausted';
  }
  if (remaining.some(value => value <= CODEX_AUTH_LOW_QUOTA_PERCENT)) {
    return 'low';
  }
  if (
    candidate.credentialLastRefreshMs !== null
    && candidate.credentialLastRefreshMs < Date.now() - CODEX_AUTH_STALE_CREDENTIAL_DAYS * 24 * 60 * 60_000
  ) {
    return 'stale';
  }
  if (remaining.length === 0) {
    return 'unknown';
  }
  return 'ready';
}

export function codexAuthCandidateNeedsAttention(candidate: CodexAuthCandidate): boolean {
  const health = codexAuthCandidateHealth(candidate);
  return health === 'stale'
    || health === 'unknown'
    || health === 'low'
    || health === 'exhausted'
    || health === 'needs_repair'
    || health === 'invalid';
}

export function formatCodexAuthCandidateStatus(locale: AppLocale, candidate: CodexAuthCandidate): string {
  const details = [];
  if (candidate.quota?.planType) {
    details.push(formatPlanTypeLabel(candidate.quota.planType));
  }
  details.push(t(locale, `auth_candidate_health_${codexAuthCandidateHealth(candidate)}` as
    | 'auth_candidate_health_disabled'
    | 'auth_candidate_health_needs_repair'
    | 'auth_candidate_health_ready'
    | 'auth_candidate_health_low'
    | 'auth_candidate_health_exhausted'
    | 'auth_candidate_health_stale'
    | 'auth_candidate_health_unknown'
    | 'auth_candidate_health_api-key'
    | 'auth_candidate_health_invalid'));
  if (candidate.credentialLastRefreshMs !== null) {
    details.push(t(locale, 'auth_candidate_last_refresh', {
      value: formatCompactAge(locale, Date.now() - candidate.credentialLastRefreshMs),
    }));
  }
  if (candidate.credentialExpiresAtMs !== null) {
    details.push(t(locale, 'auth_candidate_expires_at', {
      value: formatUtcDateTime(candidate.credentialExpiresAtMs),
    }));
  }
  return `[${details.join(' · ')}]`;
}

export function formatCodexAuthFilter(locale: AppLocale, filter: CodexAuthListFilter): string {
  return t(locale, `auth_filter_${filter}` as 'auth_filter_all' | 'auth_filter_enabled' | 'auth_filter_attention');
}

export function authRefreshAllConfirmKeyboard(locale: AppLocale, record: PendingAuthChoiceList): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [{ text: t(locale, 'button_auth_refresh_all_confirm'), callback_data: `auth:${record.localId}:refresh_all_confirm` }],
    [{ text: t(locale, 'button_cancel'), callback_data: `auth:${record.localId}:refresh_all_cancel` }],
  ];
}

export function authRepairKeyboard(locale: AppLocale, record: PendingAuthChoiceList, index: number): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [{ text: t(locale, 'button_auth_repair_login'), callback_data: `auth:${record.localId}:repair_login:${index}` }],
    [{ text: t(locale, 'button_auth_delete'), callback_data: `auth:${record.localId}:repair_delete:${index}` }],
    [{ text: t(locale, 'button_cancel'), callback_data: `auth:${record.localId}:repair_cancel:${index}` }],
  ];
}

export function formatAuthRefreshAllResult(locale: AppLocale, result: CodexAuthRefreshAllResult, mode: 'manual' | 'proactive' = 'manual'): string {
  const lines = [t(locale, mode === 'proactive' ? 'auth_proactive_refresh_done' : 'auth_refresh_all_done', {
    refreshed: String(result.refreshed.length),
    skipped: String(result.skipped.length),
    failed: String(result.failed.length),
  })];
  if (result.refreshed.length > 0) {
    lines.push(t(locale, 'auth_refresh_all_refreshed', { value: result.refreshed.join(', ') }));
  }
  if (result.skipped.length > 0) {
    lines.push(t(locale, 'auth_refresh_all_skipped', { value: result.skipped.join(', ') }));
  }
  if (result.failed.length > 0) {
    const details = result.failed
      .slice(0, 5)
      .map((failure) => `${failure.name}: ${failure.error}`)
      .join('; ');
    lines.push(t(locale, 'auth_refresh_all_failed', { value: details }));
  }
  return lines.join('\n');
}

export function formatAuthClusterAuditResult(locale: AppLocale, outcome: CodexAuthClusterAuditOutcome): string {
  const { audit, refresh, push } = outcome;
  const lines = [t(locale, 'auth_cluster_audit_summary', {
    responded: audit.nodesResponded,
    expected: audit.nodesExpected,
    checked: audit.checkedCandidates,
    valid: audit.validCandidates,
    invalid: audit.invalidCandidates,
  })];
  if (audit.synchronizedCandidates.length > 0) {
    lines.push(t(locale, 'auth_cluster_audit_synced', { value: audit.synchronizedCandidates.join(', ') }));
  }
  if (audit.consensusInvalidCandidates.length > 0) {
    lines.push(t(locale, 'auth_cluster_audit_repair', { value: audit.consensusInvalidCandidates.join(', ') }));
  }
  if (audit.missingPeers.length > 0) {
    lines.push(t(locale, 'auth_cluster_audit_missing', { value: audit.missingPeers.join(', ') }));
  }
  if (audit.busyNodes.length > 0) {
    lines.push(t(locale, 'auth_cluster_audit_busy', { value: audit.busyNodes.join(', ') }));
  }
  if (audit.identityConflicts.length > 0) {
    lines.push(t(locale, 'auth_cluster_audit_conflicts', { value: audit.identityConflicts.join(', ') }));
  }
  if (outcome.refreshSkippedReason) {
    lines.push(t(locale, 'auth_cluster_audit_refresh_skipped'));
  } else {
    lines.push(formatAuthRefreshAllResult(locale, refresh, 'proactive'));
  }
  lines.push(t(locale, 'auth_cluster_audit_push', { sent: push.sent, skipped: push.skipped }));
  return lines.join('\n');
}

export function formatAuthSyncStatus(
  locale: AppLocale,
  status: RuntimeStatus['authSync'],
  proactiveRefresh: AuthProactiveRefreshStatus | null = null,
): string {
  if (!status?.enabled) {
    return t(locale, 'auth_sync_disabled');
  }
  const lines = [
    t(locale, 'auth_sync_status_title'),
    t(locale, 'auth_sync_status_node', { value: status.nodeId ?? t(locale, 'unknown') }),
    t(locale, 'auth_sync_status_transport', { value: status.transportLabel ?? t(locale, 'unknown') }),
    t(locale, 'auth_sync_status_peers', { value: status.peers.length === 0 ? t(locale, 'none') : status.peers.join(', ') }),
    t(locale, 'auth_sync_status_pending', { value: status.pendingImports }),
    t(locale, 'auth_sync_status_sent', { value: status.lastSentAt ?? t(locale, 'none') }),
    t(locale, 'auth_sync_status_received', { value: status.lastReceivedAt ?? t(locale, 'none') }),
    t(locale, 'auth_sync_status_imported', {
      value: status.lastImportedAt
        ? `${status.lastImportCandidate ?? t(locale, 'unknown')} @ ${status.lastImportedAt}`
        : t(locale, 'none'),
    }),
    t(locale, 'auth_sync_status_pull', {
      value: status.lastPullAt
        ? `${status.lastPullCandidate ?? t(locale, 'unknown')} @ ${status.lastPullAt}`
        : t(locale, 'none'),
    }),
  ];
  if (status.activeLeaseId) {
    lines.push(t(locale, 'auth_sync_status_lease', { value: status.activeLeaseId }));
  }
  if (status.lastError) {
    lines.push(t(locale, 'auth_sync_status_error', { value: status.lastError }));
  }
  if (proactiveRefresh) {
    lines.push(t(locale, 'auth_sync_status_proactive_refresh', {
      value: formatAuthProactiveRefreshStatus(locale, proactiveRefresh),
    }));
  }
  if (status.peerStatuses?.length) {
    lines.push(t(locale, 'auth_sync_status_peer_activity'));
    for (const peer of status.peerStatuses.slice(0, 5)) {
      lines.push(t(locale, 'auth_sync_status_peer_activity_item', {
        peer: peer.peer,
        time: peer.lastReceivedAt ?? t(locale, 'none'),
      }));
    }
  }
  if (status.candidateFailures?.length) {
    lines.push(t(locale, 'auth_sync_status_candidate_failures'));
    for (const failure of status.candidateFailures.slice(0, 5)) {
      lines.push(t(locale, 'auth_sync_status_candidate_failure', {
        candidate: failure.candidateName,
        reason: failure.reason,
        source: failure.sourceLabel ?? failure.sourceNodeId ?? t(locale, 'unknown'),
        peer: failure.peer ?? t(locale, 'unknown'),
        time: failure.updatedAt,
      }));
    }
  }
  const recentEvents = [...(status.recentEvents ?? [])].slice(-5);
  if (recentEvents.length > 0) {
    lines.push(t(locale, 'auth_sync_status_recent_events'));
    for (const event of recentEvents) {
      lines.push(formatAuthSyncEventLine(event));
    }
  }
  return lines.join('\n');
}

export function formatAuthProactiveRefreshStatus(
  locale: AppLocale,
  status: AuthProactiveRefreshStatus,
): string {
  const time = status.finishedAt ?? status.startedAt;
  const candidates = formatLimitedList(status.candidates, 3);
  const state = formatAuthProactiveRefreshState(locale, status.state);
  const result = locale === 'zh'
    ? `已刷新 ${status.refreshed}，已跳过 ${status.skipped}，失败 ${status.failed}`
    : `refreshed ${status.refreshed}, skipped ${status.skipped}, failed ${status.failed}`;
  const parts = [
    `${state} @ ${time}`,
    locale === 'zh' ? `候选 ${candidates}` : `candidates ${candidates}`,
    result,
  ];
  if (status.error) {
    parts.push(locale === 'zh'
      ? `原因 ${formatShortStatusError(status.error)}`
      : `reason ${formatShortStatusError(status.error)}`);
  }
  if (status.details.length > 0) {
    parts.push(locale === 'zh'
      ? `明细 ${formatLimitedList(status.details.map(formatShortStatusError), 2)}`
      : `details ${formatLimitedList(status.details.map(formatShortStatusError), 2)}`);
  }
  return parts.join('; ');
}

export function formatAuthProactiveRefreshState(
  locale: AppLocale,
  state: AuthProactiveRefreshStatus['state'],
): string {
  if (locale === 'zh') {
    switch (state) {
      case 'running': return '进行中';
      case 'completed': return '已完成';
      case 'lease_failed': return '锁未授予';
      case 'failed': return '失败';
    }
  }
  switch (state) {
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'lease_failed': return 'lease not granted';
    case 'failed': return 'failed';
  }
}

export function formatLimitedList(values: readonly string[], limit: number): string {
  if (values.length === 0) return '-';
  const shown = values.slice(0, limit).join(', ');
  return values.length > limit ? `${shown}, +${values.length - limit}` : shown;
}

export function formatAuthSyncEvents(locale: AppLocale, status: RuntimeStatus['authSync'], filter: string | null): string {
  if (!status?.enabled) {
    return t(locale, 'auth_sync_disabled');
  }
  const events = filterAuthSyncEvents(status.recentEvents ?? [], filter).slice(-15);
  if (events.length === 0) {
    return [
      t(locale, 'auth_sync_events_title'),
      t(locale, 'auth_sync_events_empty'),
    ].join('\n');
  }
  return [
    t(locale, 'auth_sync_events_title'),
    ...events.map(formatAuthSyncEventLine),
  ].join('\n');
}

export function formatAuthSyncTrace(locale: AppLocale, status: RuntimeStatus['authSync'], requestId: string): string {
  if (!status?.enabled) {
    return t(locale, 'auth_sync_disabled');
  }
  const events = (status.recentEvents ?? [])
    .filter(event => event.requestId === requestId || event.id === requestId)
    .slice(-25);
  if (events.length === 0) {
    return [
      t(locale, 'auth_sync_trace_title', { value: requestId }),
      t(locale, 'auth_sync_events_empty'),
    ].join('\n');
  }
  return [
    t(locale, 'auth_sync_trace_title', { value: requestId }),
    ...events.map(formatAuthSyncEventLine),
  ].join('\n');
}

export function filterAuthSyncEvents(events: AuthSyncRuntimeEvent[], filter: string | null): AuthSyncRuntimeEvent[] {
  const normalized = filter?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return events;
  }
  return events.filter((event) => [
    event.id,
    event.requestId,
    event.candidateName,
    event.peer,
    event.kind,
    event.stage,
    event.detail,
  ].some(value => value?.toLowerCase().includes(normalized)));
}

export function formatAuthSyncEventLine(event: AuthSyncRuntimeEvent): string {
  const fields = [
    event.createdAt,
    event.direction,
    event.kind,
    event.stage,
    event.peer ? `peer=${event.peer}` : null,
    event.requestId ? `requestId=${event.requestId}` : null,
    event.candidateName ? `candidate=${event.candidateName}` : null,
    event.detail ? truncateInline(event.detail, 160) : null,
  ].filter(Boolean);
  return `- ${fields.join(' | ')}`;
}

export function selectCodexRateLimitSnapshot(limits: CodexAccountRateLimits | null): CodexRateLimitSnapshot | null {
  return limits?.rateLimitsByLimitId?.codex
    ?? Object.values(limits?.rateLimitsByLimitId ?? {})[0]
    ?? limits?.rateLimits
    ?? null;
}

export function formatCodexAccountLabel(account: CodexAccountInfo): string {
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

export function formatPlanTypeLabel(value: string): string {
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

export function formatRateLimitWindowLabel(locale: AppLocale, window: CodexRateLimitWindow, fallback: 'primary' | 'secondary'): string {
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

export function formatCompactRateLimitWindowLabel(
  locale: AppLocale,
  minutes: number | null,
  fallback: 'primary' | 'secondary',
): string {
  if (!minutes || minutes <= 0) {
    return fallback === 'primary'
      ? (locale === 'zh' ? '短' : 'P')
      : (locale === 'zh' ? '长' : 'S');
  }
  if (minutes % 1440 === 0) {
    return `${formatCompactNumber(minutes / 1440)}d`;
  }
  if (minutes % 60 === 0) {
    return `${formatCompactNumber(minutes / 60)}h`;
  }
  return `${formatCompactNumber(minutes)}m`;
}

export function formatCompactAge(locale: AppLocale, ageMs: number): string {
  const minutes = Math.max(0, ageMs) / 60_000;
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    return locale === 'zh' ? `${days}天前` : `${days}d ago`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return locale === 'zh' ? `${hours}小时前` : `${hours}h ago`;
  }
  const roundedMinutes = Math.floor(minutes);
  return locale === 'zh' ? `${roundedMinutes}分钟前` : `${roundedMinutes}m ago`;
}

export function formatUtcDateTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    return '-';
  }
  return `${new Date(timestampMs).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

export function formatUsagePercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '?';
  }
  return formatCompactNumber(value);
}

export function formatRemainingUsagePercent(usedPercent: number): string {
  const remainingPercent = remainingUsagePercent(usedPercent);
  return remainingPercent === null ? '?' : formatUsagePercent(remainingPercent);
}

export function authQuotaSnapshotFromRateLimit(
  snapshot: CodexRateLimitSnapshot,
  accountId: string | null = null,
  quotaIdentityId: string | null = null,
): CodexAuthQuotaSnapshot {
  return {
    capturedAtMs: Date.now(),
    accountId,
    quotaIdentityId,
    planType: snapshot.planType,
    primaryWindowDurationMins: snapshot.primary?.windowDurationMins ?? null,
    primaryRemainingPercent: snapshot.primary ? remainingUsagePercent(snapshot.primary.usedPercent) : null,
    primaryResetsAt: snapshot.primary?.resetsAt ?? null,
    secondaryWindowDurationMins: snapshot.secondary?.windowDurationMins ?? null,
    secondaryRemainingPercent: snapshot.secondary ? remainingUsagePercent(snapshot.secondary.usedPercent) : null,
    secondaryResetsAt: snapshot.secondary?.resetsAt ?? null,
  };
}

export function codexAuthQuotaSnapshotFromRecord(record: CodexAuthQuotaSnapshotRecord): CodexAuthQuotaSnapshot {
  return {
    capturedAtMs: record.capturedAtMs,
    accountId: record.accountId,
    quotaIdentityId: record.quotaIdentityId,
    planType: record.planType,
    primaryWindowDurationMins: record.primaryWindowDurationMins,
    primaryRemainingPercent: record.primaryRemainingPercent,
    primaryResetsAt: record.primaryResetsAt,
    secondaryWindowDurationMins: record.secondaryWindowDurationMins,
    secondaryRemainingPercent: record.secondaryRemainingPercent,
    secondaryResetsAt: record.secondaryResetsAt,
  };
}

export function mergeCodexAuthQuotaSnapshots(
  current: CodexAuthQuotaSnapshot | null,
  incoming: CodexAuthQuotaSnapshot | null,
): CodexAuthQuotaSnapshot | null {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }
  const freshest = incoming.capturedAtMs >= current.capturedAtMs ? incoming : current;
  const older = freshest === incoming ? current : incoming;
  return {
    ...freshest,
    accountId: freshest.accountId ?? older.accountId ?? null,
    quotaIdentityId: freshest.quotaIdentityId ?? older.quotaIdentityId ?? null,
  };
}

export function isFiniteCodexAuthQuotaSnapshotRecord(record: CodexAuthQuotaSnapshotRecord): boolean {
  return Number.isFinite(record.capturedAtMs)
    && isNullableString(record.planType)
    && isNullableFiniteNumber(record.primaryWindowDurationMins)
    && isNullableFiniteNumber(record.primaryRemainingPercent)
    && isNullableFiniteNumber(record.primaryResetsAt)
    && isNullableFiniteNumber(record.secondaryWindowDurationMins)
    && isNullableFiniteNumber(record.secondaryRemainingPercent)
    && isNullableFiniteNumber(record.secondaryResetsAt);
}

export function remainingUsagePercent(usedPercent: number): number | null {
  if (!Number.isFinite(usedPercent)) {
    return null;
  }
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function formatAuthQuotaPrefix(locale: AppLocale, snapshot: CodexAuthQuotaSnapshot | null): string {
  if (!snapshot) {
    return '--';
  }
  const windows = [
    [snapshot.primaryWindowDurationMins, snapshot.primaryRemainingPercent, snapshot.primaryResetsAt, 'primary'],
    [snapshot.secondaryWindowDurationMins, snapshot.secondaryRemainingPercent, snapshot.secondaryResetsAt, 'secondary'],
  ] as const;
  const values = windows
    .filter(([duration, remaining, resetsAt]) => duration !== null || remaining !== null || resetsAt !== null)
    .map(([duration, remaining, resetsAt, fallback]) => (
      `${formatCompactRateLimitWindowLabel(locale, duration, fallback)}:${remaining === null ? '--' : formatUsagePercent(remaining)}${resetsAt === null ? '' : `@${formatLocalTimestamp(resetsAt)}`}`
    ));
  return values.length > 0 ? values.join('|') : '--';
}

export function formatAuthQuotaButtonPrefix(snapshot: CodexAuthQuotaSnapshot | null): string {
  return [
    snapshot?.primaryRemainingPercent ?? null,
    snapshot?.secondaryRemainingPercent ?? null,
  ].map(formatAuthQuotaButtonValue).join('|');
}

export function formatAuthQuotaButtonValue(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? formatUsagePercent(value)
    : '—';
}

export function isCodexAuthQuotaSnapshot(value: unknown): value is CodexAuthQuotaSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const snapshot = value as Partial<CodexAuthQuotaSnapshot>;
  return typeof snapshot.capturedAtMs === 'number'
    && Number.isFinite(snapshot.capturedAtMs)
    && (snapshot.accountId === undefined || snapshot.accountId === null || typeof snapshot.accountId === 'string')
    && (snapshot.quotaIdentityId === undefined || snapshot.quotaIdentityId === null || typeof snapshot.quotaIdentityId === 'string')
    && (snapshot.planType === undefined || isNullableString(snapshot.planType))
    && (snapshot.primaryWindowDurationMins === undefined || isNullableFiniteNumber(snapshot.primaryWindowDurationMins))
    && isNullableFiniteNumber(snapshot.primaryRemainingPercent)
    && (snapshot.primaryResetsAt === undefined || isNullableFiniteNumber(snapshot.primaryResetsAt))
    && (snapshot.secondaryWindowDurationMins === undefined || isNullableFiniteNumber(snapshot.secondaryWindowDurationMins))
    && isNullableFiniteNumber(snapshot.secondaryRemainingPercent)
    && (snapshot.secondaryResetsAt === undefined || isNullableFiniteNumber(snapshot.secondaryResetsAt));
}

export function normalizeCodexAuthQuotaSnapshot(snapshot: CodexAuthQuotaSnapshot): CodexAuthQuotaSnapshot {
  return {
    capturedAtMs: snapshot.capturedAtMs,
    accountId: snapshot.accountId ?? null,
    quotaIdentityId: snapshot.quotaIdentityId ?? snapshot.accountId ?? null,
    planType: snapshot.planType ?? null,
    primaryWindowDurationMins: snapshot.primaryWindowDurationMins ?? null,
    primaryRemainingPercent: snapshot.primaryRemainingPercent,
    primaryResetsAt: snapshot.primaryResetsAt ?? null,
    secondaryWindowDurationMins: snapshot.secondaryWindowDurationMins ?? null,
    secondaryRemainingPercent: snapshot.secondaryRemainingPercent,
    secondaryResetsAt: snapshot.secondaryResetsAt ?? null,
  };
}

export function chatGptAuthMetadataCompatible(
  left: Pick<ChatGptAuthMetadata, 'accountId' | 'quotaIdentityId'>,
  right: Pick<ChatGptAuthMetadata, 'accountId' | 'quotaIdentityId'>,
): boolean {
  if (left.accountId !== right.accountId) {
    return false;
  }
  if (left.quotaIdentityId === left.accountId || right.quotaIdentityId === right.accountId) {
    return true;
  }
  return left.quotaIdentityId === right.quotaIdentityId;
}

export function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
