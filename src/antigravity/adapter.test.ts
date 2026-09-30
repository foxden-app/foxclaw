import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { AntigravityEngineAdapter } from './adapter.js';
import { AntigravityAppClient, type AntigravityTurnExecution } from './client.js';
import type { AntigravityBridgeEvent } from './events.js';
import { AntigravityTelegramRuntime } from './runtime.js';

test('AntigravityEngineAdapter converts models and maps turn lifecycle events to Engine SPI', async () => {
  const mockClientEmitter = new EventEmitter();
  let executedOptions: Record<string, unknown> | null = null;

  const mockExecution: AntigravityTurnExecution = {
    conversationId: 'conv-123',
    cancel: () => {
      mockClientEmitter.emit('exit', 0, null);
    },
    waitForResult: async () => {
      return {
        kind: 'result',
        status: 'SUCCESS',
        response: 'Hello from Antigravity',
        conversationId: 'conv-123',
        durationSeconds: 1,
      };
    },
    on: (event: any, listener: any) => {
      mockClientEmitter.on(event, listener);
    },
  };

  const mockClient: Partial<AntigravityAppClient> = {
    listModels: async () => ['gemini-3.8-flash-high', 'gemini-3.1-pro-high', 'claude-sonnet-4-6'],
    executeTurn: (opts: any) => {
      executedOptions = opts;
      return mockExecution;
    },
  };

  const adapter = new AntigravityEngineAdapter(mockClient as AntigravityAppClient, 'gemini-3.8-flash');

  assert.equal(adapter.id, 'antigravity');
  assert.equal(adapter.name, 'Google Antigravity (AGY)');

  const models = await adapter.listModels();
  assert.equal(models.length, 3);
  assert.equal(models[0]?.id, 'gemini-3.8-flash');
  assert.equal(models[0]?.isDefault, true);
  assert.equal(models[1]?.id, 'gemini-3.1-pro');
  assert.equal(models[1]?.isDefault, false);

  const deltas: string[] = [];
  const tools: any[] = [];
  let resultReceived: any = null;

  const execution = adapter.executeTurn({
    scopeId: 'test-scope',
    prompt: 'Summarize file',
    threadId: 'conv-123',
    cwd: '/tmp',
    model: 'gemini-3.8-flash',
    locale: 'zh',
    stagedAttachments: [
      {
        fileName: 'photo.jpg',
        localPath: '/tmp/photo.jpg',
        relativePath: '.telegram-inbox/photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        nativeImage: true,
        kind: 'photo',
        fileId: 'f1',
        fileUniqueId: 'u1',
        width: 100,
        height: 100,
        durationSeconds: null,
        isAnimated: false,
        isVideo: false,
      },
    ],
  });

  execution.on('delta', (d) => deltas.push(d));
  execution.on('tool', (t) => tools.push(t));
  execution.on('result', (r) => {
    resultReceived = r;
  });

  // Verify prompt was wrapped with attachments
  assert.ok(executedOptions);
  assert.ok((executedOptions as any).prompt.includes('Telegram attachments'));
  assert.ok((executedOptions as any).prompt.includes('/tmp/photo.jpg'));

  // Emit mock events
  const deltaEvent: AntigravityBridgeEvent = {
    kind: 'text',
    conversationId: 'conv-123',
    stepIndex: 1,
    delta: 'Hello ',
    accumulatedText: 'Hello ',
  };
  mockClientEmitter.emit('event', deltaEvent);

  const toolEvent: AntigravityBridgeEvent = {
    kind: 'tool',
    conversationId: 'conv-123',
    stepIndex: 1,
    state: 'ACTIVE',
    toolName: 'view_file',
    parameters: { path: '/tmp/photo.jpg' },
  };
  mockClientEmitter.emit('event', toolEvent);

  const resultEvent: AntigravityBridgeEvent = {
    kind: 'result',
    status: 'SUCCESS',
    response: 'Finished',
    conversationId: 'conv-123',
    durationSeconds: 2,
  };
  mockClientEmitter.emit('event', resultEvent);

  assert.deepEqual(deltas, ['Hello ']);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'view_file');
  assert.equal(tools[0]?.status, 'running');
  assert.equal(resultReceived?.status, 'SUCCESS');
  assert.equal(resultReceived?.response, 'Finished');

  const waitRes = await execution.waitForResult();
  assert.equal(waitRes?.status, 'SUCCESS');
  assert.equal(waitRes?.response, 'Hello from Antigravity');
});

