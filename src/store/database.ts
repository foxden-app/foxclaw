import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  AccessPresetValue,
  ActiveTurnMessageMode,
  AppLocale,
  CachedThread,
  ChatSessionSettings,
  CollaborationModeValue,
  GuidedPlanSessionRecord,
  GuidedPlanSessionState,
  PendingAttachmentBatchRecord,
  PendingAttachmentBatchStatus,
  PendingApprovalRecord,
  QueuedTurnInputRecord,
  QueuedTurnInputStatus,
  ReasoningEffortValue,
  ThreadBinding,
} from '../types.js';
import { migrateLegacyBridgeScopeIds } from './migrate_bridge_scope.js';

export interface ActiveTurnPreviewRecord {
  turnId: string;
  scopeId: string;
  threadId: string;
  messageId: number;
  createdAt: number;
  updatedAt: number;
}

export interface PendingUserInputStoredRecord {
  localId: string;
  serverRequestId: string;
  chatId: string;
  threadId: string;
  turnId: string | null;
  itemId: string;
  messageId: number | null;
  questionsJson: string;
  answersJson: string;
  currentQuestionIndex: number;
  awaitingFreeText: boolean;
  status: string;
  createdAt: number;
  submittedAt: number | null;
  resolvedAt: number | null;
}

export interface CodexAuthQuotaSnapshotRecord {
  runtimeId: string;
  candidateName: string;
  accountId: string;
  capturedAtMs: number;
  planType: string | null;
  primaryWindowDurationMins: number | null;
  primaryRemainingPercent: number | null;
  secondaryWindowDurationMins: number | null;
  secondaryRemainingPercent: number | null;
  updatedAt: number;
}

