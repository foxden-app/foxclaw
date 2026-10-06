import type { AppLocale, AppTurnSnapshot, PendingAttachmentBatchRecord, PendingApprovalRecord } from '../types.js';
import { t } from '../i18n.js';
import { BRIDGE_SCOPE_WEIXIN_PREFIX, parseTelegramTargetFromBridgeScope, parseWeixinBridgeScope } from '../core/bridge_scope.js';
import type { ActiveTurnPreviewRecord, PendingUserInputStoredRecord } from '../store/database.js';
import { type ObservedTurnCursor } from './observer.js';
import type { TurnInput } from '../codex_app/client.js';
import { type StagedTelegramAttachment } from '../telegram/media.js';
import {
  PendingMcpElicitation,
  McpElicitationAction,
  ActiveTurn,
  ApprovalAction,
  PendingUserInputQuestion,
  PendingUserInputOption,
  ServerRequestId,
  PendingUserInputRequest,
  PendingUserInputStatus,
  ATTACHMENT_BATCH_MERGE_WINDOW_MS,
  PendingPlanImplementation,
} from './state_types.js';
import { truncateInline } from './turn_rendering.js';
import { stringOrNull, clipButtonText } from './shared_helpers.js';

export function renderMcpElicitationMessage(
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
  if (!decision && parseWeixinBridgeScope(record.chatId)) {
    lines.push(
      '',
      t(locale, 'weixin_copy_paste_divider'),
      t(locale, 'weixin_copy_mcp_title'),
    );
    if (record.mode === 'form') {
      lines.push(t(locale, 'weixin_copy_mcp_json_hint'));
    }
    lines.push(
      `/mcpel ${record.localId} accept`,
      `/mcpel ${record.localId} decline`,
      `/mcpel ${record.localId} cancel`,
    );
  }
  return lines.join('\n');
}

export function mcpElicitationKeyboard(locale: AppLocale, record: PendingMcpElicitation): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_accept'), callback_data: `mcpel:${record.localId}:accept` },
    { text: t(locale, 'button_decline'), callback_data: `mcpel:${record.localId}:decline` },
    { text: t(locale, 'button_cancel'), callback_data: `mcpel:${record.localId}:cancel` },
  ]];
}

export function formatPermissionRequestSummary(locale: AppLocale, permissions: any): string {
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

export function resolveScopeMessageTarget(scopeId: string): { chatId: string; chatType: string; topicId: number | null } | null {
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

export function restartPreviewRecoveryKey(preview: Pick<ActiveTurnPreviewRecord, 'scopeId' | 'turnId' | 'messageId'>): string {
  return `${preview.scopeId}:${preview.turnId}:${preview.messageId}`;
}

export function seedObservedTurnCursor(turn: AppTurnSnapshot): ObservedTurnCursor {
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

export function observerCursorFromActiveTurn(active: ActiveTurn): ObservedTurnCursor {
  const itemTexts: Record<string, string> = {};
  const completedItemIds: string[] = [];
  for (const segment of active.segments) {
    itemTexts[segment.itemId] = segment.text;
    if (segment.completed) {
      completedItemIds.push(segment.itemId);
    }
  }
  return {
    turnId: active.turnId,
    itemTexts,
    completedItemIds,
  };
}

export function approvalKeyboard(locale: AppLocale, localId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_allow'), callback_data: `approval:${localId}:accept` },
    { text: t(locale, 'button_allow_session'), callback_data: `approval:${localId}:session` },
    { text: t(locale, 'button_deny'), callback_data: `approval:${localId}:deny` },
  ]];
}

export function activeTurnKeyboard(locale: AppLocale, turnId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_interrupt'), callback_data: `turn:interrupt:${turnId}` },
  ]];
}