test('AntigravityEngineAdapter falls back to defaultModel and captures error message on failure', async () => {
  const mockClientEmitter = new EventEmitter();
  let executedOptions: Record<string, unknown> | null = null;

  const mockExecution: AntigravityTurnExecution = {
    conversationId: 'conv-456',
    cancel: () => {},
    waitForResult: async () => null,
    on: (event: any, listener: any) => {
      mockClientEmitter.on(event, listener);
    },
  };

  const mockClient: Partial<AntigravityAppClient> = {
    listModels: async () => ['gemini-3.8-flash-high'],
    executeTurn: (opts: any) => {
      executedOptions = opts;
      return mockExecution;
    },
  };

  const adapter = new AntigravityEngineAdapter(mockClient as AntigravityAppClient, 'gemini-3.8-flash-high');

  let resultReceived: any = null;
  const execution = adapter.executeTurn({
    scopeId: 'test-scope',
    prompt: 'test prompt',
    threadId: 'conv-456',
    cwd: '/tmp',
    model: 'default',
    locale: 'zh',
  });

  execution.on('result', (r) => {
    resultReceived = r;
  });

  // Verify that model: 'default' fell back to 'gemini-3.8-flash-high'
  assert.equal((executedOptions as any)?.model, 'gemini-3.8-flash-high');

  // Emit error result where response is empty but error has text
  const errorResult: AntigravityBridgeEvent = {
    kind: 'result',
    status: 'ERROR',
    response: '',
    error: 'invalid model selection (--model "default")',
    conversationId: 'conv-456',
    durationSeconds: 0,
  };
  mockClientEmitter.emit('event', errorResult);

  assert.equal(resultReceived?.status, 'ERROR');
  assert.equal(resultReceived?.response, 'invalid model selection (--model "default")');
});

test('AntigravityEngineAdapter automatically pauses failing account, rotates and retries on Verification Required', async () => {
  const pausedAccounts: string[] = [];
  const cooldowns: string[] = [];
  let rotatedAccount = '';
  const sentMessages: string[] = [];
  let retriedCount = -1;

  const mockAuth: any = {
    getActiveAccount: async () => ({ name: 'aiopx2024_gmail_com', email: 'aiopx2024@gmail.com' }),
    pauseAccount: (name: string) => pausedAccounts.push(name),
    markCooldown: (name: string) => cooldowns.push(name),
    rotateNextCandidate: async () => {
      rotatedAccount = 'aiopx2026@gmail.com';
      return { success: true, account: { name: 'aiopx2026_gmail_com', email: 'aiopx2026@gmail.com' } };
    },
  };

  const adapter = new AntigravityEngineAdapter({} as any, 'gemini-3.8-flash', mockAuth);

  const handled = await adapter.handleTurnError({
    error: 'Verification Required: Please complete verification in your browser to continue.',
    request: { locale: 'zh', model: 'gemini-3.8-flash' } as any,
    retryCount: 0,
    retryTurn: async (nextCount) => {
      retriedCount = nextCount;
    },
    sendMessage: async (text) => {
      sentMessages.push(text);
      return 1;
    },
    editMessage: async () => {},
  });

  assert.equal(handled, true);
  assert.ok(pausedAccounts.includes('aiopx2024_gmail_com'));
  assert.ok(cooldowns.includes('aiopx2024_gmail_com'));
  assert.equal(rotatedAccount, 'aiopx2026@gmail.com');
  assert.equal(retriedCount, 1);
  assert.ok(sentMessages[0]?.includes('Verification Required'));
  assert.ok(sentMessages[0]?.includes('aiopx2024@gmail.com'));
  assert.ok(sentMessages[0]?.includes('aiopx2026@gmail.com'));
  assert.ok(sentMessages[0]?.includes('agy -p "hi"'));
});

