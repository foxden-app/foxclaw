import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  AntigravityConversationManager,
  parseWorkspaceDir,
  formatAge,
} from './conversations.js';
import { BridgeStore } from '../store/database.js';

test('parseWorkspaceDir extracts local directory from uris json', () => {
  assert.equal(parseWorkspaceDir('["file:///home/wuya/git/foxclaw"]'), '/home/wuya/git/foxclaw');
  assert.equal(parseWorkspaceDir('["/home/wuya/git/foxclaw"]'), '/home/wuya/git/foxclaw');
  assert.equal(parseWorkspaceDir(''), null);
  assert.equal(parseWorkspaceDir(null), null);
  assert.equal(parseWorkspaceDir('invalid json'), null);
});

test('formatAge returns localized relative age', () => {
  const now = Date.now();
  assert.equal(formatAge(now - 10_000, 'zh'), '10 秒前');
  assert.equal(formatAge(now - 10_000, 'en'), '10s ago');
  assert.equal(formatAge(now - 120_000, 'zh'), '2 分钟前');
  assert.equal(formatAge(now - 7200_000, 'zh'), '2 小时前');
  assert.equal(formatAge(now - 86400_000 * 3, 'zh'), '3 天前');
  assert.equal(formatAge(0, 'zh'), '—');
});

test('AntigravityConversationManager queries and resolves conversations', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-conv-test-'));
  const dbPath = path.join(tempDir, 'conversation_summaries.db');
  const storePath = path.join(tempDir, 'bridge.sqlite');

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      preview TEXT NOT NULL,
      step_count INTEGER NOT NULL,
      last_modified_time datetime NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL,
      killed numeric NOT NULL
    );
    INSERT INTO conversation_summaries VALUES (
      'conv-1111-2222',
      'Test Foxclaw Antigravity Conversation',
      'Preview text 1',
      42,
      '2026-09-24 10:00:00+00:00',
      '["file:///home/wuya/git/foxclaw"]',
      'CASCADE_RUN_STATUS_IDLE',
      0
    );
    INSERT INTO conversation_summaries VALUES (
      'conv-3333-4444',
      'Killed Conversation',
      'Preview text 2',
      5,
      '2026-09-24 09:00:00+00:00',
      '["file:///home/wuya/git/other"]',
      'CASCADE_RUN_STATUS_IDLE',
      1
    );
  `);
  db.close();

  const manager = new AntigravityConversationManager(tempDir);
  const list = manager.listConversations(10);

  assert.equal(list.length, 1);
  assert.equal(list[0]?.conversationId, 'conv-1111-2222');
  assert.equal(list[0]?.title, 'Test Foxclaw Antigravity Conversation');
  assert.equal(list[0]?.workspaceDir, '/home/wuya/git/foxclaw');

  const direct = manager.getConversation('conv-1111-2222');
  assert.equal(direct?.conversationId, 'conv-1111-2222');

  const store = new BridgeStore(storePath);
  const scopeId = 'telegram:bot123:456::root';
  store.cacheThreadList(scopeId, [
    {
      listIndex: 1,
      threadId: 'conv-1111-2222',
      name: 'Test Foxclaw Antigravity Conversation',
      preview: 'Preview text 1',
      cwd: '/home/wuya/git/foxclaw',
      modelProvider: 'antigravity',
      status: 'idle',
      updatedAt: Date.now(),
    },
  ]);

  // Resolve by numeric index
  const resolvedByIndex = manager.resolveConversation('1', scopeId, store);
  assert.equal(resolvedByIndex?.conversationId, 'conv-1111-2222');

  // Resolve by prefix
  const resolvedByPrefix = manager.resolveConversation('conv-1111', scopeId, store);
  assert.equal(resolvedByPrefix?.conversationId, 'conv-1111-2222');

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
});
