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
  PendingApprovalRecord,
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

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some(entry => entry.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function normalizeCollaborationMode(value: unknown): CollaborationModeValue | null {
  return value === 'default' || value === 'plan' ? value : null;
}

function normalizeActiveTurnMessageMode(value: unknown): ActiveTurnMessageMode | null {
  return value === 'steer' || value === 'queue' ? value : null;
}
