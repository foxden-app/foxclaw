import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config.js';
import { BridgeMessagingRouter } from '../channels/bridge_messaging_router.js';
import { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import { BridgeStore } from '../store/database.js';
import { BridgeController } from './controller.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';

const loggerStub = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

function createConfig(tempDir: string): AppConfig {
  return {
    tgBotToken: 'token',
    tgAllowedUserId: '42',
    tgAllowedChatId: null,
    tgAllowedTopicId: null,
    codexCliBin: 'codex',
    codexAppAutolaunch: false,
    codexAppLaunchCmd: 'codex app',
    codexAppSyncOnOpen: false,
    codexAppSyncOnTurnComplete: false,
    storePath: path.join(tempDir, 'bridge.sqlite'),
    logLevel: 'error',
    defaultCwd: tempDir,
    defaultApprovalPolicy: 'never',
    defaultSandboxMode: 'danger-full-access',
    telegramPollIntervalMs: 1000,
    telegramPreviewThrottleMs: 0,
    threadListLimit: 10,
    statusPath: path.join(tempDir, 'status.json'),
    logPath: path.join(tempDir, 'bridge.log'),
    lockPath: path.join(tempDir, 'bridge.lock'),
    wxEnabled: false,
    wxAllowedIlinkUserIds: [],
    weixinAccountsDir: path.join(tempDir, 'weixin', 'accounts'),
    weixinSyncBufDir: path.join(tempDir, 'weixin', 'sync-buf'),
    weixinMediaDir: path.join(tempDir, 'weixin', 'media'),
    wxIlinkRouteTag: null,
  };
}

function createEvent(text: string): TelegramTextEvent {
  return {
    chatId: '99',
    topicId: null,
    scopeId: 'telegram:99::root',
    chatType: 'private',
    userId: '42',
    text,
    messageId: 1,
    attachments: [],
    entities: [],
    replyToBot: false,
  };
}

function createWeixinEvent(text: string): TelegramTextEvent {
  return {
    chatId: 'wx-user-1',
    topicId: null,
    scopeId: 'weixin:acc1:wx-user-1',
    chatType: 'private',
    userId: 'wx-user-1',
    text,
    messageId: 1,
    attachments: [],
    entities: [],
    replyToBot: false,
  };
}

function createCallback(data: string, messageId = 1): TelegramCallbackEvent {
  return {
    chatId: '99',
    topicId: null,
    scopeId: 'telegram:99::root',
    userId: '42',
    data,
    callbackQueryId: 'callback-1',
    messageId,
  };
}

function installTempAuthFiles(t: TestContext, tempDir: string): string {
  const authDir = path.join(tempDir, '.codex');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'auth.json_a'), '{"account":"a"}');
  fs.writeFileSync(path.join(authDir, 'auth.json_b'), '{"account":"b"}');
  fs.symlinkSync(path.join(authDir, 'auth.json_a'), path.join(authDir, 'auth.json'));
  const previous = process.env.CODEX_AUTH_DIR;
  process.env.CODEX_AUTH_DIR = authDir;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CODEX_AUTH_DIR;
    } else {
      process.env.CODEX_AUTH_DIR = previous;
    }
  });
  return authDir;
}

function installTempCodexHome(t: TestContext, tempDir: string): string {
  const codexHome = path.join(tempDir, '.codex-home');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  });
  return codexHome;
}

