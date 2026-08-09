import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import type { InlineKeyboard, TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent, TelegramGateway, TelegramTextEvent } from '../telegram/gateway.js';
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

test('OpenCode stream flushes are serialized while Telegram sends are still pending', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-opencode-stream-'));
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
    config, store, logger, bot as unknown as TelegramGateway,
    app as unknown as OpencodeAppClient, messaging as unknown as TelegramMessagingPort,
  );
  const scopeId = 'telegram:bot999:456::root';
  try {
    core.registerInboundHandlers();
    await core.start();
    bot.emit('text', textEvent(scopeId, '当前工作目录是？', 1));
    await waitFor(() => app.promptCalls.length === 1);
    const baseline = messaging.plain.length;
    messaging.sendDelayMs = 40;

    app.emit('event', {
      kind: 'text', sessionId: app.session.id, messageId: 'assistant-stream', partId: 'part-stream', text: '/home', delta: '/home',
    });
    await waitFor(() => messaging.plain.length === baseline + 1);
    app.emit('event', {
      kind: 'text', sessionId: app.session.id, messageId: 'assistant-stream', partId: 'part-stream', text: '/home/wuya/g', delta: '/wuya/g',
    });
    await delay(5);
    app.emit('event', {
      kind: 'text', sessionId: app.session.id, messageId: 'assistant-stream', partId: 'part-stream', text: '/home/wuya/git/Podcast', delta: 'it/Podcast',
    });
    await delay(5);
    app.emit('event', { kind: 'idle', sessionId: app.session.id });

    await waitFor(() => core.activeTurnCount === 0);
    assert.equal(messaging.plain.length, baseline + 1, 'one stream must create exactly one Telegram message');
    assert.equal(messaging.richEdits.at(-1)?.text, '/home/wuya/git/Podcast');
  } finally {
    await core.stop().catch(() => {});
    store.close();
  }
});

test('OpenCode /models is two-level and /setup callbacks edit the same panel', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-opencode-setup-'));
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
    config, store, logger, bot as unknown as TelegramGateway,
    app as unknown as OpencodeAppClient, messaging as unknown as TelegramMessagingPort,
  );
  const scopeId = 'telegram:bot999:789::root';
  try {
    core.registerInboundHandlers();
    await core.start();

    bot.emit('text', textEvent(scopeId, '/models', 1));
    await waitFor(() => messaging.plain.some((entry) => entry.text.includes('选择模型 Provider')));
    const providersPanel = messaging.plain.at(-1)!;
    assert.doesNotMatch(providersPanel.text, /Alpha Large/);
    const providerButton = providersPanel.keyboard?.flat().find((button) => button.text.includes('Provider Alpha'));
    assert.ok(providerButton, 'provider must be the first selection level');

    bot.emit('callback', callbackEvent(scopeId, providerButton.callback_data, providersPanel.messageId, 'provider'));
    await waitFor(() => messaging.plainEdits.some((entry) => entry.messageId === providersPanel.messageId && entry.text.includes('Provider Alpha')));
    const modelsPanel = messaging.plainEdits.at(-1)!;
    const modelButton = modelsPanel.keyboard?.flat().find((button) => button.text.includes('Alpha Large'));
    assert.ok(modelButton, 'model must be selected on the second level');

    bot.emit('callback', callbackEvent(scopeId, modelButton.callback_data, providersPanel.messageId, 'model'));
    await waitFor(() => store.getChatSettings(scopeId)?.model === 'alpha::alpha-large');
    assert.equal(messaging.plainEdits.at(-1)?.messageId, providersPanel.messageId);

    bot.emit('text', textEvent(scopeId, '/setup', 2));
    await waitFor(() => messaging.plain.some((entry) => entry.text.includes('⚙️ OpenCode 设置')));
    const setupPanel = messaging.plain.at(-1)!;
    const beforeClickMessages = messaging.plain.length;
    const fullAccessButton = setupPanel.keyboard?.flat().find((button) => button.text.includes('full-access'));
    assert.ok(fullAccessButton);
    bot.emit('callback', callbackEvent(scopeId, fullAccessButton.callback_data, setupPanel.messageId, 'access'));
    await waitFor(() => store.getChatSettings(scopeId)?.accessPreset === 'full-access');
    await waitFor(() => messaging.plainEdits.some((entry) => entry.messageId === setupPanel.messageId && entry.text.includes('full-access')));
    assert.equal(messaging.plain.length, beforeClickMessages, 'setup selection must not send a separate confirmation message');
  } finally {
    await core.stop().catch(() => {});
    store.close();
  }
});