test('AntigravityAppClient propagates childEnv', () => {
  const client = new AntigravityAppClient('agy', undefined, { HOME: '/custom/bot/home' });
  assert.deepEqual(client.env, { HOME: '/custom/bot/home' });
});

test('AntigravityTelegramRuntime initializes multi-bot options with custom botId, home, and authDir', () => {
  const mockConfig: any = {
    tgAllowedUserId: '12345',
    tgAllowedChatId: null,
    telegramPollIntervalMs: 1000,
    antigravityCliBin: 'agy',
    antigravityAuthDir: '/tmp/default-auth',
    antigravityDefaultModel: 'gemini-3.8-flash',
    antigravityBotToken: 'default_token',
    antigravityBotTokens: ['default_token', 'bot2_token'],
    antigravityDefaultRuntimeBotToken: 'default_token',
  };
  const mockStore: any = {
    getTelegramOffset: () => 0,
    setTelegramOffset: () => {},
    on: () => {},
  };
  const mockLogger: any = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const runtime = new AntigravityTelegramRuntime(mockConfig, mockStore, mockLogger, {
    botToken: 'bot2_token',
    botId: 'bot9999',
    botUsername: 'SecondAgyBot',
    sharedDefaultRuntime: false,
    home: '/tmp/foxclaw/antigravity/@SecondAgyBot/home',
    authDir: '/tmp/foxclaw/antigravity/@SecondAgyBot/home/.gemini/antigravity-cli',
  });

  assert.equal(runtime.id, 'bot9999');
  assert.equal(runtime.username, 'SecondAgyBot');
  assert.equal(runtime.isSharedDefaultRuntime, false);
  assert.equal(runtime.botHome, '/tmp/foxclaw/antigravity/@SecondAgyBot/home');
  assert.equal(runtime.authDirectory, '/tmp/foxclaw/antigravity/@SecondAgyBot/home/.gemini/antigravity-cli');
});

test('AntigravityEngineAdapter handles transient network errors and retries', async () => {
  const adapter = new AntigravityEngineAdapter({} as any, 'gemini-3.8-flash');
  let retriedCount = -1;
  const sentMessages: string[] = [];

  const handled = await adapter.handleTurnError({
    error: 'Client network socket disconnected before secure TLS connection was established',
    request: { locale: 'zh', model: 'gemini-3.8-flash' } as any,
    retryCount: 0,
    retryTurn: async (nextCount) => {
      retriedCount = nextCount;
    },
    sendMessage: async (text) => {
      sentMessages.push(text);
      return 1;
    },
    editMessage: async () => {},
  });

  assert.equal(handled, true);
  assert.equal(retriedCount, 1);
  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0]?.includes('网络波动或连接中断'));
  assert.ok(sentMessages[0]?.includes('安全重试'));
});

test('AntigravityEngineAdapter tolerates messaging failure during network drops', async () => {
  const adapter = new AntigravityEngineAdapter({} as any, 'gemini-3.8-flash');
  let retriedCount = -1;

  const handled = await adapter.handleTurnError({
    error: 'read tcp 127.0.0.1:44600->127.0.0.1:7897: read: connection timed out status: UNKNOWN code_kind: grpc retryable: true',
    request: { locale: 'zh', model: 'gemini-3.8-flash' } as any,
    retryCount: 1,
    retryTurn: async (nextCount) => {
      retriedCount = nextCount;
    },
    sendMessage: async () => {
      throw new Error('Client network socket disconnected');
    },
    editMessage: async () => {},
  });

  assert.equal(handled, true);
  assert.equal(retriedCount, 2);
});

