import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { UnifiedChannelOrchestrator } from './orchestrator.js';
import { BridgeStore } from '../store/database.js';
import type { IEngineAdapter, EngineTurnRequest, EngineTurnExecution } from './engine_spi.js';
import type { TelegramGateway, TelegramTextEvent } from '../telegram/gateway.js';
import type { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import type { AppConfig } from '../config.js';

test('UnifiedChannelOrchestrator manages active turn, streaming preview, steer and queue', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-test-'));
  const dbPath = path.join(tempDir, 'test.db');

  try {
    const store = new BridgeStore(dbPath);
    const sentMessages: Array<{ scopeId: string; text: string }> = [];
    const editedMessages: Array<{ scopeId: string; messageId: number; text: string }> = [];

    const mockMessaging: Partial<TelegramMessagingPort> = {
      sendRichMarkdown: async (scopeId: string, text: string) => {
        sentMessages.push({ scopeId, text });
        return 100 + sentMessages.length;
      },
      editRichMarkdown: async (scopeId: string, messageId: number, text: string) => {
        editedMessages.push({ scopeId, messageId, text });
      },
      sendTypingInScope: async () => {},
      answerCallback: async () => {},
    };

    const mockBotEmitter = new EventEmitter();
    const mockBot = {
      username: 'TestBot',
      start: async () => {},
      stop: () => {},
      on: (event: any, listener: any) => {
        mockBotEmitter.on(event, listener);
        return mockBot as any;
      },
    } as unknown as TelegramGateway;

    let executedRequest: EngineTurnRequest | null = null;
    let turnEmitter = new EventEmitter();

    const mockAdapter: IEngineAdapter = {
      id: 'test_engine',
      name: 'Test Engine',
      listModels: async () => [
        { id: 'model-a', name: 'Model A', isDefault: true },
        { id: 'model-b', name: 'Model B' },
      ],
      executeTurn: (req) => {
        executedRequest = req;
        const execution: EngineTurnExecution = {
          turnId: 'turn-1',
          cancel: () => {
            turnEmitter.emit('result', {
              kind: 'result',
              status: 'INTERRUPTED',
              response: 'Cancelled',
              conversationId: 'conv-1',
            });
          },
          waitForResult: async () => null,
          on: (event: any, listener: any) => {
            turnEmitter.on(event, listener);
          },
        };
        return execution;
      },
    };

    const mockConfig: Partial<AppConfig> = {
      defaultCwd: '/tmp',
    };

    const orchestrator = new UnifiedChannelOrchestrator({
      config: mockConfig as AppConfig,
      store,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      bot: mockBot as TelegramGateway,
      adapter: mockAdapter,
      messaging: mockMessaging as TelegramMessagingPort,
    });

    orchestrator.registerInboundHandlers();
    await orchestrator.start();

    // 1. Send regular text prompt
    const event1: TelegramTextEvent = {
      scopeId: 'scope-1',
      chatId: 'chat-1',
      topicId: null,
      chatType: 'private',
      userId: 'user-1',
      messageId: 1,
      text: 'Hello world',
      attachments: [],
      entities: [],
      replyToBot: false,
    };

    await orchestrator.handleText(event1);

    assert.equal(orchestrator.getActiveTurnsCount(), 1);
    assert.ok(executedRequest);
    assert.equal((executedRequest as any).prompt, 'Hello world');
    assert.ok(sentMessages.some((m) => m.text.includes('Test Engine 正在思考中…')));

    // 2. Queue mode: send second message while first is running
    store.setChatActiveTurnMessageMode('scope-1', 'queue');
    const event2: TelegramTextEvent = {
      ...event1,
      messageId: 2,
      text: 'Second task',
    };

    await orchestrator.handleText(event2);

    // Second task should be queued
    assert.ok(sentMessages.some((m) => m.text.includes('已加入排队队列')));
    assert.equal(store.countQueuedTurnInputs('scope-1'), 1);

    // 3. Complete first turn -> should automatically drain queued second turn!
    turnEmitter.emit('result', {
      kind: 'result',
      status: 'SUCCESS',
      response: 'First task done!',
      conversationId: 'conv-1',
    });

    // Wait for drained turn to become active
    for (let i = 0; i < 50 && orchestrator.getActiveTurnsCount() === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.ok(editedMessages.some((m) => m.text === 'First task done!'));
    assert.ok(sentMessages.some((m) => m.text.includes('开始执行排队任务')));
    assert.equal(orchestrator.getActiveTurnsCount(), 1);

    // 4. Steer mode: interrupt and take over
    store.setChatActiveTurnMessageMode('scope-1', 'steer');
    const event3: TelegramTextEvent = {
      ...event1,
      messageId: 3,
      text: 'Third task (steer)',
    };

    await orchestrator.handleText(event3);
    assert.ok(sentMessages.some((m) => m.text.includes('已插话中断前置任务')));

    // 5. Test commands: /status and /setup
    await orchestrator.handleText({ ...event1, messageId: 4, text: '/status' });
    assert.ok(sentMessages.some((m) => m.text.includes('Test Engine 运行状态')));

    await orchestrator.handleText({ ...event1, messageId: 5, text: '/setup' });
    assert.ok(sentMessages.some((m) => m.text.includes('Test Engine 控制面板')));

    // 6. Test /boost command toggling and serviceTier propagation
    await orchestrator.handleText({ ...event1, messageId: 6, text: '/boost' });
    assert.ok(sentMessages.some((m) => m.text.includes('已开启 **Boost 增强模式**')));
    assert.equal(store.getChatSettings('scope-1')?.serviceTier, 'boost');
    assert.equal(store.getChatSettings('scope-1')?.reasoningEffort, 'high');

    // Turn executed under Boost mode has serviceTier in req and boost prompt prefix
    const boostEvent: TelegramTextEvent = {
      ...event1,
      messageId: 7,
      text: 'Solve hard problem',
    };
    await orchestrator.handleText(boostEvent);
    assert.ok(executedRequest);
    assert.equal((executedRequest as any).serviceTier, 'boost');
    assert.equal((executedRequest as any).effort, 'high');
    assert.ok((executedRequest as any).prompt.includes('[Boost Mode:'));

    // Complete boost turn
    turnEmitter.emit('result', {
      kind: 'result',
      status: 'SUCCESS',
      response: 'Solved with deep reasoning',
      conversationId: 'conv-1',
    });

    // 7. Toggle Boost via engine:setup:boost callback
    let answeredCallback = '';
    mockMessaging.answerCallback = async (_id: string, text?: string) => {
      answeredCallback = text || '';
    };

    await orchestrator.handleCallback({
      scopeId: 'scope-1',
      chatId: 'chat-1',
      topicId: null,
      userId: 'user-1',
      callbackQueryId: 'cb-1',
      messageId: 100,
      data: 'engine:setup:boost',
    });
    assert.ok(answeredCallback.includes('Boost 模式已关闭'));
    assert.equal(store.getChatSettings('scope-1')?.serviceTier, null);

    await orchestrator.stop();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('UnifiedChannelOrchestrator supports multi-backend registration and hot-switching like threads', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-multi-backend-'));
  const dbPath = path.join(tempDir, 'test.db');
  const store = new BridgeStore(dbPath);
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

  try {
    const config = {
      defaultCwd: tempDir,
      tgAllowedUserId: 'user-1',
      tgAllowedChatId: null,
      tgAllowedTopicId: null,
    } as unknown as AppConfig;

    const mockBot = new EventEmitter() as any;
    mockBot.username = 'test_bot';
    mockBot.start = async () => {};
    mockBot.stop = () => {};

    const sentMessages: Array<{ scopeId: string; text: string; keyboard?: any }> = [];
    const mockMessaging: any = {
      sendRichMarkdown: async (scopeId: string, text: string, keyboard?: any) => {
        sentMessages.push({ scopeId, text, keyboard });
        return 1;
      },
      editRichMarkdown: async (scopeId: string, _msgId: number, text: string, keyboard?: any) => {
        sentMessages.push({ scopeId, text, keyboard });
      },
      answerCallback: async () => {},
      sendTypingInScope: async () => {},
    };

    let executedEngineId = '';
    const createMockAdapter = (id: string, name: string): IEngineAdapter => ({
      id,
      name,
      listModels: async () => [{ id: `${id}-model-1`, name: `${name} Model 1`, isDefault: true }],
      executeTurn: (req) => {
        executedEngineId = id;
        const emitter = new EventEmitter();
        const turnExec: EngineTurnExecution = {
          turnId: `${id}_turn_1`,
          cancel: () => {},
          waitForResult: async () => ({
            kind: 'result',
            status: 'SUCCESS',
            response: `Response from ${name}`,
            conversationId: req.threadId || `${id}_thread_auto`,
          }),
          on: (event: string, listener: any) => emitter.on(event, listener),
        };
        setTimeout(() => {
          emitter.emit('delta', `Hello from ${name}`);
          emitter.emit('result', {
            kind: 'result',
            status: 'SUCCESS',
            response: `Hello from ${name}`,
            conversationId: req.threadId || `${id}_thread_auto`,
          });
        }, 10);
        return turnExec;
      },
    });

    const agyAdapter = createMockAdapter('antigravity', 'Google Antigravity (AGY)');
    const codexAdapter = createMockAdapter('codex', 'OpenAI Codex');
    const opencodeAdapter = createMockAdapter('opencode', 'OpenCode (SDK)');

    const orchestrator = new UnifiedChannelOrchestrator({
      config,
      store,
      logger,
      bot: mockBot,
      messaging: mockMessaging,
      backends: [
        { id: 'antigravity', name: 'Google Antigravity (AGY)', engineType: 'antigravity', adapter: agyAdapter, account: 'wuya@gmail.com' },
        { id: 'codex', name: 'OpenAI Codex', engineType: 'codex', adapter: codexAdapter, account: 'Codex App' },
        { id: 'opencode', name: 'OpenCode (SDK)', engineType: 'opencode', adapter: opencodeAdapter },
      ],
      defaultBackendId: 'antigravity',
    });

    orchestrator.registerInboundHandlers();
    await orchestrator.start();

    const scopeId = 'scope-multi-1';
    const baseEvent: TelegramTextEvent = {
      scopeId,
      chatId: 'chat-1',
      topicId: null,
      chatType: 'private',
      userId: 'user-1',
      messageId: 1,
      text: '',
      attachments: [],
      entities: [],
      replyToBot: false,
    };

    // 1. Initial status and /backend list
    await orchestrator.handleText({ ...baseEvent, messageId: 1, text: '/backend' });
    const backendListMsg = sentMessages.find((m) => m.text.includes('后端运行环境与账号'));
    assert.ok(backendListMsg, 'Should show backend list menu');
    assert.ok(backendListMsg!.text.includes('Google Antigravity (AGY)'));
    assert.ok(backendListMsg!.text.includes('OpenAI Codex'));
    assert.ok(backendListMsg!.text.includes('OpenCode (SDK)'));

    // Check setup panel includes backend switcher
    await orchestrator.handleText({ ...baseEvent, messageId: 2, text: '/setup' });
    const setupMsg = sentMessages[sentMessages.length - 1];
    assert.ok(setupMsg?.keyboard?.some((row: any) => row.some((btn: any) => btn.text.includes('切换后端'))));

    // 2. Execute prompt on default backend (antigravity)
    store.setBinding(scopeId, 'conv-agy-init', '/repo/foxclaw');
    await orchestrator.handleText({ ...baseEvent, messageId: 3, text: 'Hello Antigravity' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(executedEngineId, 'antigravity');

    // 3. Hot-switch to Codex via /backend codex
    await orchestrator.handleText({ ...baseEvent, messageId: 4, text: '/backend codex' });
    const switchedMsg = sentMessages.find((m) => m.text.includes('已切换至后端: OpenAI Codex'));
    assert.ok(switchedMsg, 'Should confirm switch to OpenAI Codex');
    assert.equal(store.getActiveBackend(scopeId), 'codex');

    // Antigravity binding should have been saved to scope_backend_bindings
    const savedAgy = store.getScopeBackendBinding(scopeId, 'antigravity');
    assert.ok(savedAgy);
    assert.equal(savedAgy!.threadId, 'conv-agy-init');

    // Execute prompt on Codex
    store.setBinding(scopeId, 'thread-codex-1', '/repo/podcast');
    await orchestrator.handleText({ ...baseEvent, messageId: 5, text: 'Hello Codex' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(executedEngineId, 'codex');

    // 4. Hot-switch back to Antigravity via callback
    await orchestrator.handleCallback({
      scopeId,
      chatId: 'chat-1',
      topicId: null,
      userId: 'user-1',
      callbackQueryId: 'cb-back-agy',
      messageId: 10,
      data: 'engine:backend:antigravity',
    });

    assert.equal(store.getActiveBackend(scopeId), 'antigravity');
    // Previous Antigravity thread should be restored automatically!
    const restoredBinding = store.getBinding(scopeId);
    assert.ok(restoredBinding);
    assert.equal(restoredBinding!.threadId, 'conv-agy-init');

    // Codex binding should also be preserved in store
    const savedCodex = store.getScopeBackendBinding(scopeId, 'codex');
    assert.ok(savedCodex);
    assert.equal(savedCodex!.threadId, 'thread-codex-1');

    // Execute prompt on restored Antigravity
    await orchestrator.handleText({ ...baseEvent, messageId: 6, text: 'Back on Antigravity' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(executedEngineId, 'antigravity');

    await orchestrator.stop();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