export function whereKeyboard(locale: AppLocale, hasBinding: boolean): Array<Array<{ text: string; callback_data: string }>> {
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

export function renderApprovalMessage(
  locale: AppLocale,
  record: PendingApprovalRecord,
  decision?: ApprovalAction,
  renderScopeId = record.chatId,
): string {
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
  if (!decision && parseWeixinBridgeScope(renderScopeId)) {
    lines.push(
      '',
      t(locale, 'weixin_copy_paste_divider'),
      t(locale, 'weixin_copy_approval_title'),
      `/approve ${record.localId} allow`,
      `/approve ${record.localId} session`,
      `/approve ${record.localId} deny`,
    );
  }
  return lines.join('\n');
}

export function mapApprovalDecision(record: PendingApprovalRecord, action: ApprovalAction): unknown {
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

export function parseApprovalPayload(payloadJson: string | null): any {
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

export function grantedPermissionsFromRequest(requested: any): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (requested?.network) {
    result.network = requested.network;
  }
  if (requested?.fileSystem) {
    result.fileSystem = requested.fileSystem;
  }
  return result;
}

export function parseUserInputQuestions(params: any): PendingUserInputQuestion[] {
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

export function parseServerRequestId(raw: unknown): ServerRequestId | null {
  if (typeof raw === 'string' || typeof raw === 'number') {
    return raw;
  }
  return null;
}

export function stringifyServerRequestId(id: ServerRequestId): string {
  return String(id);
}

export function sameServerRequestId(left: ServerRequestId, right: ServerRequestId): boolean {
  return stringifyServerRequestId(left) === stringifyServerRequestId(right);
}

export function parseStoredServerRequestId(raw: string): ServerRequestId {
  if (/^(0|[1-9]\d*)$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) {
      return value;
    }
  }
  return raw;
}

export function serializePendingUserInput(record: PendingUserInputRequest): PendingUserInputStoredRecord {
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

export function parseStoredPendingUserInput(record: PendingUserInputStoredRecord): PendingUserInputRequest | null {
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

export function normalizePendingUserInputStatus(raw: string | null | undefined): PendingUserInputStatus {
  if (raw === 'submitted' || raw === 'resolved' || raw === 'interrupted') {
    return raw;
  }
  return 'pending';
}

export function parseStoredUserInputQuestions(rawJson: string): PendingUserInputQuestion[] {
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

export function stringifyPendingUserInputAnswers(answers: Map<string, string>): string {
  return JSON.stringify(Object.fromEntries(answers.entries()));
}

export function parseStoredUserInputAnswers(rawJson: string): Map<string, string> {
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

export function normalizeStoredUserInputAnswer(rawAnswer: unknown): string | null {
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

export function pendingUserInputCurrentQuestionIndex(record: PendingUserInputRequest): number {
  const index = record.questions.findIndex(question => !record.answers.has(question.id));
  return index === -1 ? record.questions.length : index;
}

export function renderUserInputMessage(
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
    if (question.header && question.question) {
      lines.push(`${index + 1}. **${title}** ${question.question}`);
    } else {
      lines.push(`${index + 1}. **${title}**`);
    }
    if (question.isOther) {
      lines.push(`   - ${t(locale, 'user_input_other_hint')}`);
    }
    if (question.isSecret) {
      lines.push(`   - ${t(locale, 'user_input_secret_warning')}`);
    }
    question.options.forEach((option, optionIndex) => {
      const description = option.description ? ` - ${option.description}` : '';
      lines.push(`   ${optionIndex + 1}. ${option.label}${description}`);
    });
    const answer = record.answers.get(question.id);
    if (answer) {
      lines.push(`   - ${t(locale, 'user_input_selected', { value: answer })}`);
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
  if (record.status === 'pending' && parseWeixinBridgeScope(record.chatId)) {
    lines.push(
      '',
      t(locale, 'weixin_copy_paste_divider'),
      t(locale, 'weixin_copy_answer_title'),
    );
    record.questions.forEach((question, questionIndex) => {
      if (record.answers.has(question.id)) {
        return;
      }
      if (question.options.length > 0) {
        question.options.forEach((_option, optionIndex) => {
          lines.push(`/answer ${record.localId} ${questionIndex + 1} ${optionIndex + 1}`);
        });
      }
      lines.push(`/answer ${record.localId} ${questionIndex + 1} <text>`);
    });
  }
  return lines.join('\n');
}

export function userInputKeyboard(record: PendingUserInputRequest): Array<Array<{ text: string; callback_data: string }>> {
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

export function parseStoredTurnInput(inputJson: string): TurnInput[] {
  const value = JSON.parse(inputJson) as unknown;
  if (!Array.isArray(value)) {
    throw new Error('Queued turn input is not an array');
  }
  return value as TurnInput[];
}

export function parseStagedTelegramAttachments(attachmentsJson: string): StagedTelegramAttachment[] {
  const value = JSON.parse(attachmentsJson) as unknown;
  if (!Array.isArray(value)) {
    throw new Error('Attachment batch payload is not an array');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Attachment batch contains an invalid entry');
    }
    const attachment = entry as Partial<StagedTelegramAttachment>;
    if (typeof attachment.localPath !== 'string' || typeof attachment.relativePath !== 'string') {
      throw new Error('Attachment batch entry is missing a local path');
    }
    return attachment as StagedTelegramAttachment;
  });
}

export function findReusableStandaloneAttachmentBatch(
  batch: PendingAttachmentBatchRecord | null,
  now: number,
): PendingAttachmentBatchRecord | null {
  if (!batch || batch.mediaGroupId !== null) {
    return null;
  }
  return now - batch.updatedAt <= ATTACHMENT_BATCH_MERGE_WINDOW_MS ? batch : null;
}

export function mergeAttachmentBatchCaption(existing: string, next: string): string {
  const normalizedNext = next.trim();
  if (!normalizedNext) {
    return existing;
  }
  const normalizedExisting = existing.trim();
  if (!normalizedExisting) {
    return normalizedNext;
  }
  return normalizedExisting === normalizedNext ? normalizedExisting : `${normalizedExisting}\n\n${normalizedNext}`;
}

export function summarizeStagedAttachmentInput(
  text: string,
  attachments: readonly StagedTelegramAttachment[],
): string {
  const lines = [text.trim() || '(no text)'];
  if (attachments.length > 0) {
    lines.push(`[attachments: ${attachments.map((attachment) => `${attachment.kind}:${attachment.fileName}`).join(', ')}]`);
  }
  return lines.join('\n');
}

export function renderAttachmentBatchMessage(locale: AppLocale, record: PendingAttachmentBatchRecord): string {
  const attachments = parseStagedTelegramAttachments(record.attachmentsJson);
  const lines = [
    t(locale, 'attachment_batch_staged', { count: attachments.length }),
  ];
  if (record.caption.trim()) {
    lines.push('', t(locale, 'attachment_batch_caption', { value: truncateInline(record.caption.trim(), 600) }));
  }
  lines.push('');
  for (const [index, attachment] of attachments.entries()) {
    const name = attachment.fileName || attachment.fileUniqueId;
    const size = attachment.fileSize === null ? '' : `, ${attachment.fileSize} bytes`;
    lines.push(`${index + 1}. ${attachment.kind}: ${name}${size}`);
  }
  return lines.join('\n');
}

export function attachmentBatchKeyboard(locale: AppLocale, batchId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'attachment_batch_button_analyze'), callback_data: `attach:${batchId}:analyze` },
    { text: t(locale, 'attachment_batch_button_clear'), callback_data: `attach:${batchId}:clear` },
  ]];
}

export function shortId(value: string): string {
  return value.slice(0, 8);
}

export function renderPlanImplementationPrompt(locale: AppLocale, record: PendingPlanImplementation): string {
  const lines = [
    t(locale, 'plan_impl_title'),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
    '',
    t(locale, 'plan_impl_prompt'),
  ];
  if (parseWeixinBridgeScope(record.scopeId)) {
    lines.push(
      '',
      t(locale, 'weixin_copy_paste_divider'),
      t(locale, 'weixin_copy_plan_title'),
      `/planimpl ${record.localId} run`,
      `/planimpl ${record.localId} fresh`,
      `/planimpl ${record.localId} stay`,
    );
  }
  return lines.join('\n');
}

export function planImplementationKeyboard(locale: AppLocale, localId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [{ text: t(locale, 'plan_impl_button_run'), callback_data: `planimpl:${localId}:run` }],
    [{ text: t(locale, 'plan_impl_button_fresh'), callback_data: `planimpl:${localId}:fresh` }],
    [{ text: t(locale, 'plan_impl_button_stay'), callback_data: `planimpl:${localId}:stay` }],
  ];
}

export function threadNewCwdCreateKeyboard(locale: AppLocale): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_create_dir'), callback_data: 'thread:newcwd:create' },
    { text: t(locale, 'button_cancel'), callback_data: 'thread:newcwd:cancel' },
  ]];
}
