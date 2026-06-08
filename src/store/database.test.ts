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

test('BridgeStore persists disabled Codex auth candidates', () => {
  withStore((store) => {
    assert.deepEqual([...store.listDisabledCodexAuthCandidateNames()], []);
    store.setCodexAuthCandidateDisabled('auth.json_a', true);
    store.setCodexAuthCandidateDisabled('auth.json_b', false);
    assert.deepEqual([...store.listDisabledCodexAuthCandidateNames()], ['auth.json_a']);
    store.setCodexAuthCandidateDisabled('auth.json_a', false);
    assert.deepEqual([...store.listDisabledCodexAuthCandidateNames()], []);
  });
});

test('BridgeStore isolates disabled Codex auth candidates per runtime', () => {
  withStore((store) => {
    store.setCodexAuthCandidateDisabled('auth.json_a', true, 'bot1');
    store.setCodexAuthCandidateDisabled('auth.json_b', true, 'bot2');
    assert.deepEqual([...store.listDisabledCodexAuthCandidateNames('bot1')], ['auth.json_a']);
    assert.deepEqual([...store.listDisabledCodexAuthCandidateNames('bot2')], ['auth.json_b']);
    assert.deepEqual([...store.listDisabledCodexAuthCandidateNames()], []);
  });
});

test('BridgeStore shares Codex auth quota snapshots by account id', () => {
  withStore((store) => {
    store.setCodexAuthQuotaSnapshot('bot1', 'auth.json_a', 'acct-a', {
      capturedAtMs: 100,
      planType: 'free',
      primaryWindowDurationMins: 43200,
      primaryRemainingPercent: 80,
      secondaryWindowDurationMins: null,
      secondaryRemainingPercent: null,
    });
    store.setCodexAuthQuotaSnapshot('bot2', 'auth.json_b', 'acct-b', {
      capturedAtMs: 200,
      planType: 'plus',
      primaryWindowDurationMins: 300,
      primaryRemainingPercent: 30,
      secondaryWindowDurationMins: 10080,
      secondaryRemainingPercent: 25,
    });
    store.setCodexAuthQuotaSnapshot('bot1', 'auth.json_a', 'acct-a', {
      capturedAtMs: 300,
      planType: 'plus',
      primaryWindowDurationMins: 300,
      primaryRemainingPercent: 70,
      secondaryWindowDurationMins: 10080,
      secondaryRemainingPercent: 65,
    });

    assert.deepEqual(store.listCodexAuthQuotaSnapshots(['acct-a']).map(record => ({
      runtimeId: record.runtimeId,
      candidateName: record.candidateName,
      accountId: record.accountId,
      capturedAtMs: record.capturedAtMs,
      planType: record.planType,
      primaryWindowDurationMins: record.primaryWindowDurationMins,
      primaryRemainingPercent: record.primaryRemainingPercent,
      secondaryWindowDurationMins: record.secondaryWindowDurationMins,
      secondaryRemainingPercent: record.secondaryRemainingPercent,
    })), [{
      runtimeId: 'bot1',
      candidateName: 'auth.json_a',
      accountId: 'acct-a',
      capturedAtMs: 300,
      planType: 'plus',
      primaryWindowDurationMins: 300,
      primaryRemainingPercent: 70,
      secondaryWindowDurationMins: 10080,
      secondaryRemainingPercent: 65,
    }]);
  });
});

