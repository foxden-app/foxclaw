import type { DatabaseSync } from 'node:sqlite';
import type { ChannelInbound } from '../core/channel_events.js';

export interface InboxEntry { id: string; inbound: ChannelInbound; }
/** Durable intake precedes business classification and acknowledgement to the transport. */
export class ChannelInbox {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS channel_inbox (
      receipt_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, payload TEXT,
      completed_at INTEGER, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_inbox_pending ON channel_inbox(completed_at, created_at);`);
    db.prepare('DELETE FROM channel_inbox WHERE completed_at < ?').run(Date.now() - 90 * 86400_000);
  }
  accept(id: string, inbound: ChannelInbound): boolean {
    this.db.prepare('INSERT OR IGNORE INTO channel_inbox VALUES (?, ?, ?, NULL, ?)').run(id, inbound.event.scopeId, JSON.stringify(inbound), Date.now());
    return this.db.prepare('SELECT completed_at FROM channel_inbox WHERE receipt_id = ?').get(id)?.completed_at === null;
  }
  complete(id: string): void { this.db.prepare('UPDATE channel_inbox SET payload = NULL, completed_at = ? WHERE receipt_id = ?').run(Date.now(), id); }
  pending(): InboxEntry[] {
    return this.db.prepare('SELECT receipt_id, payload FROM channel_inbox WHERE completed_at IS NULL ORDER BY created_at, receipt_id').all()
      .map(row => ({ id: String(row.receipt_id), inbound: JSON.parse(String(row.payload)) as ChannelInbound }));
  }
}
