import path from 'node:path';
import { t } from '../i18n.js';
import type {
  AccessPresetValue,
  ActiveTurnMessageMode,
  AppLocale,
  AppThread,
  ApprovalPolicyValue,
  ChatSessionSettings,
  CollaborationModeValue,
  ModelInfo,
  ReasoningEffortValue,
  SandboxModeValue,
} from '../types.js';
import type { ResolvedAccessMode } from './access.js';
import { resolveFastTierForModel } from './service_tier.js';

type InlineButton = { text: string; callback_data: string };

export type SetupFocusSection = 'overview' | 'model' | 'effort' | 'fast' | 'access' | 'mode' | 'active';

export interface SetupPanelContext {
  focus: SetupFocusSection;
  models: ModelInfo[];
  settings: ChatSessionSettings | null;
  access: ResolvedAccessMode;
}

interface ThreadLike {
  /** 1-based global ordinal for this row (pagination); keyboard and /open must match. */
  index?: number;
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  modelProvider: string | null;
  status: AppThread['status'];
  updatedAt: number;
  archived?: boolean;
}

/** Pagination + filter context for the threads panel (Telegram inline keyboard). */
export interface ThreadListPresentationState {
  offset: number;
  pageSize: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  searchTerm: string | null;
  archived?: boolean;
}

export function formatThreadsMessage(
  locale: AppLocale,
  threads: ThreadLike[],
  currentThreadId: string | null,
  searchTerm?: string | null,
  listState?: ThreadListPresentationState,
): string {
  if (threads.length === 0) {
    return searchTerm
      ? t(locale, 'threads_no_matches', { searchTerm: escapeTelegramHtml(searchTerm) })
      : t(locale, 'threads_no_recent');
  }
  const currentThread = currentThreadId
    ? threads.find(thread => thread.threadId === currentThreadId) ?? null
    : null;
  const headerLines = [
    t(locale, listState?.archived ? 'threads_archived_title' : 'threads_recent_title'),
    t(locale, 'threads_tap_to_open'),
  ];
  if (searchTerm) {
    headerLines.push(t(locale, 'threads_filter', { searchTerm: escapeTelegramHtml(searchTerm) }));
  }
  if (listState && threads.length > 0) {
    headerLines.push(
      t(locale, 'threads_range', {
        start: listState.offset + 1,
        end: listState.offset + threads.length,
      }),
    );
  }
  if (currentThread) {
    const currentTitle = truncate(compactWhitespace(currentThread.name || currentThread.preview || t(locale, 'empty')), 40);
    headerLines.push(t(locale, 'threads_current', { title: escapeTelegramHtml(currentTitle) }));
    headerLines.push(escapeTelegramHtml([
      formatCwd(locale, currentThread.cwd),
      formatRelativeTime(locale, currentThread.updatedAt),
      formatStatusLabel(locale, currentThread.status),
    ].filter(Boolean).join(' | ')));
  }
  return headerLines.join('\n');
}

export function buildThreadsKeyboard(locale: AppLocale, threads: ThreadLike[]): Array<Array<{ text: string; callback_data: string }>> {
  return threads.flatMap((thread, index) => {
    const ordinal = typeof thread.index === 'number' ? thread.index : index + 1;
    const openRow = [{
      text: `${ordinal}. ${truncate(compactWhitespace(thread.name || thread.preview || t(locale, 'empty')), 28)}`,
      callback_data: `thread:open:${thread.threadId}`,
    }];
    const actionRow = thread.archived
      ? [{ text: t(locale, 'button_thread_unarchive'), callback_data: `thread:unarchive:${thread.threadId}` }]
      : [
          { text: t(locale, 'button_thread_rename'), callback_data: `thread:rename:${thread.threadId}` },
          { text: t(locale, 'button_thread_archive'), callback_data: `thread:archive:${thread.threadId}` },
        ];
    return [openRow, actionRow];
  });
}