test('BridgeStore remembers a private chat for each bot notification route', () => {
  withStore((store) => {
    store.rememberTelegramPrivateScope('bot1', 'telegram:bot1:42::root', '42');
    store.rememberTelegramPrivateScope('bot2', 'telegram:bot2:42::root', '42');
    assert.equal(store.getTelegramPrivateChatId('bot1'), '42');
    assert.equal(store.getTelegramPrivateChatId('bot2'), '42');
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

test('BridgeStore resolves all scopes bound to a thread', () => {
  withStore((store) => {
    store.setBinding(S1, 'thread-shared', '/tmp/a');
    store.setBinding(S2, 'thread-shared', '/tmp/b');
    store.setBinding(S3, 'thread-other', '/tmp/c');

    assert.deepEqual(new Set(store.findAllChatIdsByThreadId('thread-shared')), new Set([S1, S2]));
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
      archived: false,
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
      payloadJson: null,
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
      activeTurnMessageMode: null,
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
      activeTurnMessageMode: null,
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
      activeTurnMessageMode: null,
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
      activeTurnMessageMode: null,
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
      activeTurnMessageMode: null,
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
      activeTurnMessageMode: null,
      updatedAt: store.getChatSettings(S3)!.updatedAt,
    });

    store.setChatActiveTurnMessageMode(S3, 'queue');
    assert.deepEqual(store.getChatSettings(S3), {
      chatId: S3,
      model: null,
      reasoningEffort: 'medium',
      locale: 'zh',
      accessPreset: 'full-access',
      collaborationMode: 'plan',
      serviceTier: 'priority',
      activeTurnMessageMode: 'queue',
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
      activeTurnMessageMode: 'queue',
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
    assert.equal(store.getChatSettings(S4)?.activeTurnMessageMode, null);
    store.setChatServiceTier(S4, 'priority');
    assert.equal(store.getChatSettings(S4)?.serviceTier, 'priority');
    store.setChatActiveTurnMessageMode(S4, 'steer');
    assert.equal(store.getChatSettings(S4)?.activeTurnMessageMode, 'steer');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BridgeStore migrates old auth quota snapshots without plan and window metadata', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-store-old-auth-quota-'));
  const dbPath = path.join(tmpDir, 'bridge.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE codex_auth_quota_snapshots (
      runtime_id TEXT NOT NULL,
      candidate_name TEXT NOT NULL,
      account_id TEXT NOT NULL,
      captured_at_ms INTEGER NOT NULL,
      primary_remaining_percent REAL,
      secondary_remaining_percent REAL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (runtime_id, candidate_name)
    );
  `);
  db.prepare(`
    INSERT INTO codex_auth_quota_snapshots (
      runtime_id, candidate_name, account_id, captured_at_ms,
      primary_remaining_percent, secondary_remaining_percent, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('bot-old', 'auth.json_old', 'acct-old', 100, 80, null, 200);
  db.close();

  const store = new BridgeStore(dbPath);
  try {
    assert.deepEqual(store.listCodexAuthQuotaSnapshots(['acct-old']).map(record => ({
      planType: record.planType,
      primaryWindowDurationMins: record.primaryWindowDurationMins,
      primaryRemainingPercent: record.primaryRemainingPercent,
      secondaryWindowDurationMins: record.secondaryWindowDurationMins,
      secondaryRemainingPercent: record.secondaryRemainingPercent,
    })), [{
      planType: null,
      primaryWindowDurationMins: null,
      primaryRemainingPercent: 80,
      secondaryWindowDurationMins: null,
      secondaryRemainingPercent: null,
    }]);
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

test('BridgeStore persists queued turns in FIFO order', () => {
  withStore((store) => {
    const now = Date.now();
    store.saveQueuedTurnInput({
      queueId: 'queue-1',
      scopeId: S1,
      chatId: 'chat-1',
      chatType: 'private',
      topicId: null,
      threadId: 'thread-1',
      inputJson: JSON.stringify([{ type: 'text', text: 'first', text_elements: [] }]),
      sourceSummary: 'first',
      messageId: 1,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    });
    store.saveQueuedTurnInput({
      queueId: 'queue-2',
      scopeId: S1,
      chatId: 'chat-1',
      chatType: 'private',
      topicId: null,
      threadId: 'thread-1',
      inputJson: JSON.stringify([{ type: 'text', text: 'second', text_elements: [] }]),
      sourceSummary: 'second',
      messageId: 2,
      status: 'queued',
      error: null,
      createdAt: now + 1,
      updatedAt: now + 1,
      resolvedAt: null,
    });

    assert.equal(store.peekQueuedTurnInput(S1)?.queueId, 'queue-1');
    assert.deepEqual(store.listQueuedTurnInputs(S1).map(record => record.queueId), ['queue-1', 'queue-2']);
    store.updateQueuedTurnInputStatus('queue-1', 'processing');
    assert.equal(store.peekQueuedTurnInput(S1)?.queueId, 'queue-2');
    store.requeueInterruptedQueuedTurnInputs();
    assert.equal(store.peekQueuedTurnInput(S1)?.queueId, 'queue-1');
    store.cancelQueuedTurnInputs(S1);
    assert.equal(store.countQueuedTurnInputs(S1), 0);
  });
});

test('BridgeStore persists pending attachment batches', () => {
  withStore((store) => {
    const now = Date.now();
    store.savePendingAttachmentBatch({
      batchId: 'batch-1',
      scopeId: S1,
      chatId: 'chat-1',
      chatType: 'private',
      topicId: null,
      threadId: 'thread-1',
      cwd: '/repo',
      mediaGroupId: 'album-1',
      attachmentsJson: JSON.stringify([{ kind: 'photo', fileName: 'a.jpg', localPath: '/repo/a.jpg', relativePath: 'a.jpg' }]),
      caption: 'caption',
      messageId: null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    });

    assert.equal(store.findPendingAttachmentBatchByMediaGroup(S1, 'album-1')?.batchId, 'batch-1');
    store.updatePendingAttachmentBatchMessage('batch-1', 42);
    assert.equal(store.getPendingAttachmentBatch('batch-1')?.messageId, 42);
    store.resolvePendingAttachmentBatch('batch-1', 'consumed');
    assert.equal(store.getLatestPendingAttachmentBatch(S1), null);
  });
});

test('BridgeStore persists guided plan sessions', () => {
  withStore((store) => {
    const now = Date.now();
    store.saveGuidedPlanSession({
      sessionId: 'plan-1',
      scopeId: S1,
      chatId: 'chat-1',
      chatType: 'private',
      topicId: null,
      threadId: 'thread-1',
      turnId: 'turn-1',
      cwd: '/repo',
      planMarkdown: '- patch',
      messageId: null,
      state: 'awaiting_confirmation',
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    });

    assert.equal(store.findOpenGuidedPlanSession(S1, 'turn-1')?.sessionId, 'plan-1');
    store.updateGuidedPlanSessionMessage('plan-1', 77);
    assert.equal(store.getGuidedPlanSession('plan-1')?.messageId, 77);
    store.updateGuidedPlanSessionState('plan-1', 'completed');
    assert.equal(store.findOpenGuidedPlanSession(S1, 'turn-1'), null);
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
