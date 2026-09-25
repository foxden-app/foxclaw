import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { AppLocale } from '../types.js';

export interface AntigravityConversation {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: string;
  updatedAt: number;
  workspaceUris: string[];
  workspaceDir: string | null;
  status: string;
  killed: boolean;
}

export function parseWorkspaceDir(urisJson: string | null | undefined): string | null {
  if (!urisJson) return null;
  try {
    const list = JSON.parse(urisJson);
    if (Array.isArray(list) && list.length > 0 && typeof list[0] === 'string') {
      const uri = list[0];
      if (uri.startsWith('file://')) {
        return uri.replace(/^file:\/\//, '');
      }
      return uri;
    }
  } catch {
    // If it's a plain string
    if (typeof urisJson === 'string' && urisJson.startsWith('/')) {
      return urisJson;
    }
  }
  return null;
}

export function formatAge(timestamp: number, locale: AppLocale = 'zh'): string {
  if (!timestamp) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return locale === 'zh' ? `${seconds} 秒前` : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return locale === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return locale === 'zh' ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return locale === 'zh' ? `${days} 天前` : `${days}d ago`;
}

export class AntigravityConversationManager {
  readonly dbPath: string;
  private readonly logger: Logger | undefined;

  constructor(appDataDir?: string, logger?: Logger) {
    const baseDir = appDataDir || path.join(os.homedir(), '.gemini', 'antigravity-cli');
    this.dbPath = path.join(baseDir, 'conversation_summaries.db');
    this.logger = logger;
  }

  listConversations(limit = 15, search?: string): AntigravityConversation[] {
    try {
      if (!fs.existsSync(this.dbPath)) {
        return [];
      }
      const db = new DatabaseSync(this.dbPath, { readOnly: true });
      let rows: Record<string, unknown>[] = [];
      try {
        db.exec('PRAGMA busy_timeout = 3000;');
        let query = `
          SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, killed
          FROM conversation_summaries
          WHERE killed = 0
        `;
        const params: any[] = [];
        if (search && search.trim()) {
          query += ` AND (title LIKE ? OR preview LIKE ? OR workspace_uris LIKE ?)`;
          const term = `%${search.trim()}%`;
          params.push(term, term, term);
        }
        query += ` ORDER BY last_modified_time DESC LIMIT ?`;
        params.push(limit);

        rows = db.prepare(query).all(...params) as Record<string, unknown>[];
      } finally {
        db.close();
      }

      return rows.map((r) => {
        const id = String(r.conversation_id);
        const title = String(r.title || r.preview || 'Untitled');
        const preview = String(r.preview || '');
        const stepCount = Number(r.step_count || 0);
        const lastModifiedTime = String(r.last_modified_time || '');
        const timeMs = lastModifiedTime ? new Date(lastModifiedTime).getTime() : 0;
        const workspaceDir = parseWorkspaceDir(r.workspace_uris as string | undefined);
        return {
          conversationId: id,
          title,
          preview,
          stepCount,
          lastModifiedTime,
          updatedAt: Number.isNaN(timeMs) ? 0 : timeMs,
          workspaceUris: r.workspace_uris ? [String(r.workspace_uris)] : [],
          workspaceDir,
          status: String(r.status || ''),
          killed: Boolean(r.killed),
        };
      });
    } catch (err) {
      this.logger?.warn('antigravity.conversations.list_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  renameConversation(conversationId: string, newTitle: string): boolean {
    try {
      if (!fs.existsSync(this.dbPath)) return false;
      const db = new DatabaseSync(this.dbPath);
      try {
        db.exec('PRAGMA busy_timeout = 3000;');
        db.prepare('UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?').run(newTitle, conversationId);
        return true;
      } finally {
        db.close();
      }
    } catch (err) {
      this.logger?.warn('antigravity.conversations.rename_error', { error: String(err) });
      return false;
    }
  }

  archiveConversation(conversationId: string): boolean {
    try {
      if (!fs.existsSync(this.dbPath)) return false;
      const db = new DatabaseSync(this.dbPath);
      try {
        db.exec('PRAGMA busy_timeout = 3000;');
        db.prepare('UPDATE conversation_summaries SET killed = 1 WHERE conversation_id = ?').run(conversationId);
        return true;
      } finally {
        db.close();
      }
    } catch (err) {
      this.logger?.warn('antigravity.conversations.archive_error', { error: String(err) });
      return false;
    }
  }

  getConversation(conversationId: string): AntigravityConversation | null {
    try {
      if (!fs.existsSync(this.dbPath)) return null;
      const db = new DatabaseSync(this.dbPath, { readOnly: true });
      let row: Record<string, unknown> | undefined;
      try {
        db.exec('PRAGMA busy_timeout = 3000;');
        row = db.prepare(`
          SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, killed
          FROM conversation_summaries
          WHERE conversation_id = ?
        `).get(conversationId) as Record<string, unknown> | undefined;
      } finally {
        db.close();
      }

      if (!row) return null;
      const timeMs = row.last_modified_time ? new Date(String(row.last_modified_time)).getTime() : 0;
      return {
        conversationId: String(row.conversation_id),
        title: String(row.title || row.preview || 'Untitled'),
        preview: String(row.preview || ''),
        stepCount: Number(row.step_count || 0),
        lastModifiedTime: String(row.last_modified_time || ''),
        updatedAt: Number.isNaN(timeMs) ? 0 : timeMs,
        workspaceUris: row.workspace_uris ? [String(row.workspace_uris)] : [],
        workspaceDir: parseWorkspaceDir(row.workspace_uris as string | undefined),
        status: String(row.status || ''),
        killed: Boolean(row.killed),
      };
    } catch (err) {
      this.logger?.warn('antigravity.conversations.get_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  resolveConversation(
    raw: string,
    scopeId: string,
    store: BridgeStore,
  ): AntigravityConversation | null {
    const value = raw.trim();
    if (!value) return null;

    // 1. Check numeric index in store cache
    if (/^\d+$/.test(value)) {
      const index = Number.parseInt(value, 10);
      if (index > 0) {
        const cached = store.getCachedThread(scopeId, index);
        if (cached) {
          const direct = this.getConversation(cached.threadId);
          if (direct) return direct;
          return {
            conversationId: cached.threadId,
            title: cached.name || cached.preview || cached.threadId.slice(0, 8),
            preview: cached.preview,
            stepCount: 0,
            lastModifiedTime: new Date(cached.updatedAt).toISOString(),
            updatedAt: cached.updatedAt,
            workspaceUris: cached.cwd ? [cached.cwd] : [],
            workspaceDir: cached.cwd,
            status: 'idle',
            killed: false,
          };
        }
      }
    }

    // 2. Check store cached threads by exact ID or prefix
    const cachedList = store.listCachedThreads(scopeId);
    const cachedMatch = cachedList.find((c) => c.threadId === value || c.threadId.startsWith(value));
    if (cachedMatch) {
      const direct = this.getConversation(cachedMatch.threadId);
      if (direct) return direct;
      return {
        conversationId: cachedMatch.threadId,
        title: cachedMatch.name || cachedMatch.preview || cachedMatch.threadId.slice(0, 8),
        preview: cachedMatch.preview,
        stepCount: 0,
        lastModifiedTime: new Date(cachedMatch.updatedAt).toISOString(),
        updatedAt: cachedMatch.updatedAt,
        workspaceUris: cachedMatch.cwd ? [cachedMatch.cwd] : [],
        workspaceDir: cachedMatch.cwd,
        status: 'idle',
        killed: false,
      };
    }

    // 3. Direct exact or prefix lookup in SQLite
    const direct = this.getConversation(value);
    if (direct) return direct;

    const list = this.listConversations(50);
    const matches = list.filter(
      (c) => c.conversationId === value || c.conversationId.startsWith(value),
    );
    if (matches.length === 1) {
      return matches[0]!;
    }

    // 4. Fallback to on-disk brain directory & transcript.jsonl
    if (this.hasTranscript(value)) {
      return {
        conversationId: value,
        title: value.slice(0, 8),
        preview: '',
        stepCount: 0,
        lastModifiedTime: new Date().toISOString(),
        updatedAt: Date.now(),
        workspaceUris: [],
        workspaceDir: null,
        status: 'idle',
        killed: false,
      };
    }

    const brainDir = path.join(path.dirname(this.dbPath), 'brain');
    if (fs.existsSync(brainDir)) {
      try {
        const entries = fs.readdirSync(brainDir);
        const brainMatches = entries.filter((e) => e === value || e.startsWith(value));
        if (brainMatches.length === 1) {
          const matchedId = brainMatches[0]!;
          return {
            conversationId: matchedId,
            title: matchedId.slice(0, 8),
            preview: '',
            stepCount: 0,
            lastModifiedTime: new Date().toISOString(),
            updatedAt: Date.now(),
            workspaceUris: [],
            workspaceDir: null,
            status: 'idle',
            killed: false,
          };
        }
      } catch {}
    }

    return null;
  }

  getTranscriptPath(conversationId: string): string {
    const baseDir = path.dirname(this.dbPath);
    return path.join(baseDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  hasTranscript(conversationId: string): boolean {
    return fs.existsSync(this.getTranscriptPath(conversationId));
  }
}