export class BridgeStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_offsets (
        bot_key TEXT PRIMARY KEY,
        update_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telegram_private_scopes (
        bot_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_bindings (
        chat_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        cwd TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_settings (
        chat_id TEXT PRIMARY KEY,
        model TEXT,
        reasoning_effort TEXT,
        locale TEXT,
        access_preset TEXT,
        collaboration_mode TEXT,
        service_tier TEXT,
        active_turn_message_mode TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_cache (
        chat_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        name TEXT,
        preview TEXT NOT NULL,
        cwd TEXT,
        model_provider TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, idx)
      );
      CREATE TABLE IF NOT EXISTS pending_approvals (
        local_id TEXT PRIMARY KEY,
        server_request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        approval_id TEXT,
        reason TEXT,
        command TEXT,
        cwd TEXT,
        payload_json TEXT,
        message_id INTEGER,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS active_turn_previews (
        turn_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_user_inputs (
        local_id TEXT PRIMARY KEY,
        server_request_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        item_id TEXT NOT NULL,
        message_id INTEGER,
        questions_json TEXT NOT NULL,
        answers_json TEXT NOT NULL,
        current_question_index INTEGER NOT NULL,
        awaiting_free_text INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        submitted_at INTEGER,
        resolved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pending_user_input_messages (
        input_local_id TEXT NOT NULL,
        question_index INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        message_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (input_local_id, question_index, message_kind)
      );
      CREATE TABLE IF NOT EXISTS queued_turn_inputs (
        queue_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        topic_id INTEGER,
        thread_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        source_summary TEXT NOT NULL,
        message_id INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS queued_turn_inputs_scope_status_idx
        ON queued_turn_inputs(scope_id, status, created_at);
      CREATE TABLE IF NOT EXISTS pending_attachment_batches (
        batch_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        topic_id INTEGER,
        thread_id TEXT NOT NULL,
        cwd TEXT,
        media_group_id TEXT,
        attachments_json TEXT NOT NULL,
        caption TEXT NOT NULL,
        message_id INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS pending_attachment_batches_scope_status_idx
        ON pending_attachment_batches(scope_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS guided_plan_sessions (
        session_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        topic_id INTEGER,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        cwd TEXT,
        plan_markdown TEXT NOT NULL,
        message_id INTEGER,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS guided_plan_sessions_scope_state_idx
        ON guided_plan_sessions(scope_id, state, updated_at);
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS weixin_context_tokens (
        scope_id TEXT PRIMARY KEY,
        context_token TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_auth_candidates (
        name TEXT PRIMARY KEY,
        disabled INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_auth_candidate_runtime (
        runtime_id TEXT NOT NULL,
        name TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (runtime_id, name)
      );
      CREATE TABLE IF NOT EXISTS codex_auth_quota_snapshots (
        runtime_id TEXT NOT NULL,
        candidate_name TEXT NOT NULL,
        account_id TEXT NOT NULL,
        captured_at_ms INTEGER NOT NULL,
        plan_type TEXT,
        primary_window_duration_mins REAL,
        primary_remaining_percent REAL,
        secondary_window_duration_mins REAL,
        secondary_remaining_percent REAL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (runtime_id, candidate_name)
      );
      CREATE INDEX IF NOT EXISTS codex_auth_quota_snapshots_account_idx
        ON codex_auth_quota_snapshots(account_id);
    `);
    this.ensureColumn('thread_cache', 'name', 'TEXT');
    this.ensureColumn('thread_cache', 'model_provider', 'TEXT');
    this.ensureColumn('thread_cache', 'status', "TEXT NOT NULL DEFAULT 'idle'");
    this.ensureColumn('thread_cache', 'archived', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('chat_settings', 'locale', 'TEXT');
    this.ensureColumn('chat_settings', 'access_preset', 'TEXT');
    this.ensureColumn('chat_settings', 'collaboration_mode', 'TEXT');
    this.ensureColumn('chat_settings', 'service_tier', 'TEXT');
    this.ensureColumn('chat_settings', 'active_turn_message_mode', 'TEXT');
    this.ensureColumn('pending_approvals', 'payload_json', 'TEXT');
    this.ensureColumn('pending_user_inputs', 'status', "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumn('pending_user_inputs', 'submitted_at', 'INTEGER');
    this.ensureColumn('codex_auth_quota_snapshots', 'plan_type', 'TEXT');
    this.ensureColumn('codex_auth_quota_snapshots', 'primary_window_duration_mins', 'REAL');
    this.ensureColumn('codex_auth_quota_snapshots', 'secondary_window_duration_mins', 'REAL');
    migrateLegacyBridgeScopeIds(this.db);
  }

  getTelegramOffset(botKey: string): number {
    const row = this.db.prepare('SELECT update_id FROM telegram_offsets WHERE bot_key = ?').get(botKey) as { update_id: number } | undefined;
    return row?.update_id ?? 0;
  }

  setTelegramOffset(botKey: string, updateId: number): void {
    this.db.prepare(`
      INSERT INTO telegram_offsets (bot_key, update_id)
      VALUES (?, ?)
      ON CONFLICT(bot_key) DO UPDATE SET update_id = excluded.update_id
    `).run(botKey, updateId);
  }

  rememberTelegramPrivateScope(botId: string, scopeId: string, chatId: string): void {
    this.db.prepare(`
      INSERT INTO telegram_private_scopes (bot_id, scope_id, chat_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET scope_id = excluded.scope_id, chat_id = excluded.chat_id, updated_at = excluded.updated_at
    `).run(botId, scopeId, chatId, Date.now());
  }

  getTelegramPrivateChatId(botId: string): string | null {
    const row = this.db.prepare('SELECT chat_id FROM telegram_private_scopes WHERE bot_id = ?').get(botId) as { chat_id: string } | undefined;
    return row ? String(row.chat_id) : null;
  }

  getTelegramPrivateScope(botId: string): { scopeId: string; chatId: string } | null {
    const row = this.db.prepare('SELECT scope_id, chat_id FROM telegram_private_scopes WHERE bot_id = ?').get(botId) as {
      scope_id: string;
      chat_id: string;
    } | undefined;
    return row ? { scopeId: String(row.scope_id), chatId: String(row.chat_id) } : null;
  }

  getBinding(chatId: string): ThreadBinding | null {
    const row = this.db.prepare('SELECT chat_id, thread_id, cwd, updated_at FROM chat_bindings WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      cwd: row.cwd === null ? null : String(row.cwd),
      updatedAt: Number(row.updated_at)
    };
  }

  setBinding(chatId: string, threadId: string, cwd: string | null): void {
    this.db.prepare(`
      INSERT INTO chat_bindings (chat_id, thread_id, cwd, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET thread_id = excluded.thread_id, cwd = excluded.cwd, updated_at = excluded.updated_at
    `).run(chatId, threadId, cwd, Date.now());
  }

  clearBinding(chatId: string): void {
    this.db.prepare('DELETE FROM chat_bindings WHERE chat_id = ?').run(chatId);
  }

  getChatSettings(chatId: string): ChatSessionSettings | null {
    const row = this.db.prepare('SELECT chat_id, model, reasoning_effort, locale, access_preset, collaboration_mode, service_tier, active_turn_message_mode, updated_at FROM chat_settings WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      chatId: String(row.chat_id),
      model: row.model === null ? null : String(row.model),
      reasoningEffort: row.reasoning_effort === null ? null : String(row.reasoning_effort) as ReasoningEffortValue,
      locale: row.locale === null ? null : String(row.locale) as AppLocale,
      accessPreset: row.access_preset === null ? null : String(row.access_preset) as AccessPresetValue,
      collaborationMode: normalizeCollaborationMode(row.collaboration_mode),
      serviceTier: row.service_tier === null ? null : String(row.service_tier),
      activeTurnMessageMode: normalizeActiveTurnMessageMode(row.active_turn_message_mode),
      updatedAt: Number(row.updated_at),
    };
  }

  setChatSettings(chatId: string, model: string | null, reasoningEffort: ReasoningEffortValue | null, locale?: AppLocale | null): void {
    const current = this.getChatSettings(chatId);
    const nextLocale = locale === undefined ? current?.locale ?? null : locale;
    this.writeChatSettings(
      chatId,
      model,
      reasoningEffort,
      nextLocale,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.serviceTier ?? null,
      current?.activeTurnMessageMode ?? null,
    );
  }

  setChatLocale(chatId: string, locale: AppLocale): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      locale,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.serviceTier ?? null,
      current?.activeTurnMessageMode ?? null,
    );
  }

  setChatAccessPreset(chatId: string, accessPreset: AccessPresetValue | null): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      current?.locale ?? null,
      accessPreset,
      current?.collaborationMode ?? null,
      current?.serviceTier ?? null,
      current?.activeTurnMessageMode ?? null,
    );
  }

  setChatCollaborationMode(chatId: string, collaborationMode: CollaborationModeValue | null): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      collaborationMode,
      current?.serviceTier ?? null,
      current?.activeTurnMessageMode ?? null,
    );
  }

  setChatServiceTier(chatId: string, serviceTier: string | null): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      serviceTier,
      current?.activeTurnMessageMode ?? null,
    );
  }

  setChatActiveTurnMessageMode(chatId: string, activeTurnMessageMode: ActiveTurnMessageMode | null): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.serviceTier ?? null,
      activeTurnMessageMode,
    );
  }

  findChatIdByThreadId(threadId: string): string | null {
    const row = this.db.prepare('SELECT chat_id FROM chat_bindings WHERE thread_id = ?').get(threadId) as { chat_id: string } | undefined;
    return row ? String(row.chat_id) : null;
  }

  findAllChatIdsByThreadId(threadId: string): string[] {
    const rows = this.db.prepare('SELECT chat_id FROM chat_bindings WHERE thread_id = ? ORDER BY updated_at ASC').all(threadId) as Array<{ chat_id: string }>;
    return rows.map(row => String(row.chat_id));
  }

  countBindings(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM chat_bindings').get() as { count: number };
    return Number(row.count);
  }

  cacheThreadList(chatId: string, threads: Array<Omit<CachedThread, 'index' | 'archived'> & { listIndex?: number; archived?: boolean }>): void {
    const deleteStmt = this.db.prepare('DELETE FROM thread_cache WHERE chat_id = ?');
    const insertStmt = this.db.prepare(`
      INSERT INTO thread_cache (chat_id, idx, thread_id, name, preview, cwd, model_provider, status, archived, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    deleteStmt.run(chatId);
    threads.forEach((thread, index) => {
      const idx = typeof thread.listIndex === 'number' ? thread.listIndex : index + 1;
      insertStmt.run(
        chatId,
        idx,
        thread.threadId,
        thread.name,
        thread.preview,
        thread.cwd,
        thread.modelProvider,
        thread.status,
        thread.archived ? 1 : 0,
        thread.updatedAt,
      );
    });
  }

  getCachedThread(chatId: string, index: number): CachedThread | null {
    const row = this.db.prepare(`
      SELECT idx, thread_id, name, preview, cwd, model_provider, status, archived, updated_at
      FROM thread_cache
      WHERE chat_id = ? AND idx = ?
    `).get(chatId, index) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      index: Number(row.idx),
      threadId: String(row.thread_id),
      name: row.name === null ? null : String(row.name),
      preview: String(row.preview),
      cwd: row.cwd === null ? null : String(row.cwd),
      modelProvider: row.model_provider === null ? null : String(row.model_provider),
      status: String(row.status) as CachedThread['status'],
      archived: Boolean(row.archived),
      updatedAt: Number(row.updated_at),
    };
  }

  listCachedThreads(chatId: string): CachedThread[] {
    const rows = this.db.prepare(`
      SELECT idx, thread_id, name, preview, cwd, model_provider, status, archived, updated_at
      FROM thread_cache
      WHERE chat_id = ?
      ORDER BY idx ASC
    `).all(chatId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      index: Number(row.idx),
      threadId: String(row.thread_id),
      name: row.name === null ? null : String(row.name),
      preview: String(row.preview),
      cwd: row.cwd === null ? null : String(row.cwd),
      modelProvider: row.model_provider === null ? null : String(row.model_provider),
      status: String(row.status) as CachedThread['status'],
      archived: Boolean(row.archived),
      updatedAt: Number(row.updated_at),
    }));
  }

  savePendingApproval(record: PendingApprovalRecord): void {
    this.db.prepare(`
      INSERT INTO pending_approvals (
        local_id, server_request_id, kind, chat_id, thread_id, turn_id, item_id, approval_id, reason, command, cwd, payload_json, message_id, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.localId,
      record.serverRequestId,
      record.kind,
      record.chatId,
      record.threadId,
      record.turnId,
      record.itemId,
      record.approvalId,
      record.reason,
      record.command,
      record.cwd,
      record.payloadJson,
      record.messageId,
      record.createdAt,
      record.resolvedAt,
    );
  }

  updatePendingApprovalMessage(localId: string, messageId: number): void {
    this.db.prepare('UPDATE pending_approvals SET message_id = ? WHERE local_id = ?').run(messageId, localId);
  }

  getPendingApproval(localId: string): PendingApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_approvals WHERE local_id = ?').get(localId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapApproval(row);
  }

  getPendingApprovalByServerRequestId(serverRequestId: string): PendingApprovalRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM pending_approvals
      WHERE server_request_id = ? AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(serverRequestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapApproval(row);
  }

  markApprovalResolved(localId: string): void {
    this.db.prepare('UPDATE pending_approvals SET resolved_at = ? WHERE local_id = ?').run(Date.now(), localId);
  }

  countPendingApprovals(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM pending_approvals WHERE resolved_at IS NULL').get() as { count: number };
    return Number(row.count);
  }

  saveActiveTurnPreview(record: Pick<ActiveTurnPreviewRecord, 'turnId' | 'scopeId' | 'threadId' | 'messageId'>): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM active_turn_previews WHERE turn_id = ? OR scope_id = ?').run(record.turnId, record.scopeId);
    this.db.prepare(`
      INSERT INTO active_turn_previews (turn_id, scope_id, thread_id, message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.turnId, record.scopeId, record.threadId, record.messageId, now, now);
  }

  listActiveTurnPreviews(): ActiveTurnPreviewRecord[] {
    const rows = this.db.prepare(`
      SELECT turn_id, scope_id, thread_id, message_id, created_at, updated_at
      FROM active_turn_previews
      ORDER BY created_at ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      turnId: String(row.turn_id),
      scopeId: String(row.scope_id),
      threadId: String(row.thread_id),
      messageId: Number(row.message_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  removeActiveTurnPreview(turnId: string): void {
    this.db.prepare('DELETE FROM active_turn_previews WHERE turn_id = ?').run(turnId);
  }

  removeActiveTurnPreviewByMessage(scopeId: string, messageId: number): void {
    this.db.prepare('DELETE FROM active_turn_previews WHERE scope_id = ? AND message_id = ?').run(scopeId, messageId);
  }

  savePendingUserInput(record: PendingUserInputStoredRecord): void {
    this.db.prepare(`
      INSERT INTO pending_user_inputs (
        local_id, server_request_id, chat_id, thread_id, turn_id, item_id, message_id,
        questions_json, answers_json, current_question_index, awaiting_free_text, status, created_at, submitted_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_id) DO UPDATE SET
        server_request_id = excluded.server_request_id,
        chat_id = excluded.chat_id,
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        item_id = excluded.item_id,
        message_id = excluded.message_id,
        questions_json = excluded.questions_json,
        answers_json = excluded.answers_json,
        current_question_index = excluded.current_question_index,
        awaiting_free_text = excluded.awaiting_free_text,
        status = excluded.status,
        created_at = excluded.created_at,
        submitted_at = excluded.submitted_at,
        resolved_at = excluded.resolved_at
    `).run(
      record.localId,
      record.serverRequestId,
      record.chatId,
      record.threadId,
      record.turnId ?? '',
      record.itemId,
      record.messageId,
      record.questionsJson,
      record.answersJson,
      record.currentQuestionIndex,
      record.awaitingFreeText ? 1 : 0,
      record.status,
      record.createdAt,
      record.submittedAt,
      record.resolvedAt,
    );
  }

  updatePendingUserInputMessage(localId: string, messageId: number): void {
    this.db.prepare('UPDATE pending_user_inputs SET message_id = ? WHERE local_id = ?').run(messageId, localId);
  }

  updatePendingUserInputAnswers(localId: string, answersJson: string, currentQuestionIndex: number, awaitingFreeText = false): void {
    this.db.prepare(`
      UPDATE pending_user_inputs
      SET answers_json = ?, current_question_index = ?, awaiting_free_text = ?
      WHERE local_id = ?
    `).run(answersJson, currentQuestionIndex, awaitingFreeText ? 1 : 0, localId);
  }

  markPendingUserInputSubmitted(localId: string): void {
    this.db.prepare(`
      UPDATE pending_user_inputs
      SET status = 'submitted', submitted_at = ?
      WHERE local_id = ? AND resolved_at IS NULL
    `).run(Date.now(), localId);
  }

  markPendingUserInputResolved(localId: string): void {
    this.db.prepare(`
      UPDATE pending_user_inputs
      SET status = 'resolved', resolved_at = ?
      WHERE local_id = ?
    `).run(Date.now(), localId);
  }

  markPendingUserInputInterrupted(localId: string): void {
    this.db.prepare(`
      UPDATE pending_user_inputs
      SET status = 'interrupted', resolved_at = ?
      WHERE local_id = ?
    `).run(Date.now(), localId);
  }

  listPendingUserInputs(): PendingUserInputStoredRecord[] {
    const rows = this.db.prepare(`
      SELECT local_id, server_request_id, chat_id, thread_id, turn_id, item_id, message_id,
        questions_json, answers_json, current_question_index, awaiting_free_text, status, created_at, submitted_at, resolved_at
      FROM pending_user_inputs
      WHERE resolved_at IS NULL
      ORDER BY created_at ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapPendingUserInput(row));
  }

  countPendingUserInputs(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM pending_user_inputs WHERE resolved_at IS NULL').get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  saveQueuedTurnInput(record: QueuedTurnInputRecord): void {
    this.db.prepare(`
      INSERT INTO queued_turn_inputs (
        queue_id, scope_id, chat_id, chat_type, topic_id, thread_id, input_json, source_summary,
        message_id, status, error, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(queue_id) DO UPDATE SET
        scope_id = excluded.scope_id,
        chat_id = excluded.chat_id,
        chat_type = excluded.chat_type,
        topic_id = excluded.topic_id,
        thread_id = excluded.thread_id,
        input_json = excluded.input_json,
        source_summary = excluded.source_summary,
        message_id = excluded.message_id,
        status = excluded.status,
        error = excluded.error,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at
    `).run(
      record.queueId,
      record.scopeId,
      record.chatId,
      record.chatType,
      record.topicId,
      record.threadId,
      record.inputJson,
      record.sourceSummary,
      record.messageId,
      record.status,
      record.error,
      record.createdAt,
      record.updatedAt,
      record.resolvedAt,
    );
  }

  getQueuedTurnInput(queueId: string): QueuedTurnInputRecord | null {
    const row = this.db.prepare('SELECT * FROM queued_turn_inputs WHERE queue_id = ?').get(queueId) as Record<string, unknown> | undefined;
    return row ? this.mapQueuedTurnInput(row) : null;
  }

  peekQueuedTurnInput(scopeId: string): QueuedTurnInputRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM queued_turn_inputs
      WHERE scope_id = ? AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get(scopeId) as Record<string, unknown> | undefined;
    return row ? this.mapQueuedTurnInput(row) : null;
  }

  listQueuedTurnInputs(scopeId?: string): QueuedTurnInputRecord[] {
    const sql = scopeId
      ? `SELECT * FROM queued_turn_inputs WHERE scope_id = ? AND status IN ('queued', 'processing') ORDER BY created_at ASC`
      : `SELECT * FROM queued_turn_inputs WHERE status IN ('queued', 'processing') ORDER BY created_at ASC`;
    const rows = scopeId
      ? this.db.prepare(sql).all(scopeId) as Array<Record<string, unknown>>
      : this.db.prepare(sql).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapQueuedTurnInput(row));
  }

  countQueuedTurnInputs(scopeId?: string): number {
    const row = scopeId
      ? this.db.prepare(`SELECT COUNT(*) AS count FROM queued_turn_inputs WHERE scope_id = ? AND status IN ('queued', 'processing')`).get(scopeId) as { count: number } | undefined
      : this.db.prepare(`SELECT COUNT(*) AS count FROM queued_turn_inputs WHERE status IN ('queued', 'processing')`).get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  updateQueuedTurnInputStatus(queueId: string, status: QueuedTurnInputStatus, error: string | null = null): void {
    const resolvedAt = status === 'queued' || status === 'processing' ? null : Date.now();
    this.db.prepare(`
      UPDATE queued_turn_inputs
      SET status = ?, error = ?, updated_at = ?, resolved_at = ?
      WHERE queue_id = ?
    `).run(status, error, Date.now(), resolvedAt, queueId);
  }

  cancelQueuedTurnInputs(scopeId: string): number {
    const result = this.db.prepare(`
      UPDATE queued_turn_inputs
      SET status = 'cancelled', updated_at = ?, resolved_at = ?
      WHERE scope_id = ? AND status = 'queued'
    `).run(Date.now(), Date.now(), scopeId);
    return Number(result.changes ?? 0);
  }

  requeueInterruptedQueuedTurnInputs(): number {
    const result = this.db.prepare(`
      UPDATE queued_turn_inputs
      SET status = 'queued', error = NULL, updated_at = ?, resolved_at = NULL
      WHERE status = 'processing'
    `).run(Date.now());
    return Number(result.changes ?? 0);
  }

  savePendingAttachmentBatch(record: PendingAttachmentBatchRecord): void {
    this.db.prepare(`
      INSERT INTO pending_attachment_batches (
        batch_id, scope_id, chat_id, chat_type, topic_id, thread_id, cwd, media_group_id,
        attachments_json, caption, message_id, status, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        scope_id = excluded.scope_id,
        chat_id = excluded.chat_id,
        chat_type = excluded.chat_type,
        topic_id = excluded.topic_id,
        thread_id = excluded.thread_id,
        cwd = excluded.cwd,
        media_group_id = excluded.media_group_id,
        attachments_json = excluded.attachments_json,
        caption = excluded.caption,
        message_id = excluded.message_id,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at
    `).run(
      record.batchId,
      record.scopeId,
      record.chatId,
      record.chatType,
      record.topicId,
      record.threadId,
      record.cwd,
      record.mediaGroupId,
      record.attachmentsJson,
      record.caption,
      record.messageId,
      record.status,
      record.createdAt,
      record.updatedAt,
      record.resolvedAt,
    );
  }

  getPendingAttachmentBatch(batchId: string): PendingAttachmentBatchRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_attachment_batches WHERE batch_id = ?').get(batchId) as Record<string, unknown> | undefined;
    return row ? this.mapPendingAttachmentBatch(row) : null;
  }

  findPendingAttachmentBatchByMediaGroup(scopeId: string, mediaGroupId: string): PendingAttachmentBatchRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM pending_attachment_batches
      WHERE scope_id = ? AND media_group_id = ? AND status = 'pending'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(scopeId, mediaGroupId) as Record<string, unknown> | undefined;
    return row ? this.mapPendingAttachmentBatch(row) : null;
  }

  getLatestPendingAttachmentBatch(scopeId: string): PendingAttachmentBatchRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM pending_attachment_batches
      WHERE scope_id = ? AND status = 'pending'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(scopeId) as Record<string, unknown> | undefined;
    return row ? this.mapPendingAttachmentBatch(row) : null;
  }

  updatePendingAttachmentBatchMessage(batchId: string, messageId: number): void {
    this.db.prepare('UPDATE pending_attachment_batches SET message_id = ?, updated_at = ? WHERE batch_id = ?').run(messageId, Date.now(), batchId);
  }

  resolvePendingAttachmentBatch(batchId: string, status: PendingAttachmentBatchStatus): void {
    this.db.prepare(`
      UPDATE pending_attachment_batches
      SET status = ?, updated_at = ?, resolved_at = ?
      WHERE batch_id = ?
    `).run(status, Date.now(), Date.now(), batchId);
  }

  clearPendingAttachmentBatches(scopeId: string): number {
    const result = this.db.prepare(`
      UPDATE pending_attachment_batches
      SET status = 'cleared', updated_at = ?, resolved_at = ?
      WHERE scope_id = ? AND status = 'pending'
    `).run(Date.now(), Date.now(), scopeId);
    return Number(result.changes ?? 0);
  }

  saveGuidedPlanSession(record: GuidedPlanSessionRecord): void {
    this.db.prepare(`
      INSERT INTO guided_plan_sessions (
        session_id, scope_id, chat_id, chat_type, topic_id, thread_id, turn_id, cwd,
        plan_markdown, message_id, state, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        scope_id = excluded.scope_id,
        chat_id = excluded.chat_id,
        chat_type = excluded.chat_type,
        topic_id = excluded.topic_id,
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        cwd = excluded.cwd,
        plan_markdown = excluded.plan_markdown,
        message_id = excluded.message_id,
        state = excluded.state,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at
    `).run(
      record.sessionId,
      record.scopeId,
      record.chatId,
      record.chatType,
      record.topicId,
      record.threadId,
      record.turnId,
      record.cwd,
      record.planMarkdown,
      record.messageId,
      record.state,
      record.createdAt,
      record.updatedAt,
      record.resolvedAt,
    );
  }

  getGuidedPlanSession(sessionId: string): GuidedPlanSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM guided_plan_sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapGuidedPlanSession(row) : null;
  }

  findOpenGuidedPlanSession(scopeId: string, turnId?: string): GuidedPlanSessionRecord | null {
    const row = turnId
      ? this.db.prepare(`
          SELECT * FROM guided_plan_sessions
          WHERE scope_id = ? AND turn_id = ? AND state = 'awaiting_confirmation'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(scopeId, turnId) as Record<string, unknown> | undefined
      : this.db.prepare(`
          SELECT * FROM guided_plan_sessions
          WHERE scope_id = ? AND state = 'awaiting_confirmation'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(scopeId) as Record<string, unknown> | undefined;
    return row ? this.mapGuidedPlanSession(row) : null;
  }

  listOpenGuidedPlanSessions(): GuidedPlanSessionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM guided_plan_sessions
      WHERE state = 'awaiting_confirmation'
      ORDER BY updated_at ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapGuidedPlanSession(row));
  }

  updateGuidedPlanSessionMessage(sessionId: string, messageId: number): void {
    this.db.prepare('UPDATE guided_plan_sessions SET message_id = ?, updated_at = ? WHERE session_id = ?').run(messageId, Date.now(), sessionId);
  }

  updateGuidedPlanSessionState(sessionId: string, state: GuidedPlanSessionState): void {
    const resolvedAt = state === 'awaiting_confirmation' || state === 'executing' ? null : Date.now();
    this.db.prepare(`
      UPDATE guided_plan_sessions
      SET state = ?, updated_at = ?, resolved_at = ?
      WHERE session_id = ?
    `).run(state, Date.now(), resolvedAt, sessionId);
  }

  insertAudit(direction: 'inbound' | 'outbound', chatId: string, eventType: string, summary: string): void {
    this.db.prepare('INSERT INTO audit_logs (direction, chat_id, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(direction, chatId, eventType, summary, Date.now());
  }

  close(): void {
    this.db.close();
  }

  private mapApproval(row: Record<string, unknown>): PendingApprovalRecord {
    return {
      localId: String(row.local_id),
      serverRequestId: String(row.server_request_id),
      kind: row.kind === 'fileChange' ? 'fileChange' : row.kind === 'permissions' ? 'permissions' : 'command',
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      itemId: String(row.item_id),
      approvalId: row.approval_id === null ? null : String(row.approval_id),
      reason: row.reason === null ? null : String(row.reason),
      command: row.command === null ? null : String(row.command),
      cwd: row.cwd === null ? null : String(row.cwd),
      payloadJson: row.payload_json === null ? null : String(row.payload_json),
      messageId: row.message_id === null ? null : Number(row.message_id),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at)
    };
  }

  private mapPendingUserInput(row: Record<string, unknown>): PendingUserInputStoredRecord {
    return {
      localId: String(row.local_id),
      serverRequestId: String(row.server_request_id),
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      turnId: row.turn_id === null || String(row.turn_id) === '' ? null : String(row.turn_id),
      itemId: String(row.item_id),
      messageId: row.message_id === null ? null : Number(row.message_id),
      questionsJson: String(row.questions_json),
      answersJson: String(row.answers_json),
      currentQuestionIndex: Number(row.current_question_index),
      awaitingFreeText: Boolean(row.awaiting_free_text),
      status: row.status === null ? 'pending' : String(row.status),
      createdAt: Number(row.created_at),
      submittedAt: row.submitted_at === null ? null : Number(row.submitted_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  private mapQueuedTurnInput(row: Record<string, unknown>): QueuedTurnInputRecord {
    return {
      queueId: String(row.queue_id),
      scopeId: String(row.scope_id),
      chatId: String(row.chat_id),
      chatType: String(row.chat_type),
      topicId: row.topic_id === null ? null : Number(row.topic_id),
      threadId: String(row.thread_id),
      inputJson: String(row.input_json),
      sourceSummary: String(row.source_summary),
      messageId: row.message_id === null ? null : Number(row.message_id),
      status: normalizeQueuedTurnInputStatus(row.status),
      error: row.error === null ? null : String(row.error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  private mapPendingAttachmentBatch(row: Record<string, unknown>): PendingAttachmentBatchRecord {
    return {
      batchId: String(row.batch_id),
      scopeId: String(row.scope_id),
      chatId: String(row.chat_id),
      chatType: String(row.chat_type),
      topicId: row.topic_id === null ? null : Number(row.topic_id),
      threadId: String(row.thread_id),
      cwd: row.cwd === null ? null : String(row.cwd),
      mediaGroupId: row.media_group_id === null ? null : String(row.media_group_id),
      attachmentsJson: String(row.attachments_json),
      caption: String(row.caption ?? ''),
      messageId: row.message_id === null ? null : Number(row.message_id),
      status: normalizePendingAttachmentBatchStatus(row.status),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  private mapGuidedPlanSession(row: Record<string, unknown>): GuidedPlanSessionRecord {
    return {
      sessionId: String(row.session_id),
      scopeId: String(row.scope_id),
      chatId: String(row.chat_id),
      chatType: String(row.chat_type),
      topicId: row.topic_id === null ? null : Number(row.topic_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      cwd: row.cwd === null ? null : String(row.cwd),
      planMarkdown: String(row.plan_markdown),
      messageId: row.message_id === null ? null : Number(row.message_id),
      state: normalizeGuidedPlanSessionState(row.state),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  private writeChatSettings(
    chatId: string,
    model: string | null,
    reasoningEffort: ReasoningEffortValue | null,
    locale: AppLocale | null,
    accessPreset: AccessPresetValue | null,
    collaborationMode: CollaborationModeValue | null,
    serviceTier: string | null,
    activeTurnMessageMode: ActiveTurnMessageMode | null,
  ): void {
    this.db.prepare(`
      INSERT INTO chat_settings (chat_id, model, reasoning_effort, locale, access_preset, collaboration_mode, service_tier, active_turn_message_mode, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        locale = excluded.locale,
        access_preset = excluded.access_preset,
        collaboration_mode = excluded.collaboration_mode,
        service_tier = excluded.service_tier,
        active_turn_message_mode = excluded.active_turn_message_mode,
        updated_at = excluded.updated_at
    `).run(chatId, model, reasoningEffort, locale, accessPreset, collaborationMode, serviceTier, activeTurnMessageMode, Date.now());
  }

  getWeixinContextToken(scopeId: string): string | null {
    const row = this.db.prepare('SELECT context_token FROM weixin_context_tokens WHERE scope_id = ?').get(scopeId) as
      | { context_token: string }
      | undefined;
    return row ? String(row.context_token) : null;
  }

  setWeixinContextToken(scopeId: string, contextToken: string): void {
    this.db.prepare(`
      INSERT INTO weixin_context_tokens (scope_id, context_token, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(scope_id) DO UPDATE SET context_token = excluded.context_token, updated_at = excluded.updated_at
    `).run(scopeId, contextToken, Date.now());
  }

  listDisabledCodexAuthCandidateNames(runtimeId = 'default'): Set<string> {
    if (runtimeId !== 'default') {
      const runtimeRows = this.db.prepare(
        'SELECT name FROM codex_auth_candidate_runtime WHERE runtime_id = ? AND disabled = 1',
      ).all(runtimeId) as Array<{ name: string }>;
      return new Set(runtimeRows.map(row => String(row.name)));
    }
    const rows = this.db.prepare('SELECT name FROM codex_auth_candidates WHERE disabled = 1').all() as Array<{ name: string }>;
    return new Set(rows.map(row => String(row.name)));
  }

  setCodexAuthCandidateDisabled(name: string, disabled: boolean, runtimeId = 'default'): void {
    if (runtimeId !== 'default') {
      this.db.prepare(`
        INSERT INTO codex_auth_candidate_runtime (runtime_id, name, disabled, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(runtime_id, name) DO UPDATE SET disabled = excluded.disabled, updated_at = excluded.updated_at
      `).run(runtimeId, name, disabled ? 1 : 0, Date.now());
      return;
    }
    this.db.prepare(`
      INSERT INTO codex_auth_candidates (name, disabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET disabled = excluded.disabled, updated_at = excluded.updated_at
    `).run(name, disabled ? 1 : 0, Date.now());
  }

  setCodexAuthQuotaSnapshot(
    runtimeId: string,
    candidateName: string,
    accountId: string,
    snapshot: Pick<
      CodexAuthQuotaSnapshotRecord,
      | 'capturedAtMs'
      | 'planType'
      | 'primaryWindowDurationMins'
      | 'primaryRemainingPercent'
      | 'secondaryWindowDurationMins'
      | 'secondaryRemainingPercent'
    >,
  ): void {
    this.db.prepare(`
      INSERT INTO codex_auth_quota_snapshots (
        runtime_id,
        candidate_name,
        account_id,
        captured_at_ms,
        plan_type,
        primary_window_duration_mins,
        primary_remaining_percent,
        secondary_window_duration_mins,
        secondary_remaining_percent,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(runtime_id, candidate_name) DO UPDATE SET
        account_id = excluded.account_id,
        captured_at_ms = excluded.captured_at_ms,
        plan_type = excluded.plan_type,
        primary_window_duration_mins = excluded.primary_window_duration_mins,
        primary_remaining_percent = excluded.primary_remaining_percent,
        secondary_window_duration_mins = excluded.secondary_window_duration_mins,
        secondary_remaining_percent = excluded.secondary_remaining_percent,
        updated_at = excluded.updated_at
    `).run(
      runtimeId,
      candidateName,
      accountId,
      snapshot.capturedAtMs,
      snapshot.planType,
      snapshot.primaryWindowDurationMins,
      snapshot.primaryRemainingPercent,
      snapshot.secondaryWindowDurationMins,
      snapshot.secondaryRemainingPercent,
      Date.now(),
    );
  }

  listCodexAuthQuotaSnapshots(accountIds: string[]): CodexAuthQuotaSnapshotRecord[] {
    const uniqueAccountIds = [...new Set(accountIds.filter(Boolean))];
    if (uniqueAccountIds.length === 0) {
      return [];
    }
    const placeholders = uniqueAccountIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT
        runtime_id,
        candidate_name,
        account_id,
        captured_at_ms,
        plan_type,
        primary_window_duration_mins,
        primary_remaining_percent,
        secondary_window_duration_mins,
        secondary_remaining_percent,
        updated_at
      FROM codex_auth_quota_snapshots
      WHERE account_id IN (${placeholders})
    `).all(...uniqueAccountIds) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      runtimeId: String(row.runtime_id),
      candidateName: String(row.candidate_name),
      accountId: String(row.account_id),
      capturedAtMs: Number(row.captured_at_ms),
      planType: nullableString(row.plan_type),
      primaryWindowDurationMins: nullableNumber(row.primary_window_duration_mins),
      primaryRemainingPercent: nullableNumber(row.primary_remaining_percent),
      secondaryWindowDurationMins: nullableNumber(row.secondary_window_duration_mins),
      secondaryRemainingPercent: nullableNumber(row.secondary_remaining_percent),
      updatedAt: Number(row.updated_at),
    }));
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some(entry => entry.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeCollaborationMode(value: unknown): CollaborationModeValue | null {
  return value === 'default' || value === 'plan' ? value : null;
}

function normalizeActiveTurnMessageMode(value: unknown): ActiveTurnMessageMode | null {
  return value === 'steer' || value === 'queue' ? value : null;
}

function normalizeQueuedTurnInputStatus(value: unknown): QueuedTurnInputStatus {
  return value === 'processing' || value === 'completed' || value === 'cancelled' || value === 'failed'
    ? value
    : 'queued';
}

function normalizePendingAttachmentBatchStatus(value: unknown): PendingAttachmentBatchStatus {
  return value === 'consumed' || value === 'cleared' ? value : 'pending';
}

function normalizeGuidedPlanSessionState(value: unknown): GuidedPlanSessionState {
  return value === 'executing' || value === 'cancelled' || value === 'completed'
    ? value
    : 'awaiting_confirmation';
}