function createControllerRig() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-controller-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const sentMessages: string[] = [];
  const sentHtmlMessages: string[] = [];
  const editedMessages: string[] = [];
  const editedHtmlMessages: string[] = [];
  const sentHtmlKeyboards: any[] = [];
  const editedHtmlKeyboards: any[] = [];
  const callbackAnswers: string[] = [];
  const deletedMessageIds: number[] = [];
  const bot = {
    sendMessage: async (_chatId: string, text: string) => {
      sentMessages.push(text);
      return sentMessages.length;
    },
    sendHtmlMessage: async (_chatId: string, text: string, keyboard?: any) => {
      sentHtmlMessages.push(text);
      sentHtmlKeyboards.push(keyboard ?? []);
      return 1000 + sentHtmlMessages.length;
    },
    editMessage: async (_chatId: string, _messageId: number, text: string) => {
      editedMessages.push(text);
    },
    editHtmlMessage: async (_chatId: string, _messageId: number, text: string, keyboard?: any) => {
      editedHtmlMessages.push(text);
      editedHtmlKeyboards.push(keyboard ?? []);
    },
    deleteMessage: async (_chatId: string, messageId: number) => {
      deletedMessageIds.push(messageId);
    },
    sendTypingInThread: async () => {},
    answerCallback: async (_callbackQueryId: string, text?: string) => {
      callbackAnswers.push(text ?? 'OK');
    },
  };
  const weixinPort = {
    sendPlain: async (_scopeId: string, text: string) => {
      sentMessages.push(text);
      return sentMessages.length;
    },
    sendHtml: async (_scopeId: string, text: string) => {
      sentHtmlMessages.push(text);
      return 1000 + sentHtmlMessages.length;
    },
    editPlain: async () => {},
    editHtml: async () => {},
    deleteMessage: async () => {},
    sendTypingInScope: async () => {},
    clearInlineKeyboard: async () => {},
    sendDraft: async () => {},
  };
  const app = {
    isConnected: () => true,
    getUserAgent: () => 'test-agent',
    restart: async () => {},
    readAccount: async () => null,
    readAccountRateLimits: async () => null,
    listModels: async () => [
      {
        id: 'model-gpt-5',
        model: 'gpt-5',
        displayName: 'GPT-5',
        description: 'Default test model',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [{ id: 'priority', name: 'fast', description: 'Fast lane' }],
      },
      {
        id: 'model-gpt-5-codex',
        model: 'gpt-5-codex',
        displayName: 'GPT-5 Codex',
        description: 'Codex test model',
        isDefault: false,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
      },
    ],
    readEffectiveConfig: async () => ({
      model: 'gpt-5.5',
      modelReasoningEffort: 'xhigh',
      planModeReasoningEffort: 'xhigh',
      developerInstructions: null,
    }),
    listCollaborationModes: async () => [
      { name: 'Plan', mode: 'plan', model: null, reasoningEffort: 'medium' },
      { name: 'Default', mode: 'default', model: null, reasoningEffort: null },
    ],
  };
  const outbound = new BridgeMessagingRouter(new TelegramMessagingPort(bot as any), weixinPort as any);
  const controller = new BridgeController(createConfig(tempDir), store, loggerStub as any, bot as any, app as any, outbound);
  (controller as any).updateStatus = () => {};
  return {
    controller,
    store,
    sentMessages,
    sentHtmlMessages,
    editedMessages,
    editedHtmlMessages,
    sentHtmlKeyboards,
    editedHtmlKeyboards,
    callbackAnswers,
    deletedMessageIds,
    tempDir,
  };
}

test('registerActiveTurn returns without waiting for turn completion', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  (rig.controller as any).queueTurnRender = async () => {};

  const pending = (rig.controller as any).registerActiveTurn('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  const result = await Promise.race([
    pending.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
  ]);

  assert.equal(result, 'resolved');
  const active = (rig.controller as any).activeTurns.get('turn-1');
  assert.ok(active);
  active.resolver();
});

test('takeover interrupts the active turn and starts a replacement turn after completion', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);
  (rig.controller as any).queuedPrompts.set('telegram:99::root', { event: createEvent('/queue later'), text: 'later' });

  const calls: string[] = [];
  (rig.controller as any).requestInterrupt = async (turn: any) => {
    calls.push(`interrupt:${turn.turnId}`);
    turn.interruptRequested = true;
    setTimeout(() => {
      turn.resolver();
      (rig.controller as any).activeTurns.delete(turn.turnId);
    }, 0);
  };
  (rig.controller as any).stopWatchingScopeThread = async (scopeId: string) => {
    calls.push(`unwatch:${scopeId}`);
  };
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => {
    calls.push(`ready:${binding.threadId}`);
    return binding;
  };
  (rig.controller as any).sendTyping = async () => {
    calls.push('typing');
  };
  (rig.controller as any).buildTurnInput = async (_binding: any, inputEvent: TelegramTextEvent) => {
    calls.push(`build:${inputEvent.text}`);
    return [{ type: 'text', text: inputEvent.text, text_elements: [] }];
  };
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any, input: Array<{ text: string }>) => {
    calls.push(`start:${binding.threadId}:${input[0]?.text}`);
    return { threadId: binding.threadId, turnId: 'turn-2' };
  };
  (rig.controller as any).registerActiveTurn = async (
    _scopeId: string,
    _chatId: string,
    _chatType: string,
    _topicId: number | null,
    threadId: string,
    turnId: string,
  ) => {
    calls.push(`register:${threadId}:${turnId}`);
  };

  await (rig.controller as any).handleCommand(createEvent('/takeover ship it'), 'en', 'takeover', ['ship', 'it']);

  assert.equal((rig.controller as any).queuedPrompts.size, 0);
  assert.deepEqual(calls, [
    'interrupt:turn-1',
    'unwatch:telegram:99::root',
    'ready:thread-1',
    'typing',
    'build:ship it',
    'start:thread-1:ship it',
    'register:thread-1:turn-2',
  ]);
  assert.ok(rig.sentMessages.includes('Interrupt requested. Waiting for Codex to stop...'));
});

