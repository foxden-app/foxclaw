import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BridgeStore } from './database.js';

const S1 = 'telegram:chat-1';
const S2 = 'telegram:chat-2';
const S3 = 'telegram:chat-3';
const S4 = 'telegram:chat-4::root';

function withStore(run: (store: BridgeStore) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-store-'));
  const dbPath = path.join(tmpDir, 'bridge.sqlite');
  const store = new BridgeStore(dbPath);
  try {
    run(store);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('BridgeStore persists Weixin context tokens per scope', () => {
  withStore((store) => {
    const scope = 'weixin:bot-1:user-9';
    assert.equal(store.getWeixinContextToken(scope), null);
    store.setWeixinContextToken(scope, 'tok-abc');
    assert.equal(store.getWeixinContextToken(scope), 'tok-abc');
    store.setWeixinContextToken(scope, 'tok-next');
    assert.equal(store.getWeixinContextToken(scope), 'tok-next');
  });
});

test('BridgeStore persists and resolves thread bindings', () => {
  withStore((store) => {
    store.setBinding(S1, 'thread-1', '/tmp/project');
    const binding = store.getBinding(S1);

    assert.ok(binding);
    assert.deepEqual(binding, {
      chatId: S1,
      threadId: 'thread-1',
      cwd: '/tmp/project',
      updatedAt: binding.updatedAt,
    });
    assert.equal(store.findChatIdByThreadId('thread-1'), S1);
    assert.equal(store.countBindings(), 1);
  });
});

test('BridgeStore caches thread lists and pending approvals', () => {
  withStore((store) => {
    store.cacheThreadList(S2, [
      {
        threadId: 'thread-a',
        name: 'Fix auth bug',
        preview: 'Fix auth bug',
        cwd: '/repo/a',
        modelProvider: 'openai',
        status: 'idle',
        updatedAt: 100,
      },
      {
        threadId: 'thread-b',
        name: null,
        preview: 'Review docs',
        cwd: null,
        modelProvider: null,
        status: 'active',
        updatedAt: 200,
      },
    ]);
    assert.deepEqual(store.getCachedThread(S2, 2), {
      index: 2,
      threadId: 'thread-b',
      name: null,
      preview: 'Review docs',
      cwd: null,
      modelProvider: null,
      status: 'active',
      updatedAt: 200,
    });
    assert.equal(store.listCachedThreads(S2).length, 2);

    store.cacheThreadList(S2, [
      {
        listIndex: 5,
        threadId: 'thread-z',
        name: 'Z',
        preview: 'z',
        cwd: null,
        modelProvider: null,
        status: 'idle',
        updatedAt: 300,
      },
    ]);
    assert.deepEqual(store.getCachedThread(S2, 5)?.threadId, 'thread-z');

    store.savePendingApproval({
      localId: 'approval-1',
      serverRequestId: '42',
      kind: 'command',
      chatId: S2,
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'item-1',
      approvalId: null,
      reason: 'Needs confirmation',
      command: 'rm -rf build',
      cwd: '/repo/a',
      messageId: null,
      createdAt: 123,
      resolvedAt: null,
    });

    assert.equal(store.countPendingApprovals(), 1);
    store.updatePendingApprovalMessage('approval-1', 99);
    assert.equal(store.getPendingApproval('approval-1')?.messageId, 99);
    store.markApprovalResolved('approval-1');
    assert.ok(store.getPendingApproval('approval-1')?.resolvedAt !== null);
    assert.equal(store.countPendingApprovals(), 0);
  });
});

test('BridgeStore persists chat session settings', () => {
  withStore((store) => {
    store.setChatSettings(S3, 'o3', 'high');
    assert.deepEqual(store.getChatSettings(S3), {
      chatId: S3,
      model: 'o3',
      reasoningEffort: 'high',
      locale: null,
      accessPreset: null,
      collaborationMode: null,
      serviceTier: null,
      updatedAt: store.getChatSettings(S3)!.updatedAt,
    });

    store.setChatSettings(S3, null, 'medium');
    assert.deepEqual(store.getChatSettings(S3), {
      chatId: S3,
      model: null,
      reasoningEffort: 'medium',
      locale: null,
      accessPreset: null,
      collaborationMode: null,
      serviceTier: null,
      updatedAt: store.getChatSettings(S3)!.updatedAt,
    });

    store.setChatLocale(S3, 'zh');
    assert.deepEqual(store.getChatSettings(S3), {
      chatId: S3,
      model: null,
      reasoningEffort: 'medium',
      locale: 'zh',
      accessPreset: null,
      collaborationMode: null,
      serviceTier: null,
      updatedAt: store.getChatSettings(S3)!.updatedAt,
    });

    store.setChatAccessPreset(S3, 'full-access');
    assert.deepEqual(store.getChatSettings(S3), {
      chatId: S3,
      model: null,
      reasoningEffort: 'medium',
      locale: 'zh',
      accessPreset: 'full-access',
      collaborationMode: null,
      serviceTier: null,
      updatedAt: store.getChatSettings(S3)!.updatedAt,
    });

    store.setChatCollaborationMode(S3, 'plan');
    assert.deepEqual(store.getChatSettings(S3), {
      chatId: S3,
      model: null,
      reasoningEffort: 'medium',
      locale: 'zh',
      accessPreset: 'full-access',
      collaborationMode: 'plan',
      serviceTier: null,
      updatedAt: store.getChatSettings(S3)!.updatedAt,
    });

    store.setChatServiceTier(S3, 'priority');
    assert.deepEqual(store.getChatSettings(S3), {
      chatId: S3,
      model: null,
      reasoningEffort: 'medium',
      locale: 'zh',
      accessPreset: 'full-access',
      collaborationMode: 'plan',
      serviceTier: 'priority',
      updatedAt: store.getChatSettings(S3)!.updatedAt,
    });

    store.setChatSettings(S3, 'o3', 'low');
    assert.deepEqual(store.getChatSettings(S3), {
      chatId: S3,
      model: 'o3',
      reasoningEffort: 'low',
      locale: 'zh',
      accessPreset: 'full-access',
      collaborationMode: 'plan',
      serviceTier: 'priority',
      updatedAt: store.getChatSettings(S3)!.updatedAt,
    });
  });
});

test('BridgeStore migrates old chat settings rows without service tier', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-store-old-settings-'));
  const dbPath = path.join(tmpDir, 'bridge.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chat_settings (
      chat_id TEXT PRIMARY KEY,
      model TEXT,
      reasoning_effort TEXT,
      locale TEXT,
      access_preset TEXT,
      collaboration_mode TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO chat_settings (chat_id, model, reasoning_effort, locale, access_preset, collaboration_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(S4, 'gpt-5', 'high', 'zh', 'default', 'plan', 123);
  db.close();

  const store = new BridgeStore(dbPath);
  try {
    assert.equal(store.getChatSettings(S4)?.serviceTier, null);
    store.setChatServiceTier(S4, 'priority');
    assert.equal(store.getChatSettings(S4)?.serviceTier, 'priority');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BridgeStore persists active turn preview cleanup state', () => {
  withStore((store) => {
    store.saveActiveTurnPreview({
      turnId: 'turn-1',
      scopeId: S4,
      threadId: 'thread-1',
      messageId: 41,
    });

    let previews = store.listActiveTurnPreviews();
    assert.equal(previews.length, 1);
    assert.deepEqual(previews[0], {
      turnId: 'turn-1',
      scopeId: S4,
      threadId: 'thread-1',
      messageId: 41,
      createdAt: previews[0]!.createdAt,
      updatedAt: previews[0]!.updatedAt,
    });

    store.saveActiveTurnPreview({
      turnId: 'turn-2',
      scopeId: S4,
      threadId: 'thread-2',
      messageId: 42,
    });

    previews = store.listActiveTurnPreviews();
    assert.equal(previews.length, 1);
    assert.equal(previews[0]?.turnId, 'turn-2');
    assert.equal(previews[0]?.messageId, 42);

    store.removeActiveTurnPreviewByMessage(S4, 42);
    assert.deepEqual(store.listActiveTurnPreviews(), []);
  });
});

test('BridgeStore migrates legacy telegram scope keys on reopen', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-store-migrate-'));
  const dbPath = path.join(tmpDir, 'bridge.sqlite');
  let store = new BridgeStore(dbPath);
  store.setBinding('legacy::root', 'thread-m', null);
  store.close();

  store = new BridgeStore(dbPath);
  try {
    assert.equal(store.getBinding('legacy::root'), null);
    const migrated = store.getBinding('telegram:legacy::root');
    assert.ok(migrated);
    assert.equal(migrated!.threadId, 'thread-m');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
