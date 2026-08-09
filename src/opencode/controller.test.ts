import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import type { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramGateway, TelegramTextEvent } from '../telegram/gateway.js';
import type { OpencodeAppClient } from './client.js';
import { OpencodeBridgeCore, permissionRules } from './controller.js';

test('OpenCode access presets map to deterministic server permission rules', () => {
  assert.deepEqual(permissionRules('default'), []);
  // Full access auto-approves asks in the bridge instead of overriding an
  // agent's explicit deny rules (notably OpenCode's Plan agent).
  assert.deepEqual(permissionRules('full-access'), []);
  assert.deepEqual(permissionRules('read-only'), [
    { permission: 'edit', pattern: '*', action: 'deny' },
    { permission: 'bash', pattern: '*', action: 'deny' },
    { permission: 'external_directory', pattern: '*', action: 'deny' },
  ]);
});

test('OpenCode bridge preserves /start, one-shot Plan, queue, and duplicate-idle behavior', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-opencode-controller-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const logger = new Logger('error', path.join(tempDir, 'foxclaw.log'));
  const app = new FakeOpencodeApp(tempDir);
  const bot = new FakeTelegramBot();
  const messaging = new FakeMessaging();
  const config = {
    defaultCwd: tempDir,
    tgAllowedChatId: null,
    tgAllowedTopicId: null,
    tgRequireExplicitGroupAddressing: false,
    telegramDeleteToolDetailsAfterFinal: true,
    threadListLimit: 10,
  } as AppConfig;
  const core = new OpencodeBridgeCore(
    config,
    store,
    logger,
    bot as unknown as TelegramGateway,
    app as unknown as OpencodeAppClient,
    messaging as unknown as TelegramMessagingPort,
  );
  const scopeId = 'telegram:bot999:123::root';
  try {
    core.registerInboundHandlers();
    await core.start();

    bot.emit('text', textEvent(scopeId, '/start', 1));
    await waitFor(() => messaging.plain.some((entry) => entry.text.includes('OpenCode 桥接命令')));
    assert.equal(app.createCalls.length, 0, '/start must remain help instead of creating a session');

    store.setChatCollaborationMode(scopeId, 'plan');
    store.setChatActiveTurnMessageMode(scopeId, 'queue');
    bot.emit('text', textEvent(scopeId, '先勘察仓库', 2));
    await waitFor(() => app.promptCalls.length === 1);
    assert.equal(app.createCalls[0]?.agent, undefined, 'one-shot Plan must not persist on session.create');
    assert.equal(app.promptCalls[0]?.agent, 'plan');
    assert.equal(store.getChatSettings(scopeId)?.collaborationMode, 'default');

    bot.emit('text', textEvent(scopeId, '再给出实现', 3));
    await waitFor(() => messaging.plain.some((entry) => entry.text.includes('已排队')));
    assert.equal(app.promptCalls.length, 1);

    app.emit('event', {
      kind: 'text', sessionId: app.session.id, messageId: 'assistant-1', partId: 'part-1', text: '勘察完成', delta: '勘察完成',
    });
    app.emit('event', { kind: 'status', sessionId: app.session.id, status: { type: 'idle' } });
    app.emit('event', { kind: 'idle', sessionId: app.session.id });
    await waitFor(() => app.promptCalls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(app.promptCalls.length, 2, 'status idle plus session idle must dequeue exactly once');

    app.emit('event', {
      kind: 'text', sessionId: app.session.id, messageId: 'assistant-2', partId: 'part-2', text: '实现完成', delta: '实现完成',
    });
    app.emit('event', { kind: 'status', sessionId: app.session.id, status: { type: 'idle' } });
    app.emit('event', { kind: 'idle', sessionId: app.session.id });
    await waitFor(() => core.activeTurnCount === 0);
    assert.deepEqual(messaging.rich.map((entry) => entry.text), ['勘察完成', '实现完成']);
  } finally {
    await core.stop().catch(() => {});
    store.close();
  }
});

class FakeOpencodeApp extends EventEmitter {
  readonly createCalls: Array<Record<string, unknown>> = [];
  readonly promptCalls: Array<Record<string, unknown>> = [];
  readonly session: Record<string, unknown>;
  private connected = false;

  constructor(directory: string) {
    super();
    this.session = {
      id: 'session-test', slug: 'session-test', title: 'Test session', directory,
      time: { created: Date.now(), updated: Date.now() },
    };
  }

  getClient(): unknown {
    return {
      session: {
        create: async (input: Record<string, unknown>) => {
          this.createCalls.push(input);
          return { data: this.session };
        },
        get: async () => ({ data: this.session }),
        promptAsync: async (input: Record<string, unknown>) => {
          this.promptCalls.push(input);
          return {};
        },
      },
    };
  }

  async start(): Promise<void> {
    this.connected = true;
    this.emit('connected');
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  async recoverPendingRequests(): Promise<void> {}
  watchSessionUntilIdle(): void {}
  isConnected(): boolean { return this.connected; }
  getServerStatus(): Record<string, unknown> {
    return { pid: 1, port: 1, running: this.connected, connected: this.connected, url: 'http://127.0.0.1:1', version: 'test', managed: true };
  }
}

class FakeTelegramBot extends EventEmitter {
  readonly identity = 'bot999';
  readonly username = 'opencode_test_bot';
  async start(): Promise<void> {}
  stop(): void {}
}

class FakeMessaging {
  readonly plain: Array<{ scopeId: string; text: string }> = [];
  readonly rich: Array<{ scopeId: string; text: string }> = [];
  private nextId = 1;

  async sendPlain(scopeId: string, text: string): Promise<number> {
    this.plain.push({ scopeId, text });
    return this.nextId++;
  }

  async sendRichMarkdown(scopeId: string, text: string): Promise<number> {
    this.rich.push({ scopeId, text });
    return this.nextId++;
  }

  async editPlain(): Promise<void> {}
  async editRichMarkdown(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async sendTypingInScope(): Promise<void> {}
}

function textEvent(scopeId: string, text: string, messageId: number): TelegramTextEvent {
  return {
    chatId: '123', topicId: null, scopeId, chatType: 'private', userId: '42', text, messageId,
    attachments: [], entities: [], replyToBot: false, languageCode: 'zh',
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}