test('queue stores the next prompt while a turn is active', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleCommand(createEvent('/queue first'), 'en', 'queue', ['first']);
  assert.equal((rig.controller as any).queuedPrompts.get('telegram:99::root')?.text, 'first');
  assert.equal(rig.sentMessages[0], 'Queued. I will send it after the current turn finishes.');

  await (rig.controller as any).handleCommand(createEvent('/queue second'), 'en', 'queue', ['second']);
  assert.equal((rig.controller as any).queuedPrompts.get('telegram:99::root')?.text, 'second');
  assert.equal(rig.sentMessages[1], 'Replaced the queued prompt. I will send the new one after the current turn finishes.');
});

test('/mode opens setup panel, while /mode <value> updates collaboration mode settings', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCommand(createEvent('/mode'), 'en', 'mode', []);
  assert.match(rig.sentHtmlMessages[0]!, /<b>Session preferences<\/b>/);
  assert.match(rig.sentHtmlMessages[0]!, /Focus: Mode/);

  await (rig.controller as any).handleCommand(createEvent('/mode plan'), 'en', 'mode', ['plan']);
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.collaborationMode, 'plan');
  assert.equal(rig.sentMessages[0], 'Mode set to: Plan\nApplies on the next turn.');

  await (rig.controller as any).handleCommand(createEvent('/agent'), 'en', 'agent', []);
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.collaborationMode, 'plan');
  assert.match(rig.sentHtmlMessages[1]!, /Focus: Mode/);
});

test('startTurnWithRecovery passes native Codex collaboration mode', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setChatCollaborationMode('telegram:99::root', 'plan');
  const calls: any[] = [];
  (rig.controller as any).app.startTurn = async (options: any) => {
    calls.push(options);
    return { id: 'turn-1', status: 'running' };
  };

  await (rig.controller as any).startTurnWithRecovery(
    'telegram:99::root',
    { threadId: 'thread-1', cwd: rig.tempDir },
    [{ type: 'text', text: 'hi', text_elements: [] }],
  );

  assert.deepEqual(calls[0]?.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      developer_instructions: null,
    },
  });
});

test('startTurnWithRecovery passes supported service tier and clears unsupported one', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const calls: any[] = [];
  (rig.controller as any).app.startTurn = async (options: any) => {
    calls.push(options);
    return { id: `turn-${calls.length}`, status: 'running' };
  };

  rig.store.setChatSettings('telegram:99::root', 'gpt-5', 'high');
  rig.store.setChatServiceTier('telegram:99::root', 'priority');
  await (rig.controller as any).startTurnWithRecovery(
    'telegram:99::root',
    { threadId: 'thread-1', cwd: rig.tempDir },
    [{ type: 'text', text: 'hi', text_elements: [] }],
  );
  assert.equal(calls[0]?.serviceTier, 'priority');

  rig.store.setChatSettings('telegram:99::root', 'gpt-5-codex', 'high');
  rig.store.setChatServiceTier('telegram:99::root', 'priority');
  await (rig.controller as any).startTurnWithRecovery(
    'telegram:99::root',
    { threadId: 'thread-1', cwd: rig.tempDir },
    [{ type: 'text', text: 'hi again', text_elements: [] }],
  );
  assert.equal(calls[1]?.serviceTier, null);
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.serviceTier, null);
  assert.ok(rig.sentMessages.includes('Fast was turned off because the selected model does not support it.'));
});