/** Threads keyboard plus Prev/Next and optional clear-filter row (Telegram only). */
export function buildThreadListKeyboard(
  locale: AppLocale,
  threads: ThreadLike[],
  listState: ThreadListPresentationState,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows = buildThreadsKeyboard(locale, threads);
  const navigationRow: InlineButton[] = [];
  if (listState.hasPreviousPage) {
    navigationRow.push({ text: t(locale, 'button_prev_page'), callback_data: 'thread:list:prev' });
  }
  if (listState.hasNextPage) {
    navigationRow.push({ text: t(locale, 'button_next_page'), callback_data: 'thread:list:next' });
  }
  if (navigationRow.length > 0) {
    rows.push(navigationRow);
  }
  if (listState.searchTerm?.trim()) {
    rows.push([{ text: t(locale, 'button_clear_filter'), callback_data: 'thread:list:clear' }]);
  }
  rows.push([{
    text: t(locale, listState.archived ? 'button_recent_threads' : 'button_archived_threads'),
    callback_data: listState.archived ? 'thread:list:recent' : 'thread:list:archived',
  }]);
  return rows;
}

export function formatWhereMessage(
  locale: AppLocale,
  thread: AppThread,
  settings: ChatSessionSettings | null,
  defaultCwd: string,
  access: ResolvedAccessMode,
  fastLabel = t(locale, 'unknown'),
): string {
  return [
    t(locale, 'where_thread', { value: thread.threadId }),
    t(locale, 'where_title', { value: thread.name || t(locale, 'untitled') }),
    t(locale, 'where_preview', { value: thread.preview || t(locale, 'empty') }),
    t(locale, 'where_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
    t(locale, 'where_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
    t(locale, 'where_fast', { value: fastLabel }),
    t(locale, 'where_collaboration_mode', { value: formatCollaborationModeLabel(locale, settings?.collaborationMode ?? null) }),
    t(locale, 'active_current', { value: formatActiveTurnMessageModeLabel(locale, settings?.activeTurnMessageMode ?? null) }),
    t(locale, 'where_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }),
    t(locale, 'where_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }),
    t(locale, 'where_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }),
    t(locale, 'where_provider', { value: thread.modelProvider ?? t(locale, 'unknown') }),
    t(locale, 'where_status', { value: formatStatus(locale, thread.status) }),
    t(locale, 'where_cwd', { value: thread.cwd ?? defaultCwd }),
    t(locale, 'where_updated', { value: formatIsoTime(locale, thread.updatedAt) }),
  ].join('\n');
}

export function formatCollaborationModeLabel(locale: AppLocale, mode: CollaborationModeValue | null | undefined): string {
  return t(locale, mode === 'plan' ? 'collaboration_mode_plan' : 'collaboration_mode_default');
}

export function formatAccessSettingsMessage(locale: AppLocale, access: ResolvedAccessMode): string {
  return [
    t(locale, 'permissions_title'),
    t(locale, 'permissions_tap_to_change'),
    '',
    t(locale, 'permissions_preset', { value: escapeTelegramHtml(formatAccessPresetLabel(locale, access.preset)) }),
    t(locale, 'permissions_approval_policy', { value: escapeTelegramHtml(formatApprovalPolicyLabel(locale, access.approvalPolicy)) }),
    t(locale, 'permissions_sandbox_mode', { value: escapeTelegramHtml(formatSandboxModeLabel(locale, access.sandboxMode)) }),
  ].join('\n');
}

export function buildAccessSettingsKeyboard(locale: AppLocale, access: ResolvedAccessMode): InlineButton[][] {
  const currentPreset = access.preset;
  const buttons: InlineButton[] = [
    {
      text: `${currentPreset === 'read-only' ? '• ' : ''}${t(locale, 'access_preset_read_only')}`,
      callback_data: 'settings:access:read-only',
    },
    {
      text: `${currentPreset === 'default' ? '• ' : ''}${t(locale, 'access_preset_default')}`,
      callback_data: 'settings:access:default',
    },
    {
      text: `${currentPreset === 'full-access' ? '• ' : ''}${t(locale, 'access_preset_full_access')}`,
      callback_data: 'settings:access:full-access',
    },
  ];
  return [buttons];
}

/** Threads row shape for Weixin copy-paste lines (matches cached thread list fields). */
export interface WeixinCopyPasteThreadRow {
  threadId: string;
  name: string | null;
  preview: string;
}

export function formatWeixinThreadsCopyPaste(
  locale: AppLocale,
  threads: WeixinCopyPasteThreadRow[],
  searchTerm?: string | null,
  /** 0-based offset so /open numbers align with cached global indices when paginating. */
  pageOffset = 0,
): string {
  const lines: string[] = [
    t(locale, 'weixin_copy_paste_divider'),
    t(locale, 'weixin_copy_threads_title'),
  ];
  if (searchTerm?.trim()) {
    lines.push(t(locale, 'weixin_copy_threads_filter', { term: searchTerm.trim() }));
  }
  if (threads.length === 0) {
    lines.push(t(locale, 'weixin_copy_threads_empty'));
  } else {
    for (let i = 0; i < threads.length; i += 1) {
      lines.push(`/open ${pageOffset + i + 1}`);
    }
  }
  lines.push(t(locale, 'weixin_copy_threads_filter_hint'));
  return lines.join('\n');
}

export function formatWeixinModelCopyPaste(
  locale: AppLocale,
  models: ModelInfo[],
  settings: ChatSessionSettings | null,
): string {
  const effective = resolveCurrentModel(models, settings?.model ?? null);
  const efforts = effective?.supportedReasoningEfforts.length
    ? effective.supportedReasoningEfforts
    : effective
      ? [effective.defaultReasoningEffort]
      : (['medium'] as ReasoningEffortValue[]);

  const lines: string[] = [
    t(locale, 'weixin_copy_paste_divider'),
    t(locale, 'weixin_copy_models_title'),
    '/model default',
    ...models.map((m) => `/model ${m.model}`),
    '',
    t(locale, 'weixin_copy_efforts_title'),
    '/effort default',
    ...efforts.map((e) => `/effort ${e}`),
    '',
    '/fast on',
    '/fast off',
  ];
  return lines.join('\n');
}

export function formatWeixinAccessCopyPaste(locale: AppLocale): string {
  return [
    t(locale, 'weixin_copy_paste_divider'),
    t(locale, 'weixin_copy_access_title'),
    '/access read-only',
    '/access default',
    '/access full-access',
  ].join('\n');
}

export function formatWeixinWhereNavCopyPaste(locale: AppLocale, hasBinding: boolean): string {
  const lines = [
    t(locale, 'weixin_copy_paste_divider'),
    t(locale, 'weixin_copy_where_nav_title'),
    '/setup',
    '/active steer',
    '/active queue',
    '/goal',
    '/history',
    '/files <query>',
    '/permissions',
    '/models',
    '/threads',
  ];
  if (hasBinding) {
    lines.push('/reveal');
  }
  return lines.join('\n');
}

export function formatSetupPanelMessage(locale: AppLocale, ctx: SetupPanelContext): string {
  const currentModel = resolveCurrentModel(ctx.models, ctx.settings?.model ?? null);
  const fastTier = resolveFastTierForModel(currentModel);
  const fastSupported = fastTier !== null;
  const fastLabel = formatFastSetupLabel(
    locale,
    fastSupported,
    fastTier !== null && ctx.settings?.serviceTier === fastTier.id,
    fastTier?.name ?? null,
  );
  const mode = resolveCollaborationMode(ctx.settings?.collaborationMode ?? null);
  const activeTurnMessageMode = resolveActiveTurnMessageMode(ctx.settings?.activeTurnMessageMode ?? null);
  return [
    t(locale, 'setup_title'),
    t(locale, 'setup_summary', { value: escapeTelegramHtml(resolveSetupSummaryLine(ctx, locale)) }),
    setupFocusLabel(locale, ctx.focus),
    '',
    t(locale, 'setup_row_model', { value: escapeTelegramHtml(ctx.settings?.model ?? t(locale, 'server_default')) }),
    t(locale, 'setup_row_effort', { value: escapeTelegramHtml(ctx.settings?.reasoningEffort ?? t(locale, 'server_default')) }),
    t(locale, 'setup_row_fast', { value: escapeTelegramHtml(fastLabel) }),
    t(locale, 'setup_row_access', {
      value: escapeTelegramHtml(`${formatAccessPresetLabel(locale, ctx.access.preset)} (${ctx.access.approvalPolicy} / ${ctx.access.sandboxMode})`),
    }),
    t(locale, 'setup_row_mode', { value: escapeTelegramHtml(formatCollaborationModeLabel(locale, mode)) }),
    t(locale, 'setup_row_active', { value: escapeTelegramHtml(formatActiveTurnMessageModeLabel(locale, activeTurnMessageMode)) }),
  ].join('\n');
}

export function buildSetupPanelKeyboard(locale: AppLocale, ctx: SetupPanelContext): InlineButton[][] {
  const currentModel = ctx.settings?.model ?? null;
  const effectiveModel = resolveCurrentModel(ctx.models, currentModel);
  const efforts = effectiveModel?.supportedReasoningEfforts.length
    ? effectiveModel.supportedReasoningEfforts
    : effectiveModel
      ? [effectiveModel.defaultReasoningEffort]
      : ['medium'];
  const fastTier = resolveFastTierForModel(effectiveModel);
  const serviceTier = ctx.settings?.serviceTier ?? null;
  const currentMode = resolveCollaborationMode(ctx.settings?.collaborationMode ?? null);
  const activeTurnMessageMode = resolveActiveTurnMessageMode(ctx.settings?.activeTurnMessageMode ?? null);

  const rows: InlineButton[][] = [];
  rows.push(...chunkButtons([
    {
      text: currentModel === null ? `• ${t(locale, 'button_auto')}` : t(locale, 'button_auto'),
      callback_data: 'setup:model:default',
    },
    ...ctx.models.map((model) => ({
      text: `${currentModel === model.model ? '• ' : ''}${truncate(model.model, 14)}`,
      callback_data: `setup:model:${encodeURIComponent(model.model)}`,
    })),
  ], 2));

  rows.push(...chunkButtons([
    {
      text: (ctx.settings?.reasoningEffort ?? null) === null ? `• ${t(locale, 'button_auto')}` : t(locale, 'button_auto'),
      callback_data: 'setup:effort:default',
    },
    ...efforts.map((effort) => ({
      text: `${ctx.settings?.reasoningEffort === effort ? '• ' : ''}${effort}`,
      callback_data: `setup:effort:${effort}`,
    })),
  ], 3));

  if (fastTier) {
    rows.push([
      {
        text: `${serviceTier === fastTier.id ? '• ' : ''}${t(locale, 'button_fast_on')}`,
        callback_data: 'setup:fast:on',
      },
      {
        text: `${serviceTier === null ? '• ' : ''}${t(locale, 'button_fast_off')}`,
        callback_data: 'setup:fast:off',
      },
    ]);
  } else {
    rows.push([{ text: t(locale, 'button_fast_unsupported'), callback_data: 'setup:fast:unsupported' }]);
  }

  rows.push([
    {
      text: `${ctx.access.preset === 'read-only' ? '• ' : ''}${t(locale, 'access_preset_read_only')}`,
      callback_data: 'setup:access:read-only',
    },
    {
      text: `${ctx.access.preset === 'default' ? '• ' : ''}${t(locale, 'access_preset_default')}`,
      callback_data: 'setup:access:default',
    },
    {
      text: `${ctx.access.preset === 'full-access' ? '• ' : ''}${t(locale, 'access_preset_full_access')}`,
      callback_data: 'setup:access:full-access',
    },
  ]);

  rows.push([
    {
      text: `${currentMode === 'default' ? '• ' : ''}${t(locale, 'collaboration_mode_default')}`,
      callback_data: 'setup:mode:default',
    },
    {
      text: `${currentMode === 'plan' ? '• ' : ''}${t(locale, 'collaboration_mode_plan')}`,
      callback_data: 'setup:mode:plan',
    },
  ]);

  rows.push([
    {
      text: `${activeTurnMessageMode === 'steer' ? '• ' : ''}${t(locale, 'active_turn_message_mode_steer')}`,
      callback_data: 'setup:active:steer',
    },
    {
      text: `${activeTurnMessageMode === 'queue' ? '• ' : ''}${t(locale, 'active_turn_message_mode_queue')}`,
      callback_data: 'setup:active:queue',
    },
  ]);

  return rows;
}

export function resolveSetupSummaryLine(ctx: SetupPanelContext, locale: AppLocale = 'en'): string {
  const currentModel = ctx.settings?.model ?? t(locale, 'server_default');
  const currentEffort = ctx.settings?.reasoningEffort ?? t(locale, 'server_default');
  const model = resolveCurrentModel(ctx.models, ctx.settings?.model ?? null);
  const fastTier = resolveFastTierForModel(model);
  const fast = fastTier ? (ctx.settings?.serviceTier === fastTier.id ? 'fast=on' : 'fast=off') : 'fast=unsupported';
  return [
    currentModel,
    currentEffort,
    fast,
    ctx.access.preset,
    resolveCollaborationMode(ctx.settings?.collaborationMode ?? null),
    resolveActiveTurnMessageMode(ctx.settings?.activeTurnMessageMode ?? null),
  ].join(' · ');
}

export function formatServiceTierStatusLabel(
  locale: AppLocale,
  model: ModelInfo | null,
  serviceTier: string | null | undefined,
): string {
  const fastTier = resolveFastTierForModel(model);
  if (!fastTier) {
    return t(locale, 'fast_unsupported');
  }
  if (serviceTier === fastTier.id) {
    return t(locale, 'fast_enabled', { tier: fastTier.name || fastTier.id });
  }
  return t(locale, 'fast_disabled');
}

export function formatActiveTurnMessageModeLabel(locale: AppLocale, mode: ActiveTurnMessageMode | null | undefined): string {
  return t(locale, resolveActiveTurnMessageMode(mode) === 'queue' ? 'active_turn_message_mode_queue' : 'active_turn_message_mode_steer');
}

function setupFocusLabel(locale: AppLocale, focus: SetupFocusSection): string {
  switch (focus) {
    case 'model':
      return t(locale, 'setup_focus_model');
    case 'effort':
      return t(locale, 'setup_focus_effort');
    case 'fast':
      return t(locale, 'setup_focus_fast');
    case 'access':
      return t(locale, 'setup_focus_access');
    case 'mode':
      return t(locale, 'setup_focus_mode');
    case 'active':
      return t(locale, 'setup_focus_active');
    default:
      return t(locale, 'setup_focus_overview');
  }
}

export function resolveActiveTurnMessageMode(mode: ActiveTurnMessageMode | null | undefined): ActiveTurnMessageMode {
  return mode === 'queue' ? 'queue' : 'steer';
}

function formatFastSetupLabel(
  locale: AppLocale,
  supported: boolean,
  enabled: boolean,
  tierName: string | null,
): string {
  if (!supported) {
    return t(locale, 'fast_unsupported');
  }
  if (enabled) {
    return t(locale, 'fast_enabled', { tier: tierName ?? 'fast' });
  }
  return t(locale, 'fast_disabled');
}

function resolveCollaborationMode(mode: CollaborationModeValue | null | undefined): CollaborationModeValue {
  return mode === 'plan' ? 'plan' : 'default';
}

export function formatModelSettingsMessage(
  locale: AppLocale,
  models: ModelInfo[],
  settings: ChatSessionSettings | null,
): string {
  const selectedModel = resolveCurrentModel(models, settings?.model ?? null);
  const selectedModelLabel = settings?.model ?? t(locale, 'server_default');
  const selectedEffort = settings?.reasoningEffort ?? null;
  const supportedEfforts = selectedModel?.supportedReasoningEfforts.length
    ? selectedModel.supportedReasoningEfforts
    : selectedModel
      ? [selectedModel.defaultReasoningEffort]
      : [];

  return [
    t(locale, 'models_title'),
    t(locale, 'models_tap_to_change'),
    '',
    t(locale, 'models_model', { value: escapeTelegramHtml(selectedModelLabel) }),
    t(locale, 'models_effort', { value: escapeTelegramHtml(selectedEffort ?? t(locale, 'server_default')) }),
    selectedModel ? t(locale, 'models_current_default_target', { value: escapeTelegramHtml(selectedModel.model) }) : null,
    supportedEfforts.length > 0
      ? t(locale, 'models_supported_efforts', { value: escapeTelegramHtml(supportedEfforts.join(', ')) })
      : t(locale, 'models_supported_efforts_unknown'),
  ].filter(Boolean).join('\n');
}

export function buildModelSettingsKeyboard(
  locale: AppLocale,
  models: ModelInfo[],
  settings: ChatSessionSettings | null,
): InlineButton[][] {
  const currentModel = settings?.model ?? null;
  const effectiveModel = resolveCurrentModel(models, currentModel);
  const efforts = effectiveModel?.supportedReasoningEfforts.length
    ? effectiveModel.supportedReasoningEfforts
    : effectiveModel
      ? [effectiveModel.defaultReasoningEffort]
      : ['medium'];

  const modelButtons: InlineButton[] = [
    {
      text: currentModel === null ? `• ${t(locale, 'button_auto')}` : t(locale, 'button_auto'),
      callback_data: 'settings:model:default',
    },
    ...models.map((model) => ({
      text: `${currentModel === model.model ? '• ' : ''}${truncate(model.model, 14)}`,
      callback_data: `settings:model:${encodeURIComponent(model.model)}`,
    })),
  ];

  const effortButtons: InlineButton[] = [
    {
      text: settings?.reasoningEffort === null ? `• ${t(locale, 'button_auto')}` : t(locale, 'button_auto'),
      callback_data: 'settings:effort:default',
    },
    ...efforts.map((effort) => ({
      text: `${settings?.reasoningEffort === effort ? '• ' : ''}${effort}`,
      callback_data: `settings:effort:${effort}`,
    })),
  ];

  return [
    ...chunkButtons(modelButtons, 2),
    ...chunkButtons(effortButtons, 3),
  ];
}

export function resolveRequestedModel(models: ModelInfo[], requested: string): ModelInfo | null {
  const normalized = requested.trim().toLowerCase();
  return models.find(model => (
    model.model.toLowerCase() === normalized
    || model.id.toLowerCase() === normalized
    || model.displayName.toLowerCase() === normalized
  )) ?? null;
}

export function resolveCurrentModel(models: ModelInfo[], currentModel: string | null): ModelInfo | null {
  if (currentModel) {
    const current = resolveRequestedModel(models, currentModel);
    if (current) return current;
  }
  return models.find(model => model.isDefault) ?? null;
}

export function normalizeRequestedEffort(value: string): ReasoningEffortValue | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'none'
    || normalized === 'minimal'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'xhigh'
  ) {
    return normalized;
  }
  return null;
}

export function clampEffortToModel(
  model: ModelInfo | null,
  effort: ReasoningEffortValue | null,
): { effort: ReasoningEffortValue | null; adjustedFrom: ReasoningEffortValue | null } {
  if (!model || !effort) {
    return { effort, adjustedFrom: null };
  }
  if (model.supportedReasoningEfforts.includes(effort)) {
    return { effort, adjustedFrom: null };
  }
  return { effort: model.defaultReasoningEffort, adjustedFrom: effort };
}

export function formatAccessPresetLabel(locale: AppLocale, preset: AccessPresetValue): string {
  if (preset === 'read-only') return t(locale, 'access_preset_read_only');
  if (preset === 'full-access') return t(locale, 'access_preset_full_access');
  return t(locale, 'access_preset_default');
}

export function formatApprovalPolicyLabel(locale: AppLocale, policy: ApprovalPolicyValue): string {
  if (policy === 'never') return t(locale, 'approval_policy_never');
  if (policy === 'untrusted') return t(locale, 'approval_policy_untrusted');
  if (policy === 'on-failure') return t(locale, 'approval_policy_on_failure');
  return t(locale, 'approval_policy_on_request');
}

export function formatSandboxModeLabel(locale: AppLocale, mode: SandboxModeValue): string {
  if (mode === 'danger-full-access') return t(locale, 'sandbox_mode_danger_full_access');
  if (mode === 'read-only') return t(locale, 'sandbox_mode_read_only');
  return t(locale, 'sandbox_mode_workspace_write');
}

function formatStatus(locale: AppLocale, status: AppThread['status']): string {
  switch (status) {
    case 'active':
      return t(locale, 'status_active');
    case 'notLoaded':
      return t(locale, 'status_not_loaded');
    case 'systemError':
      return t(locale, 'status_error');
    default:
      return t(locale, 'status_idle');
  }
}

function formatStatusLabel(locale: AppLocale, status: AppThread['status']): string {
  if (status === 'active') return t(locale, 'status_active');
  if (status === 'systemError') return t(locale, 'status_error');
  return '';
}

function formatCwd(locale: AppLocale, cwd: string | null): string {
  if (!cwd) return t(locale, 'no_cwd');
  const base = path.basename(cwd);
  return base || cwd;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function formatRelativeTime(locale: AppLocale, unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return t(locale, 'unknown');
  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(unixSeconds));
  if (locale === 'zh') {
    if (deltaSeconds < 60) return `${deltaSeconds}秒前`;
    if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}分钟前`;
    if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}小时前`;
    return `${Math.floor(deltaSeconds / 86_400)}天前`;
  }
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}

function formatIsoTime(locale: AppLocale, unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return t(locale, 'unknown');
  return new Date(unixSeconds * 1000).toISOString();
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function chunkButtons(buttons: InlineButton[], width: number): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let index = 0; index < buttons.length; index += width) {
    rows.push(buttons.slice(index, index + width));
  }
  return rows;
}