test('AntigravityEngineAdapter notifies user when network retries are exhausted', async () => {
  const adapter = new AntigravityEngineAdapter({} as any, 'gemini-3.8-flash');
  let retried = false;
  const sentMessages: string[] = [];

  const handled = await adapter.handleTurnError({
    error: 'Client network socket disconnected before secure TLS connection was established',
    request: { locale: 'zh', model: 'gemini-3.8-flash' } as any,
    retryCount: 3,
    retryTurn: async () => {
      retried = true;
    },
    sendMessage: async (text) => {
      sentMessages.push(text);
      return 1;
    },
    editMessage: async () => {},
  });

  assert.equal(handled, true);
  assert.equal(retried, false);
  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0]?.includes('网络连接连续中断 (已重试 3 次)'));
});

test('AntigravityEngineAdapter tracks and emits subagent tool events during executeTurn', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-adapter-subagent-test-'));
  try {
    const parentId = 'parent-conv-subtest';
    const subId = 'sub-conv-subtest';

    // 1. Prepare conversation_summaries.db
    const dbPath = path.join(tempDir, 'conversation_summaries.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id text PRIMARY KEY,
          agent_name text NOT NULL DEFAULT "",
          parent_conversation_id text NOT NULL DEFAULT "",
          status text NOT NULL DEFAULT "",
          not_fully_idle numeric NOT NULL DEFAULT 1,
          killed numeric NOT NULL DEFAULT 0,
          last_modified_time datetime NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO conversation_summaries
          (conversation_id, agent_name, parent_conversation_id, status, not_fully_idle, killed, last_modified_time)
        VALUES
          (?, 'DeepCoder', ?, 'CASCADE_RUN_STATUS_RUNNING', 1, 0, datetime('now'))
      `).run(subId, parentId);
    } finally {
      db.close();
    }

    // 2. Prepare subagent transcript directory
    const subDir = path.join(tempDir, 'brain', subId, '.system_generated', 'logs');
    fs.mkdirSync(subDir, { recursive: true });
    const subTranscript = path.join(subDir, 'transcript.jsonl');
    fs.writeFileSync(
      subTranscript,
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          {
            name: 'view_file',
            args: { AbsolutePath: '/workspace/src/index.ts' },
          },
        ],
      }) + '\n',
    );

    const mockClientEmitter = new EventEmitter();
    const mockExecution: AntigravityTurnExecution = {
      conversationId: parentId,
      cancel: () => {},
      waitForResult: async () => ({
        kind: 'result',
        status: 'SUCCESS',
        conversationId: parentId,
      }),
      on: (ev: any, listener: any) => {
        mockClientEmitter.on(ev, listener);
      },
    };

    const mockClient: Partial<AntigravityAppClient> = {
      executeTurn: () => mockExecution,
    };

    const adapter = new AntigravityEngineAdapter(
      mockClient as AntigravityAppClient,
      'gemini-3.8-flash',
      undefined,
      undefined,
      tempDir,
    );

    const toolEvents: any[] = [];
    const execution = adapter.executeTurn({
      scopeId: 'test-scope',
      prompt: 'do subagent work',
      threadId: parentId,
      locale: 'zh',
    });

    execution.on('tool', (t) => toolEvents.push(t));

    // Wait for the polling tick to pick up the subagent tool
    for (let i = 0; i < 30; i++) {
      if (toolEvents.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(toolEvents.length >= 1, 'Should emit subagent tool event');
    assert.equal(toolEvents[0]?.name, '[DeepCoder] view_file');
    assert.equal(toolEvents[0]?.summary, 'index.ts');
    assert.equal(toolEvents[0]?.status, 'running');

    // Finish execution cleanly
    mockClientEmitter.emit('event', {
      kind: 'result',
      status: 'SUCCESS',
      conversationId: parentId,
    });
    await execution.waitForResult();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});