test('/setup and legacy aliases open the unified setup panel', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCommand(createEvent('/setup'), 'en', 'setup', []);
  assert.match(rig.sentHtmlMessages[0]!, /<b>Session preferences<\/b>/);
  assert.match(rig.sentHtmlMessages[0]!, /Current: <b>server default · server default · fast=off · default · default<\/b>/);
  assert.ok(rig.sentHtmlKeyboards[0].some((row: any[]) => row.some((button: any) => button.callback_data === 'setup:fast:on')));

  await (rig.controller as any).handleCommand(createEvent('/models'), 'en', 'models', []);
  assert.match(rig.sentHtmlMessages[1]!, /Focus: Model/);

  await (rig.controller as any).handleCommand(createEvent('/permissions'), 'en', 'permissions', []);
  assert.match(rig.sentHtmlMessages[2]!, /Focus: Access/);
});

test('/fast persists priority when supported and rejects unsupported models', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCommand(createEvent('/fast on'), 'en', 'fast', ['on']);
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.serviceTier, 'priority');
  assert.match(rig.sentHtmlMessages[0]!, /Focus: Fast/);
  assert.match(rig.sentHtmlMessages[0]!, /fast=on/);

  (rig.controller as any).app.listModels = async () => [
    {
      id: 'model-no-fast',
      model: 'no-fast',
      displayName: 'No Fast',
      description: '',
      isDefault: true,
      supportedReasoningEfforts: ['medium'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    },
  ];
  rig.store.setChatServiceTier('telegram:99::root', null);
  await (rig.controller as any).handleCommand(createEvent('/fast on'), 'en', 'fast', ['on']);
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.serviceTier, null);
  assert.equal(rig.sentMessages.at(-1), 'Current model does not support Fast.');
});

test('setup callbacks update settings and preserve settings:* back-compat', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCallback(createCallback('setup:fast:on', 10));
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.serviceTier, 'priority');
  assert.equal(rig.callbackAnswers[0], 'Fast: on (fast)');
  assert.match(rig.editedHtmlMessages[0]!, /Focus: Fast/);

  await (rig.controller as any).handleCallback(createCallback('settings:access:read-only', 11));
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.accessPreset, 'read-only');
  assert.equal(rig.callbackAnswers[1], 'Access: Read-only');
  assert.match(rig.editedHtmlMessages[1]!, /Focus: Access/);
});

test('setup model callbacks are blocked while a turn is active but access still applies', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleCallback(createCallback('setup:model:gpt-5-codex', 10));
  assert.equal(rig.callbackAnswers[0], 'Wait for the current turn to finish');
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.model ?? null, null);

  await (rig.controller as any).handleCallback(createCallback('setup:access:full-access', 10));
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.accessPreset, 'full-access');
  assert.equal(rig.callbackAnswers[1], 'Access: Full access');
});

test('/status includes Codex account usage without exposing email', async (t) => {
  const rig = createControllerRig();
  installTempCodexHome(t, rig.tempDir);
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  (rig.controller as any).app.readAccount = async () => ({
    type: 'chatgpt',
    email: 'user@example.com',
    planType: 'plus',
    requiresOpenaiAuth: false,
  });
  (rig.controller as any).app.readAccountRateLimits = async () => ({
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 63, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 56.5, windowDurationMins: 10080, resetsAt: null },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  });

  await (rig.controller as any).handleCommand(createEvent('/status'), 'en', 'status', []);

  assert.equal(rig.sentMessages.length, 1);
  assert.match(rig.sentMessages[0]!, /Codex account: ChatGPT/);
  assert.match(rig.sentMessages[0]!, /Codex plan: Plus/);
  assert.match(rig.sentMessages[0]!, /Codex usage \(codex\):/);
  assert.match(rig.sentMessages[0]!, /5h window: 63% used/);
  assert.match(rig.sentMessages[0]!, /7d window: 56.5% used/);
  assert.doesNotMatch(rig.sentMessages[0]!, /user@example\.com/);
});

