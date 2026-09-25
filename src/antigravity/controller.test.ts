import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AntigravityBridgeCore, UnifiedBridgeCore } from './controller.js';
import { BridgeStore } from '../store/database.js';
import { AntigravityAuthManager } from './auth.js';
import type { AntigravityAppClient } from './client.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import type { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import type { AppConfig } from '../config.js';

test('AntigravityBridgeCore initializes with orchestrator, handles custom commands and auth panels', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-core-test-'));
  const dbPath = path.join(tempDir, 'test.db');
  const authDir = path.join(tempDir, 'auth');
  await fs.mkdir(authDir, { recursive: true });

  // Create mock accounts with quota
  const tokenFile1 = path.join(authDir, 'antigravity-oauth-token_aiopx2027.json');
  await fs.writeFile(
    tokenFile1,
    JSON.stringify({
      refresh_token: 'dummy_refresh_1',
      access_token: 'dummy_access_1',
      id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFpb3B4MjAyN0BnbWFpbC5jb20ifQ.signature',
      expiry_date: Date.now() + 3600000,
    }),
  );

  try {
    const store = new BridgeStore(dbPath);
    const sentMessages: Array<{ scopeId: string; text: string; keyboard?: any }> = [];
    const editedMessages: Array<{ scopeId: string; messageId: number; text: string }> = [];

    const mockMessaging: Partial<TelegramMessagingPort> = {
      sendRichMarkdown: async (scopeId: string, text: string, keyboard?: any) => {
        sentMessages.push({ scopeId, text, keyboard });
        return 100 + sentMessages.length;
      },
      sendPlain: async (scopeId: string, text: string, keyboard?: any) => {
        sentMessages.push({ scopeId, text, keyboard });
        return 100 + sentMessages.length;
      },
      editRichMarkdown: async (scopeId: string, messageId: number, text: string) => {
        editedMessages.push({ scopeId, messageId, text });
      },
      editPlain: async (scopeId: string, messageId: number, text: string) => {
        editedMessages.push({ scopeId, messageId, text });
      },
      sendTypingInScope: async () => {},
      answerCallback: async () => {},
      deleteMessage: async () => {},
    };

    const mockBotEmitter = new EventEmitter();
    const mockBot = {
      username: 'AntigravityBot',
      start: async () => {},
      stop: () => {},
      on: (event: any, listener: any) => {
        mockBotEmitter.on(event, listener);
        return mockBot as any;
      },
    } as unknown as TelegramGateway;

    const mockApp: Partial<AntigravityAppClient> = {
      listModels: async () => ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'],
      executeTurn: () => {
        const agEmitter = new EventEmitter();
        return {
          conversationId: 'agy_conv_1',
          cancel: () => {},
          waitForResult: async () => ({
            kind: 'result',
            status: 'SUCCESS',
            response: 'Antigravity answer from orchestrator',
            conversationId: 'agy_conv_1',
            durationSeconds: 1.5,
          }),
          on: (event: any, listener: any) => {
            agEmitter.on(event, listener);
            if (event === 'event') {
              setTimeout(() => {
                agEmitter.emit('event', {
                  kind: 'result',
                  status: 'SUCCESS',
                  response: 'Antigravity answer from orchestrator',
                  conversationId: 'agy_conv_1',
                });
                agEmitter.emit('exit', 0);
              }, 10);
            }
          },
        } as any;
      },
    };

    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as any;

    const mockConfig: Partial<AppConfig> = {
      antigravityAuthDir: authDir,
      antigravityDefaultModel: 'gemini-3.8-flash-high',
      defaultCwd: '/home/wuya/git/foxclaw',
    };

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        userQuotaSummary: {
          fiveHourPercent: 100,
          weeklyPercent: 80,
        },
      }),
    });
    const auth = new AntigravityAuthManager(authDir, mockLogger, mockFetch as any);
    const core = new AntigravityBridgeCore(
      mockConfig as AppConfig,
      store,
      mockLogger,
      mockBot,
      mockApp as AntigravityAppClient,
      auth,
      mockMessaging as TelegramMessagingPort,
    );

    core.registerInboundHandlers();
    await core.start();

    assert.equal(core.getRuntimeStatus().activeTurns, 0);

    const scopeId = 'chat_test_1';

    // 1. Test /auth command
    const authEvent: TelegramTextEvent = {
      scopeId,
      chatId: scopeId,
      topicId: null,
      chatType: 'private',
      userId: 'user_1',
      messageId: 1,
      text: '/auth',
      attachments: [],
      entities: [],
      replyToBot: false,
    };

    mockBotEmitter.emit('text', authEvent);
    await new Promise((r) => setTimeout(r, 80));

    const authMsg = sentMessages.find((m) => m.text.includes('Antigravity 账号管理池'));
    assert.ok(authMsg, 'Should send auth management panel');
    assert.ok(authMsg.keyboard, 'Should include keyboard with candidate buttons');
    const candidateButton = authMsg.keyboard[0][0];
    assert.ok(candidateButton.text.includes('100%|80%|aiopx2027'), `Button text should be formatted with percentages: ${candidateButton.text}`);

    // Verify /status includes quota line with remaining percentage label
    mockBotEmitter.emit('text', { ...authEvent, messageId: 10, text: '/status' });
    await new Promise((r) => setTimeout(r, 80));
    const statusMsg = sentMessages.find((m) => m.text.includes('运行状态'));
    assert.ok(statusMsg, 'Should send status message');
    assert.ok(statusMsg.text.includes('5h/7d 额度'), 'Status message should include 5h/7d quota line');
    assert.ok(statusMsg.text.includes('100% | 80%'), 'Status message should show 100% | 80%');

    // 2. Test prompt turn execution through orchestrator
    const promptEvent: TelegramTextEvent = {
      scopeId,
      chatId: scopeId,
      topicId: null,
      chatType: 'private',
      userId: 'user_1',
      messageId: 2,
      text: 'Hello from Telegram',
      attachments: [],
      entities: [],
      replyToBot: false,
    };

    mockBotEmitter.emit('text', promptEvent);
    await new Promise((r) => setTimeout(r, 100));

    // Initial thinking message sent
    const thinkingMsg = sentMessages.find((m) => m.text.includes('正在思考中'));
    assert.ok(thinkingMsg, 'Should send thinking message');

    // Final answer edited into preview message
    const finalAnswer = editedMessages.find((m) => m.text.includes('Antigravity answer from orchestrator'));
    assert.ok(finalAnswer, 'Should edit preview message with final response from engine adapter');

    await core.stop();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Codex /threads and /auth align 100% with original Codex functionality and buttons, and Antigravity matches 2-row layout', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-codex-align-test-'));
  const dbPath = path.join(tempDir, 'test.db');
  const authDir = path.join(tempDir, 'auth');
  const codexHome = path.join(tempDir, 'codex');
  await fs.mkdir(authDir, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });

  // 1. Create Codex auth files
  const candName1 = '163_personal';
  const candName2 = 'GamsGo2025';
  await fs.writeFile(path.join(codexHome, `auth.json_${candName1}`), JSON.stringify({ token: 'tok_1' }));
  await fs.writeFile(path.join(codexHome, `auth.json_${candName2}`), JSON.stringify({ token: 'tok_2' }));
  const activeSymlink = path.join(codexHome, 'auth.json');
  await fs.symlink(path.join(codexHome, `auth.json_${candName1}`), activeSymlink);

  // 2. Create Codex sessions in session_index.jsonl
  const sampleThread = {
    id: 'th_sample_1',
    thread_name: 'reinstall-memo|推送已修改内容',
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), JSON.stringify(sampleThread) + '\n');

  const store = new BridgeStore(dbPath);
  const sentMessages: Array<{ scopeId: string; text: string; keyboard?: any }> = [];
  const editedMessages: Array<{ scopeId: string; messageId: number; text: string; keyboard?: any }> = [];
  const mockBotEmitter = new EventEmitter();

  const mockMessaging: any = {
    sendRichMarkdown: async (scopeId: string, text: string, keyboard?: any) => {
      sentMessages.push({ scopeId, text, keyboard });
      return 100 + sentMessages.length;
    },
    sendPlain: async (scopeId: string, text: string, keyboard?: any) => {
      sentMessages.push({ scopeId, text, keyboard });
      return 100 + sentMessages.length;
    },
    sendHtml: async (scopeId: string, text: string, keyboard?: any) => {
      sentMessages.push({ scopeId, text, keyboard });
      return 100 + sentMessages.length;
    },
    editRichMarkdown: async (scopeId: string, messageId: number, text: string, keyboard?: any) => {
      editedMessages.push({ scopeId, messageId, text, keyboard });
    },
    editPlain: async (scopeId: string, messageId: number, text: string, keyboard?: any) => {
      editedMessages.push({ scopeId, messageId, text, keyboard });
    },
    editHtml: async (scopeId: string, messageId: number, text: string, keyboard?: any) => {
      editedMessages.push({ scopeId, messageId, text, keyboard });
    },
    sendTypingInScope: async () => {},
    answerCallback: async () => {},
    deleteMessage: async () => {},
  };

  const mockBot = {
    username: 'AlignBot',
    start: async () => {},
    stop: () => {},
    on: (evt: string, fn: any) => mockBotEmitter.on(evt, fn),
    setChatCommands: async () => {},
  } as any;

  const mockCodexClient: any = new EventEmitter();
  mockCodexClient.isConnected = () => true;
  mockCodexClient.getUserAgent = () => 'test-agent';
  mockCodexClient.getServerStatus = () => ({ running: true });
  mockCodexClient.listModels = async () => [
    { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'] },
    { id: 'gpt-6-sol', displayName: 'GPT-6-Sol', isDefault: false, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];
  mockCodexClient.listThreads = async () => [
    {
      threadId: 'th_sample_1',
      name: 'reinstall-memo|推送已修改内容',
      preview: 'git push origin',
      cwd: '/home/wuya/git/reinstall-memo',
      modelProvider: 'openai',
      status: 'idle',
      archived: false,
      updatedAt: Date.now(),
    },
    {
      threadId: 'th_sample_2',
      name: 'foxden-dev|你好',
      preview: 'hello',
      cwd: '/home/wuya/git/foxden',
      modelProvider: 'openai',
      status: 'idle',
      archived: false,
      updatedAt: Date.now() - 100000,
    },
  ];
  mockCodexClient.readAccount = async () => ({
    email: 'test@example.com',
    planType: 'team',
  });
  mockCodexClient.setThreadTitle = async (threadId: string, name: string) => ({
    thread: { threadId, name, preview: '', cwd: '/tmp', modelProvider: 'openai', status: 'idle', archived: false, updatedAt: Date.now() },
  });

  const mockApp: any = {
    listModels: async () => ['gemini-3.8-flash-high'],
    executeTurn: () => ({
      conversationId: 'agy_conv',
      cancel: () => {},
      waitForResult: async () => ({ kind: 'result', status: 'SUCCESS', response: 'ok' }),
      on: () => {},
    }),
  };

  const mockConfig: Partial<AppConfig> = {
    antigravityAuthDir: authDir,
    antigravityDefaultModel: 'gemini-3.8-flash',
    defaultCwd: '/home/wuya/git/foxclaw',
    codexHome,
    codexAuthDir: codexHome,
    threadListLimit: 10,
  };

  const auth = new AntigravityAuthManager(authDir, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any);
  const core = new UnifiedBridgeCore(
    mockConfig as AppConfig,
    store,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    mockBot,
    mockApp,
    auth,
    mockMessaging,
    {
      codexApp: mockCodexClient,
      defaultBackendId: 'codex',
    },
  );

  try {
    core.registerInboundHandlers();
    await core.start();

    const scopeId = 'chat_align_test';

    // 1. In Codex mode, /threads must show 4 action buttons (✏️, 👀, 🗑️, ➕) + [➕ 新建] + [🗄️ 已归档]
    mockBotEmitter.emit('text', { scopeId, chatId: scopeId, topicId: null, chatType: 'private', userId: 'u1', messageId: 1, text: '/threads', attachments: [], entities: [], replyToBot: false });
    await new Promise((r) => setTimeout(r, 80));
    const threadsMsg = sentMessages[sentMessages.length - 1];
    assert.ok(threadsMsg, 'Should send threads message');

    // Verify 4 action buttons per thread row (✏️, 👀, 🗑️, ➕)
    const kb = threadsMsg!.keyboard;
    assert.ok(kb.some((row: any) => row.some((b: any) => b.text === '✏️' && b.callback_data.includes('thread:rename:'))), 'Must have ✏️ rename button');
    assert.ok(kb.some((row: any) => row.some((b: any) => b.text === '👀' && b.callback_data.includes('thread:watch:'))), 'Must have 👀 watch button');
    assert.ok(kb.some((row: any) => row.some((b: any) => b.text === '🗑️' && b.callback_data.includes('thread:archive:'))), 'Must have 🗑️ archive button');
    assert.ok(kb.some((row: any) => row.some((b: any) => b.text === '➕' && b.callback_data.includes('thread:new:'))), 'Must have ➕ fork/new button');

    // Verify bottom toolbar buttons
    assert.ok(kb.some((row: any) => row.some((b: any) => b.callback_data === 'thread:new')), 'Must have ➕ new button');
    assert.ok(kb.some((row: any) => row.some((b: any) => b.callback_data.includes('thread:list:'))), 'Must have thread list navigation/archive buttons');

    // 2. In Codex mode, /auth must show Quota table and candidate toggle buttons
    mockBotEmitter.emit('text', { scopeId, chatId: scopeId, topicId: null, chatType: 'private', userId: 'u1', messageId: 2, text: '/auth', attachments: [], entities: [], replyToBot: false });
    await new Promise((r) => setTimeout(r, 80));
    const authMsg = sentMessages[sentMessages.length - 1];
    assert.ok(authMsg, 'Should send auth message');

    const authKb = authMsg!.keyboard;
    // Verify candidate toggle buttons (contains auth:<localId>: or auth:filter)
    assert.ok(authKb.some((row: any) => row.some((b: any) => b.callback_data.includes('auth:'))), 'Must have auth callback buttons');
    // Verify device login button
    assert.ok(authKb.some((row: any) => row.some((b: any) => b.callback_data.includes('login_device'))), 'Must have 设备登录 button');
    // Verify safe sync button
    assert.ok(authKb.some((row: any) => row.some((b: any) => b.callback_data.includes('safe_sync'))), 'Must have 安全同步 button');

    // 3. Switch to Antigravity and verify /threads has the same 2-row layout with 4 icon buttons
    await (core as any).orchestrator.switchBackend(scopeId, 'antigravity', 'zh');
    mockBotEmitter.emit('text', { scopeId, chatId: scopeId, topicId: null, chatType: 'private', userId: 'u1', messageId: 3, text: '/threads', attachments: [], entities: [], replyToBot: false });
    await new Promise((r) => setTimeout(r, 80));
    const agyThreadsMsg = sentMessages[sentMessages.length - 1];
    assert.ok(agyThreadsMsg, 'Should send Antigravity threads message');

    await core.stop();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