test('OpenCode exposes native undo, redo, review, and archive semantics', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-opencode-native-'));
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
    config, store, logger, bot as unknown as TelegramGateway,
    app as unknown as OpencodeAppClient, messaging as unknown as TelegramMessagingPort,
  );
  const scopeId = 'telegram:bot999:987::root';
  try {
    core.registerInboundHandlers();
    await core.start();
    bot.emit('text', textEvent(scopeId, '先完成一个任务', 1));
    await waitFor(() => app.promptCalls.length === 1);
    app.emit('event', { kind: 'idle', sessionId: app.session.id });
    await waitFor(() => core.activeTurnCount === 0);

    bot.emit('text', textEvent(scopeId, '/undo', 2));
    await waitFor(() => app.revertCalls.length === 1);
    assert.equal(app.revertCalls[0]?.messageID, 'user-1');

    bot.emit('text', textEvent(scopeId, '/redo', 3));
    await waitFor(() => app.unrevertCalls.length === 1);

    bot.emit('text', textEvent(scopeId, '/review branch main', 4));
    await waitFor(() => app.commandCalls.length === 1);
    assert.equal(app.commandCalls[0]?.command, 'review');
    assert.equal(app.commandCalls[0]?.arguments, 'branch main');
    assert.equal(core.activeTurnCount, 1);
    app.emit('event', {
      kind: 'text', sessionId: app.session.id, messageId: 'review-answer', partId: 'review-part', text: '审查完成', delta: '审查完成',
    });
    app.emit('event', { kind: 'idle', sessionId: app.session.id });
    await waitFor(() => core.activeTurnCount === 0);

    bot.emit('text', textEvent(scopeId, '/archive', 5));
    await waitFor(() => store.getBinding(scopeId) === null);
    assert.ok(Number((app.updateCalls.at(-1)?.time as { archived?: number } | undefined)?.archived) > 0);

    bot.emit('text', textEvent(scopeId, '/threads archived', 6));
    await waitFor(() => store.getCachedThread(scopeId, 1)?.archived === true);
    bot.emit('text', textEvent(scopeId, '/unarchive 1', 7));
    await waitFor(() => store.getBinding(scopeId)?.threadId === app.session.id);
    assert.equal((app.updateCalls.at(-1)?.time as { archived?: number } | undefined)?.archived, 0);
  } finally {
    await core.stop().catch(() => {});
    store.close();
  }
});