test('/status includes local Codex token history from session logs', async (t) => {
  const rig = createControllerRig();
  const codexHome = installTempCodexHome(t, rig.tempDir);
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '09');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'rollout-a.jsonl'), [
    JSON.stringify({
      payload: {
        turn_id: 'turn-a',
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 1,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: 12,
          },
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 1,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: 12,
          },
        },
      },
    }),
    JSON.stringify({
      payload: {
        turn_id: 'turn-a',
        info: {
          last_token_usage: {
            input_tokens: 20,
            cached_input_tokens: 3,
            output_tokens: 5,
            reasoning_output_tokens: 2,
            total_tokens: 25,
          },
          total_token_usage: {
            input_tokens: 30,
            cached_input_tokens: 4,
            output_tokens: 7,
            reasoning_output_tokens: 3,
            total_tokens: 37,
          },
        },
      },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionDir, 'rollout-b.jsonl'), `${JSON.stringify({
    payload: {
      turn_id: 'turn-b',
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: 110,
        },
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 4,
          total_tokens: 110,
        },
      },
    },
  })}\n`);

  await (rig.controller as any).handleCommand(createEvent('/status'), 'en', 'status', []);

  assert.match(rig.sentMessages[0]!, /Codex local history: 2 sessions, 2 turns, 3 usage records/);
  assert.match(
    rig.sentMessages[0]!,
    /Codex local tokens: total 147; input 130, output 17, cached input 24, reasoning output 7/,
  );
});

test('/auth_reload restarts Codex app-server and reports refreshed usage', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async () => ({
    type: 'chatgpt',
    email: 'user@example.com',
    planType: 'team',
    requiresOpenaiAuth: false,
  });
  (rig.controller as any).app.readAccountRateLimits = async () => null;

  await (rig.controller as any).handleCommand(createEvent('/auth_reload'), 'en', 'auth_reload', []);

  assert.equal(restarts, 1);
  assert.equal(rig.sentMessages[0], 'Restarting Codex app-server to reload auth...');
  assert.match(rig.sentMessages[1]!, /Codex app-server restarted/);
  assert.match(rig.sentMessages[1]!, /Codex account: ChatGPT/);
  assert.match(rig.sentMessages[1]!, /Codex usage: unavailable/);
});

test('/auth_reload is blocked while a turn is active', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleCommand(createEvent('/auth_reload'), 'en', 'auth_reload', []);

  assert.equal(restarts, 0);
  assert.equal(
    rig.sentMessages[0],
    'Cannot reload Codex auth while a turn, approval, or question is active. Wait or use /interrupt first.',
  );
});

