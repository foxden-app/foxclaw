import type { DatabaseSync } from 'node:sqlite';
import type { ChannelTextEvent } from '../core/channel_events.js';
import type { EngineTurnRequest, EngineTurnResult } from '../core/engine_spi.js';

export type TaskState = 'accepted' | 'queued' | 'running' | 'awaiting_confirmation' | 'delivery_pending' | 'completed' | 'failed' | 'cancelled';
export interface JournalTask {
  id: string;
  backendId: string;
  state: TaskState;
  event: ChannelTextEvent;
  sourcePrompt: string;
  request: EngineTurnRequest;
  queueId: string | null;
  previewMessageId: number;
  result: EngineTurnResult | null;
  commentary?: Array<{ messageId: number; text: string; folded: boolean }>;
  separateFinal?: boolean;
  finalPreviewText?: string;
  previewSettled?: boolean;
  delivery: string[];
  deliveredChunks: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const transitions: Record<TaskState, readonly TaskState[]> = {
  accepted: ['queued', 'running', 'awaiting_confirmation', 'failed', 'cancelled'],
  queued: ['running', 'failed', 'cancelled'],
  running: ['running', 'awaiting_confirmation', 'delivery_pending', 'failed', 'cancelled'],
  awaiting_confirmation: ['accepted', 'running', 'cancelled'],
  delivery_pending: ['delivery_pending', 'completed', 'failed', 'cancelled'],
  completed: [], failed: [], cancelled: [],
};
const unfinished = ['accepted', 'queued', 'running', 'awaiting_confirmation', 'delivery_pending'];

/** Original inputs, native outcome and delivery progress are distinct durable facts. */
export class TaskJournal {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS engine_task_journal (
      task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, backend_id TEXT NOT NULL,
      state TEXT NOT NULL, queue_id TEXT, record_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS engine_task_journal_scope_state ON engine_task_journal(scope_id, state, created_at);
      CREATE INDEX IF NOT EXISTS engine_task_journal_receipt ON engine_task_journal(scope_id, json_extract(record_json, '$.event.messageId'));`);
  }

  atomic<T>(operation: () => T): T {
    this.db.exec('SAVEPOINT task_journal_change');
    try { const result = operation(); this.db.exec('RELEASE task_journal_change'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO task_journal_change; RELEASE task_journal_change'); throw error; }
  }

  insert(task: JournalTask): void {
    this.db.prepare(`INSERT INTO engine_task_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      task.id, task.event.scopeId, task.backendId, task.state, task.queueId, JSON.stringify(task), task.createdAt, task.updatedAt);
  }

  get(id: string): JournalTask | null {
    const row = this.db.prepare('SELECT record_json FROM engine_task_journal WHERE task_id = ?').get(id);
    return row ? JSON.parse(String(row.record_json)) as JournalTask : null;
  }

  listUnfinished(scopeId?: string): JournalTask[] {
    const placeholders = unfinished.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT record_json FROM engine_task_journal WHERE state IN (${placeholders})${scopeId ? ' AND scope_id = ?' : ''} ORDER BY created_at, task_id`).all(...unfinished, ...(scopeId ? [scopeId] : []));
    return rows.map(row => JSON.parse(String(row.record_json)) as JournalTask);
  }

  findReceipt(event: ChannelTextEvent, prompt: string): JournalTask | null {
    if (event.messageId <= 0 || event.userId === 'system') return null;
    const row = this.db.prepare(`SELECT record_json FROM engine_task_journal WHERE scope_id = ?
      AND json_extract(record_json, '$.event.messageId') = ? AND json_extract(record_json, '$.event.chatId') = ?
      AND json_extract(record_json, '$.sourcePrompt') = ? LIMIT 1`).get(event.scopeId, event.messageId, event.chatId, prompt);
    return row ? JSON.parse(String(row.record_json)) as JournalTask : null;
  }

  forQueue(queueId: string): JournalTask | null {
    const row = this.db.prepare('SELECT record_json FROM engine_task_journal WHERE queue_id = ?').get(queueId);
    return row ? JSON.parse(String(row.record_json)) as JournalTask : null;
  }

  update(id: string, state: TaskState, patch: Partial<Omit<JournalTask, 'id' | 'backendId' | 'createdAt' | 'state'>> = {}): JournalTask {
    const previous = this.get(id);
    if (!previous) throw new Error(`Unknown task: ${id}`);
    if (previous.state !== state && !transitions[previous.state].includes(state)) throw new Error(`Invalid task transition: ${previous.state} -> ${state}`);
    if (['completed', 'failed', 'cancelled'].includes(previous.state)) throw new Error(`Task already resolved: ${id}`);
    const next = { ...previous, ...patch, state, updatedAt: Date.now() };
    this.db.prepare(`UPDATE engine_task_journal SET state = ?, queue_id = ?, record_json = ?, updated_at = ? WHERE task_id = ? AND state = ?`).run(
      state, next.queueId, JSON.stringify(next), next.updatedAt, id, previous.state);
    return next;
  }
}