class FakeOpencodeApp extends EventEmitter {
  readonly createCalls: Array<Record<string, unknown>> = [];
  readonly promptCalls: Array<Record<string, unknown>> = [];
  readonly commandCalls: Array<Record<string, unknown>> = [];
  readonly revertCalls: Array<Record<string, unknown>> = [];
  readonly unrevertCalls: Array<Record<string, unknown>> = [];
  readonly updateCalls: Array<Record<string, unknown>> = [];
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
        update: async (input: Record<string, unknown>) => {
          this.updateCalls.push(input);
          const time = input.time as { archived?: number } | undefined;
          if (time && typeof time.archived === 'number') {
            (this.session.time as Record<string, unknown>).archived = time.archived;
          }
          return { data: this.session };
        },
        abort: async () => ({ data: true }),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [
          { info: { id: 'user-1', role: 'user' }, parts: [{ type: 'text', text: '先完成一个任务' }] },
          { info: { id: 'assistant-1', role: 'assistant' }, parts: [{ type: 'text', text: '已完成' }] },
        ] }),
        revert: async (input: Record<string, unknown>) => {
          this.revertCalls.push(input);
          this.session.revert = { messageID: input.messageID };
          return { data: this.session };
        },
        unrevert: async (input: Record<string, unknown>) => {
          this.unrevertCalls.push(input);
          delete this.session.revert;
          return { data: this.session };
        },
        command: async (input: Record<string, unknown>) => {
          this.commandCalls.push(input);
          return {};
        },
      },
      provider: {
        list: async () => ({
          data: {
            connected: ['alpha', 'beta'],
            default: { alpha: 'alpha-large', beta: 'beta-fast' },
            all: [
              {
                id: 'alpha', name: 'Provider Alpha',
                models: {
                  'alpha-large': { id: 'alpha-large', name: 'Alpha Large', variants: { medium: {}, high: {} } },
                  'alpha-small': { id: 'alpha-small', name: 'Alpha Small', variants: {} },
                },
              },
              {
                id: 'beta', name: 'Provider Beta',
                models: { 'beta-fast': { id: 'beta-fast', name: 'Beta Fast', variants: { high: {} } } },
              },
            ],
          },
        }),
      },
      app: {
        agents: async () => ({ data: [
          { name: 'build', mode: 'primary', hidden: false, description: 'Build agent' },
          { name: 'plan', mode: 'primary', hidden: false, description: 'Plan agent' },
        ] }),
      },
      experimental: {
        session: {
          list: async (input: Record<string, unknown> = {}) => {
            const archived = Boolean((this.session.time as Record<string, unknown>).archived);
            return { data: input.archived ? (archived ? [this.session] : []) : (archived ? [] : [this.session]) };
          },
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
  readonly plain: Array<{ scopeId: string; text: string; messageId: number; keyboard?: InlineKeyboard }> = [];
  readonly rich: Array<{ scopeId: string; text: string; messageId: number }> = [];
  readonly plainEdits: Array<{ scopeId: string; text: string; messageId: number; keyboard?: InlineKeyboard }> = [];
  readonly richEdits: Array<{ scopeId: string; text: string; messageId: number }> = [];
  readonly callbackAnswers: string[] = [];
  private nextId = 1;

  constructor(public sendDelayMs = 0) {}

  async sendPlain(scopeId: string, text: string, keyboard?: InlineKeyboard): Promise<number> {
    const messageId = this.nextId++;
    this.plain.push({ scopeId, text, messageId, ...(keyboard ? { keyboard } : {}) });
    if (this.sendDelayMs > 0) await delay(this.sendDelayMs);
    return messageId;
  }

  async sendRichMarkdown(scopeId: string, text: string): Promise<number> {
    const messageId = this.nextId++;
    this.rich.push({ scopeId, text, messageId });
    return messageId;
  }

  async editPlain(scopeId: string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    this.plainEdits.push({ scopeId, messageId, text, ...(keyboard ? { keyboard } : {}) });
  }
  async editRichMarkdown(scopeId: string, messageId: number, text: string): Promise<void> {
    this.richEdits.push({ scopeId, messageId, text });
  }
  async deleteMessage(): Promise<void> {}
  async sendTypingInScope(): Promise<void> {}
  async answerCallback(_callbackQueryId: string, text: string): Promise<void> { this.callbackAnswers.push(text); }
}

function textEvent(scopeId: string, text: string, messageId: number): TelegramTextEvent {
  return {
    chatId: '123', topicId: null, scopeId, chatType: 'private', userId: '42', text, messageId,
    attachments: [], entities: [], replyToBot: false, languageCode: 'zh',
  };
}

function callbackEvent(scopeId: string, data: string, messageId: number, suffix: string): TelegramCallbackEvent {
  return {
    chatId: '123', topicId: null, scopeId, userId: '42', data, messageId,
    callbackQueryId: `callback-${suffix}`, languageCode: 'zh',
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