test('/auth lists candidates and switches auth via callback', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.match(rig.sentMessages[0]!, /Codex auth files:/);
  assert.match(rig.sentMessages[0]!, /auth\.json_a \*/);
  assert.match(rig.sentMessages[0]!, /auth\.json_b/);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:1`, 1));

  assert.equal(restarts, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_b'));
  assert.equal(rig.callbackAnswers[0], 'Auth selected');
  assert.match(rig.editedMessages[0]!, /Switching Codex auth to auth\.json_b/);
  assert.match(rig.sentMessages.at(-1)!, /Codex auth switched to auth\.json_b/);
});

test('usage limit errors auto-rotate auth after the active turn finishes', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);

  let restarts = 0;
  const retryStarts: any[] = [];
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any, input: any[]) => {
    retryStarts.push({ binding, input });
    return { threadId: binding.threadId, turnId: 'turn-2' };
  };
  (rig.controller as any).queueTurnRender = async () => {};
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  active.authRetry = {
    input: [{ type: 'text', text: 'try this', text_elements: [] }],
    threadId: 'thread-1',
    cwd: rig.tempDir,
    chatId: '99',
    chatType: 'private',
    topicId: null,
    failedAuthTargets: new Set(),
  };
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: { message: 'Usage limit exceeded', codexErrorInfo: 'usageLimitExceeded' },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  });
  assert.equal(restarts, 0);

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.equal(restarts, 1);
  assert.deepEqual(retryStarts, [{
    binding: { threadId: 'thread-1', cwd: rig.tempDir },
    input: [{ type: 'text', text: 'try this', text_elements: [] }],
  }]);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_b'));
  assert.ok(rig.sentMessages.some(message => /Auto-switched Codex auth to auth\.json_b/.test(message)));
  assert.ok(rig.sentMessages.includes('Retrying the same request with the new auth...'));
  assert.ok((rig.controller as any).activeTurns.has('turn-2'));

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: { message: 'Usage limit exceeded again', codexErrorInfo: 'usageLimitExceeded' },
      threadId: 'thread-1',
      turnId: 'turn-2',
      willRetry: false,
    },
  });
  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-2',
    state: 'completed',
  });

  assert.equal(restarts, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_b'));
  assert.ok(rig.sentMessages.some(message => /no unused auth candidate is available/.test(message)));
});

test('Codex error notifications are shown on the active Telegram turn', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: { message: 'Usage limit exceeded', codexErrorInfo: 'usageLimitExceeded' },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  });

  assert.ok(rig.sentMessages.includes('Codex error: Usage limit exceeded'));
});

test('requestUserInput is bridged through Telegram callbacks', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  const responses: any[] = [];
  (rig.controller as any).app.respond = async (requestId: string, result: unknown) => {
    responses.push({ requestId, result });
  };

  await (rig.controller as any).handleServerRequest({
    id: 'request-1',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      questions: [{
        id: 'confirm',
        header: 'Continue?',
        question: 'Apply the plan?',
        options: [
          { label: 'Yes', description: 'Implement now' },
          { label: 'No', description: 'Stop here' },
        ],
      }],
    },
  });

  const pending = [...(rig.controller as any).pendingUserInputs.values()][0];
  assert.ok(pending);
  assert.match(rig.sentMessages[0]!, /Codex needs input:/);

  await (rig.controller as any).handleCallback(createCallback(`ui:${pending.localId}:0:0`, 1));

  assert.deepEqual(responses, [{
    requestId: 'request-1',
    result: { answers: { confirm: 'Yes' } },
  }]);
  assert.equal(rig.callbackAnswers[0], 'Answer recorded');
  assert.match(rig.editedMessages[0]!, /Submitted to Codex\./);
});

test('completed turns automatically start a queued prompt', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);
  (rig.controller as any).queuedPrompts.set('telegram:99::root', {
    event: createEvent('/queue continue'),
    text: 'continue',
  });
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};

  const started: Array<{ text: string; locale: string }> = [];
  (rig.controller as any).startBoundTurnFromEvent = async (_event: TelegramTextEvent, locale: string, text: string) => {
    started.push({ locale, text });
  };

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.deepEqual(started, [{ locale: 'en', text: 'continue' }]);
  assert.equal((rig.controller as any).queuedPrompts.size, 0);
  assert.equal((rig.controller as any).activeTurns.size, 0);
});

test('watch relay sends codex cli user messages as prefixed telegram messages', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0, true);
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'user_message',
    turnId: 'turn-1',
    text: 'OK <check>',
  });

  assert.equal(rig.sentMessages.length, 0);
  assert.deepEqual(rig.sentHtmlMessages, [
    '<b>codex-cli-user</b>\n<pre>OK &lt;check&gt;</pre>',
  ]);
});

test('observed turns delete commentary and archived status messages after a final reply arrives', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0, true);
  active.finalText = 'done';
  active.segments = [
    {
      itemId: 'commentary-1',
      phase: 'commentary',
      outputKind: 'commentary',
      text: 'thinking',
      completed: true,
      messages: [{ messageId: 11, text: 'thinking' }],
    },
    {
      itemId: 'final-1',
      phase: 'final_answer',
      outputKind: 'final_answer',
      text: 'done',
      completed: true,
      messages: [{ messageId: 22, text: 'done' }],
    },
  ];
  active.archivedMessageIds = [33];
  (rig.controller as any).activeTurns.set('turn-1', active);
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.deepEqual(rig.deletedMessageIds, [11, 33]);
});

test('unwatch stops the current watcher and reports when nothing is being watched', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  (rig.controller as any).observedThreadWatchers.set('telegram:99::root', {
    scopeId: 'telegram:99::root',
    chatId: '99',
    chatType: 'private',
    topicId: null,
    threadId: 'thread-1',
    mode: 'session_file',
    timer: null,
    cursor: null,
    activeTurnId: null,
    waitingOnApproval: false,
    sessionPath: null,
    sessionOffset: -1,
    sessionRemainder: '',
    sessionCursor: { activeTurnId: null, nextMessageIndex: 0 },
    stopped: false,
  });

  await (rig.controller as any).handleCommand(createEvent('/unwatch'), 'en', 'unwatch', []);
  assert.equal((rig.controller as any).observedThreadWatchers.size, 0);
  assert.equal(rig.sentMessages[0], 'Stopped watching thread thread-1.');

  await (rig.controller as any).handleCommand(createEvent('/unwatch'), 'en', 'unwatch', []);
  assert.equal(rig.sentMessages[1], 'This chat is not watching any thread.');
});

test('weixin queue works like Telegram when a turn is active', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState(
    'weixin:acc1:wx-user-1',
    'wx-user-1',
    'private',
    null,
    'thread-1',
    'turn-1',
    0,
  );
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleCommand(createWeixinEvent('/queue next'), 'en', 'queue', ['next']);
  assert.equal((rig.controller as any).queuedPrompts.get('weixin:acc1:wx-user-1')?.text, 'next');
});

test('weixin takeover runs the same path as Telegram', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('weixin:acc1:wx-user-1', 'thread-1', rig.tempDir);
  const active = (rig.controller as any).createActiveTurnState(
    'weixin:acc1:wx-user-1',
    'wx-user-1',
    'private',
    null,
    'thread-1',
    'turn-1',
    0,
  );
  (rig.controller as any).activeTurns.set('turn-1', active);

  const calls: string[] = [];
  (rig.controller as any).requestInterrupt = async (turn: any) => {
    calls.push(`interrupt:${turn.turnId}`);
    turn.interruptRequested = true;
    setTimeout(() => {
      turn.resolver();
      (rig.controller as any).activeTurns.delete(turn.turnId);
    }, 0);
  };
  (rig.controller as any).stopWatchingScopeThread = async (scopeId: string) => {
    calls.push(`unwatch:${scopeId}`);
  };
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => {
    calls.push(`ready:${binding.threadId}`);
    return binding;
  };
  (rig.controller as any).sendTyping = async () => {
    calls.push('typing');
  };
  (rig.controller as any).buildTurnInput = async (_binding: any, inputEvent: TelegramTextEvent) => {
    calls.push(`build:${inputEvent.text}`);
    return [{ type: 'text', text: inputEvent.text, text_elements: [] }];
  };
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any, input: Array<{ text: string }>) => {
    calls.push(`start:${binding.threadId}:${input[0]?.text}`);
    return { threadId: binding.threadId, turnId: 'turn-2' };
  };
  (rig.controller as any).registerActiveTurn = async () => {
    calls.push('register');
  };

  await (rig.controller as any).handleCommand(createWeixinEvent('/takeover go'), 'en', 'takeover', ['go']);

  assert.ok(calls.includes('interrupt:turn-1'));
  assert.ok(calls.includes('unwatch:weixin:acc1:wx-user-1'));
});

test('weixin /permissions full-access persists access preset', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const scope = 'weixin:acc1:wx-user-1';
  await (rig.controller as any).handleCommand(createWeixinEvent('/permissions full-access'), 'en', 'permissions', [
    'full-access',
  ]);
  assert.equal(rig.store.getChatSettings(scope)?.accessPreset, 'full-access');
  assert.ok(rig.sentMessages.some((m) => /full access/i.test(m)));
});

test('weixin /threads HTML message includes copy-paste /open lines', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  (rig.controller as any).app.listThreads = async () => [
    {
      threadId: 't-wx-1',
      name: 'Wx thread',
      preview: 'hello',
      cwd: rig.tempDir,
      modelProvider: 'openai',
      source: 'cli',
      path: path.join(rig.tempDir, 't.jsonl'),
      status: 'idle',
      updatedAt: Math.floor(Date.now() / 1000),
    },
  ];

  await (rig.controller as any).handleText(createWeixinEvent('/threads'));

  assert.equal(rig.sentHtmlMessages.length, 1);
  const html = rig.sentHtmlMessages[0];
  assert.ok(html);
  assert.match(html, /\/open 1/);
  assert.match(html, /Copy-paste \(WeChat\):/);
});
