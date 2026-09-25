import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AntigravityBridgeCore } from './controller.js';
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
