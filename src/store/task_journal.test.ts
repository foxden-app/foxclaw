import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BridgeStore } from './database.js';
import type { JournalTask } from './task_journal.js';

test('journal and queue changes roll back together, and known outcome survives database reopening', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-journal-'));
  const filename = path.join(root, 'bridge.db');
  let store = new BridgeStore(filename);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const task: JournalTask = { id: 'task', backendId: 'dsh', state: 'accepted',
    event: { scopeId: 'a', chatId: '1', topicId: null, chatType: 'private', userId: '42', messageId: 7, text: 'input', attachments: [], entities: [], replyToBot: false },
    sourcePrompt: 'input', request: { scopeId: 'a', cwd: root, threadId: null, model: 'original-model', effort: 'native-budget', accessPreset: 'read-only', prompt: 'input', locale: 'en' },
    queueId: null, previewMessageId: 0, result: null, delivery: [], deliveredChunks: 0, error: null, createdAt: Date.now(), updatedAt: Date.now() };
  store.taskJournal.insert(task);
  assert.throws(() => store.taskJournal.atomic(() => {
    store.saveQueuedTurnInput({ queueId: 'q', scopeId: 'a', chatId: '1', topicId: null, chatType: 'private', threadId: '', inputJson: '[]', sourceSummary: 'input', messageId: 7, status: 'queued', error: null, createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: null });
    store.taskJournal.update(task.id, 'queued', { queueId: 'q' });
    throw new Error('injected interrupted write');
  }), /interrupted write/);
  assert.equal(store.getQueuedTurnInput('q'), null);
  assert.equal(store.taskJournal.get(task.id)?.state, 'accepted');
  store.taskJournal.update(task.id, 'running');
  store.taskJournal.update(task.id, 'delivery_pending', { result: { kind: 'result', status: 'SUCCESS', response: 'saved answer', conversationId: 'native-session' }, delivery: ['first', 'second'], deliveredChunks: 1 });
  store.close(); store = new BridgeStore(filename);
  const restored = store.taskJournal.findReceipt(task.event, 'input')!;
  assert.equal(restored.request.model, 'original-model');
  assert.equal(restored.request.accessPreset, 'read-only');
  assert.equal(restored.result?.conversationId, 'native-session');
  assert.equal(restored.deliveredChunks, 1);
  assert.deepEqual(restored.delivery, ['first', 'second']);
  store.taskJournal.update(task.id, 'completed');
  assert.throws(() => store.taskJournal.update(task.id, 'running'), /Invalid task transition/);
  assert.equal(store.taskJournal.listUnfinished().length, 0);
});
