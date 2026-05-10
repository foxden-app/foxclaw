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
    codexAppServerStatePath: path.join(tempDir, 'codex-app-server.json'),
    codexAppServerLogPath: path.join(tempDir, 'codex-app-server.log'),
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
    stop: () => {},
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
    getServerStatus: () => ({ pid: null, port: null, running: false, managed: false }),
    stop: async () => {},
    restart: async () => {},
    readAccount: async () => null,
    readAccountRateLimits: async () => null,
    readThread: async (threadId: string) => ({
      threadId,
      name: null,
      preview: 'thread',
      cwd: tempDir,
      modelProvider: 'openai',
      source: 'app',
      path: null,
      status: 'idle',
      updatedAt: 1,
    }),
    readThreadSnapshot: async () => null,
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
    steerTurn: async () => ({ turnId: 'turn-1' }),
    startDeviceLogin: async () => ({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.example/device',
      userCode: 'ABCD-1234',
    }),
    cancelLogin: async () => {},
    logoutAccount: async () => {},
    sendAddCreditsNudgeEmail: async () => {},
    forkThread: async () => ({
      thread: {
        threadId: 'thread-fork',
        name: null,
        preview: 'fork',
        cwd: tempDir,
        modelProvider: 'openai',
        source: 'app',
        path: null,
        status: 'idle',
        updatedAt: 1,
      },
      model: 'gpt-5',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      cwd: tempDir,
    }),
    rollbackThread: async () => null,
    setThreadName: async () => {},
    compactThread: async () => {},
    getThreadGoal: async () => null,
    setThreadGoal: async (options: any) => ({
      threadId: options.threadId,
      objective: options.objective ?? 'ship it',
      status: options.status ?? 'active',
      tokenBudget: options.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    }),
    clearThreadGoal: async () => true,
    listThreadTurns: async () => [],
    archiveThread: async () => {},
    unarchiveThread: async () => null,
    startReview: async () => ({ turnId: 'turn-review', reviewThreadId: 'thread-1' }),
    listLoadedThreads: async () => [],
    listSkills: async () => [],
    writeSkillConfig: async () => {},
    listHooks: async () => [],
    listPlugins: async () => [],
    readPlugin: async () => null,
    readPluginSkill: async () => null,
    listApps: async () => [],
    readConfig: async () => ({ config: {}, layers: [], origins: {} }),
    readConfigRequirements: async () => null,
    listExperimentalFeatures: async () => [],
    readModelProviderCapabilities: async () => ({ webSearch: false, imageGeneration: false, namespaceTools: false }),
    fuzzyFileSearch: async () => [],
    listMcpServerStatus: async () => [],
    reloadMcpServers: async () => {},
    loginMcpServer: async () => 'https://mcp.example/auth',
    readMcpResource: async () => [],
    respond: async () => {},
    respondError: async () => {},
    interruptTurn: async () => {},
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

test('plain messages during active turns steer by default or queue by chat setting', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  (rig.controller as any).queueTurnRender = async () => {};
  const steers: any[] = [];
  (rig.controller as any).app.steerTurn = async (threadId: string, turnId: string, input: any[]) => {
    steers.push({ threadId, turnId, input });
    return { turnId };
  };

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);
  await (rig.controller as any).handleText(createEvent('please adjust'));

  assert.equal(steers.length, 1);
  assert.equal(steers[0]?.input[0]?.text, 'please adjust');
  assert.equal(rig.sentMessages.at(-1), 'Steered active turn turn-1.');

  rig.store.setChatActiveTurnMessageMode('telegram:99::root', 'queue');
  await (rig.controller as any).handleText(createEvent('next after this'));

  assert.equal(steers.length, 1);
  assert.equal((rig.controller as any).queuedPrompts.get('telegram:99::root')?.text, 'next after this');
  assert.equal(rig.sentMessages.at(-1), 'Queued. I will send it after the current turn finishes.');
});

test('/active configures active-turn message behavior and opens setup focus', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCommand(createEvent('/active queue'), 'en', 'active', ['queue']);
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.activeTurnMessageMode, 'queue');
  assert.equal(rig.sentMessages[0], 'Active-turn messages set to: Queue next turn');

  await (rig.controller as any).handleCommand(createEvent('/active'), 'en', 'active', []);
  assert.match(rig.sentHtmlMessages[0]!, /Focus: Active turn messages/);

  await (rig.controller as any).handleCallback(createCallback('setup:active:steer', 10));
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.activeTurnMessageMode, 'steer');
  assert.equal(rig.callbackAnswers[0], 'Active-turn messages set to: Steer current turn');
});

test('goal, history, and files commands bridge experimental read/manage APIs', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  const goalCalls: any[] = [];
  (rig.controller as any).app.getThreadGoal = async () => ({
    threadId: 'thread-1',
    objective: 'Reduce latency',
    status: 'active',
    tokenBudget: 200000,
    tokensUsed: 1200,
    timeUsedSeconds: 60,
    createdAt: 1,
    updatedAt: 1,
  });
  (rig.controller as any).app.setThreadGoal = async (options: any) => {
    goalCalls.push(options);
    return {
      threadId: options.threadId,
      objective: options.objective ?? 'Reduce latency',
      status: options.status ?? 'active',
      tokenBudget: options.tokenBudget ?? 200000,
      tokensUsed: 1200,
      timeUsedSeconds: 60,
      createdAt: 1,
      updatedAt: 1,
    };
  };
  (rig.controller as any).app.listThreadTurns = async () => [
    {
      turnId: 'turn-2',
      status: 'completed',
      error: null,
      items: [{ itemId: 'item-1', type: 'agentMessage', phase: null, text: 'Done', command: null, status: null, aggregatedOutput: null }],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
    },
  ];
  (rig.controller as any).app.fuzzyFileSearch = async (_query: string, roots: string[]) => [
    { root: roots[0], path: 'src/controller/controller.ts', matchType: 'file', fileName: 'controller.ts', score: 99 },
  ];

  await (rig.controller as any).handleCommand(createEvent('/goal'), 'en', 'goal', []);
  assert.match(rig.sentMessages.at(-1)!, /Objective: Reduce latency/);

  await (rig.controller as any).handleCommand(createEvent('/goal pause'), 'en', 'goal', ['pause']);
  assert.equal(goalCalls.at(-1)?.status, 'paused');
  assert.match(rig.sentMessages.at(-1)!, /Goal updated\./);

  await (rig.controller as any).handleCommand(createEvent('/history 5'), 'en', 'history', ['5']);
  assert.match(rig.sentMessages.at(-1)!, /Recent turns for thread-1/);
  assert.match(rig.sentMessages.at(-1)!, /turn-2/);

  await (rig.controller as any).handleCommand(createEvent('/files controller'), 'en', 'files', ['controller']);
  assert.match(rig.sentMessages.at(-1)!, /src\/controller\/controller\.ts/);
});

test('diagnostic notifications route goal, model, remote, and MCP progress updates', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);
  (rig.controller as any).queueTurnRender = async () => {};

  await (rig.controller as any).handleNotification({
    method: 'thread/goal/updated',
    params: {
      threadId: 'thread-1',
      goal: { threadId: 'thread-1', objective: 'Finish rollout', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 },
    },
  });
  assert.match(rig.sentMessages.at(-1)!, /Goal updated: active · Finish rollout/);

  await (rig.controller as any).handleNotification({
    method: 'model/rerouted',
    params: { threadId: 'thread-1', turnId: 'turn-1', fromModel: 'gpt-5', toModel: 'gpt-5.5', reason: 'policy' },
  });
  assert.match(rig.sentMessages.at(-1)!, /Model rerouted: gpt-5 -> gpt-5.5/);

  await (rig.controller as any).handleNotification({
    method: 'remoteControl/status/changed',
    params: { status: 'connected', installationId: 'install-1', environmentId: 'env-1' },
  });
  assert.match(rig.sentMessages.at(-1)!, /Remote control/);
  assert.match(rig.sentMessages.at(-1)!, /Environment: env-1/);

  await (rig.controller as any).handleNotification({
    method: 'item/mcpToolCall/progress',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', message: 'Indexing workspace' },
  });
  assert.match(active.pendingArchivedStatus?.text ?? '', /MCP progress: Indexing workspace/);
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
  assert.match(rig.sentHtmlMessages[0]!, /Current: <b>server default · server default · fast=off · default · default · steer<\/b>/);
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

test('/auth add prepares a new auth candidate and completes device login', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  const targetPath = path.join(authDir, 'auth.json_work');

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.startDeviceLogin = async () => ({
    type: 'chatgptDeviceCode',
    loginId: 'login-add',
    verificationUrl: 'https://auth.example/device',
    userCode: 'NEW-CODE',
  });
  (rig.controller as any).app.readAccount = async () => ({
    type: 'chatgpt',
    email: 'new@example.com',
    planType: 'team',
    requiresOpenaiAuth: false,
  });
  (rig.controller as any).app.readAccountRateLimits = async () => null;

  await (rig.controller as any).handleCommand(createEvent('/auth add work'), 'en', 'auth', ['add', 'work']);

  assert.equal(restarts, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), targetPath);
  assert.equal(fs.existsSync(targetPath), false);
  assert.match(rig.sentMessages[0]!, /Preparing new Codex auth candidate auth\.json_work/);
  assert.match(rig.sentMessages[1]!, /NEW-CODE/);
  assert.equal((rig.controller as any).pendingAuthAddsByLoginId.has('login-add'), true);

  fs.writeFileSync(targetPath, '{"account":"work"}');
  await (rig.controller as any).handleNotification({
    method: 'account/login/completed',
    params: { loginId: 'login-add', success: true, error: null },
  });

  assert.equal((rig.controller as any).pendingAuthAddsByLoginId.has('login-add'), false);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), targetPath);
  assert.match(rig.sentMessages.at(-1)!, /New Codex auth candidate added: auth\.json_work/);
  assert.match(rig.sentMessages.at(-1)!, /Codex account: ChatGPT/);

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.match(rig.sentMessages.at(-1)!, /auth\.json_work \*/);
});

test('/auth add cancel restores previous auth', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);

  let restarts = 0;
  const calls: string[] = [];
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.startDeviceLogin = async () => ({
    type: 'chatgptDeviceCode',
    loginId: 'login-add',
    verificationUrl: 'https://auth.example/device',
    userCode: 'NEW-CODE',
  });
  (rig.controller as any).app.cancelLogin = async (loginId: string) => {
    calls.push(`cancel:${loginId}`);
  };

  await (rig.controller as any).handleCommand(createEvent('/auth add temp'), 'en', 'auth', ['add', 'temp']);

  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_temp'));

  await (rig.controller as any).handleCommand(createEvent('/login_cancel'), 'en', 'login_cancel', []);

  assert.deepEqual(calls, ['cancel:login-add']);
  assert.equal(restarts, 2);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_a'));
  assert.equal(fs.existsSync(path.join(authDir, 'auth.json_temp')), false);
  assert.match(rig.sentMessages.at(-1)!, /New auth login cancelled\. Restored previous auth\./);
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
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any, input: any[], overrides: any) => {
    retryStarts.push({ binding, input, overrides });
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
    overrides: { collaborationMode: undefined, recoverMissingThread: false },
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

test('auth retry stops instead of creating a replacement thread when original thread is missing', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  installTempAuthFiles(t, rig.tempDir);

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).startTurnWithRecovery = async () => {
    throw new Error('thread not found');
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
  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.equal(restarts, 1);
  assert.ok(rig.sentMessages.some(message => /original thread is no longer available/.test(message)));
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
  (rig.controller as any).app.respond = async (requestId: string | number, result: unknown) => {
    responses.push({ requestId, result });
  };

  await (rig.controller as any).handleServerRequest({
    id: 7,
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
  assert.equal(rig.store.listPendingUserInputs().length, 1);
  assert.equal(rig.store.listPendingUserInputs()[0]!.messageId, 1);

  await (rig.controller as any).handleCallback(createCallback(`ui:${pending.localId}:0:0`, 1));

  assert.deepEqual(responses, [{
    requestId: 7,
    result: { answers: { confirm: { answers: ['Yes'] } } },
  }]);
  assert.equal(rig.callbackAnswers[0], 'Answer recorded');
  assert.match(rig.editedMessages[0]!, /Waiting for Codex to continue/);
  assert.equal((rig.controller as any).pendingUserInputs.size, 1);
  assert.equal(rig.store.listPendingUserInputs().length, 1);
  assert.equal(rig.store.listPendingUserInputs()[0]!.status, 'submitted');
});

test('serverRequest/resolved clears pending requestUserInput card', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);

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

  assert.equal((rig.controller as any).pendingUserInputs.size, 1);
  assert.equal(rig.store.listPendingUserInputs().length, 1);

  await (rig.controller as any).handleNotification({
    method: 'serverRequest/resolved',
    params: { threadId: 'thread-1', requestId: 'request-1' },
  });

  assert.equal((rig.controller as any).pendingUserInputs.size, 0);
  assert.equal(rig.store.listPendingUserInputs().length, 0);
  assert.match(rig.editedMessages[0]!, /Submitted to Codex\./);
});

test('submitted requestUserInput is retired when the active turn is interrupted', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);

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
  await (rig.controller as any).handleCallback(createCallback(`ui:${pending.localId}:0:0`, 1));

  assert.equal(rig.store.listPendingUserInputs()[0]!.status, 'submitted');

  await (rig.controller as any).requestInterrupt(active);

  assert.equal((rig.controller as any).pendingUserInputs.size, 0);
  assert.equal(rig.store.listPendingUserInputs().length, 0);
  assert.match(rig.editedMessages.at(-1)!, /interrupted/);
});

test('submitted requestUserInput sends a waiting notice without resolving the request', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
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
        options: [{ label: 'Yes', description: 'Implement now' }],
      }],
    },
  });

  const pending = [...(rig.controller as any).pendingUserInputs.values()][0];
  await (rig.controller as any).handleCallback(createCallback(`ui:${pending.localId}:0:0`, 1));

  await (rig.controller as any).notifySubmittedUserInputStillWaiting(pending.localId);

  assert.match(rig.sentMessages.at(-1)!, /still waiting to continue/);
  assert.equal((rig.controller as any).pendingUserInputs.size, 1);
  assert.equal(rig.store.listPendingUserInputs()[0]!.status, 'submitted');
});

test('pending requestUserInput is restored from store after bridge restart', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  (rig.controller as any).app.readThreadSnapshot = async () => ({
    threadId: 'thread-1',
    name: null,
    preview: 'waiting',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'app',
    path: null,
    status: 'active',
    activeFlags: ['waitingOnUserInput'],
    updatedAt: 1,
    turns: [{
      turnId: 'turn-1',
      status: 'inProgress',
      error: null,
      items: [],
    }],
  });

  await (rig.controller as any).handleServerRequest({
    id: 'request-1',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
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

  (rig.controller as any).pendingUserInputs.clear();
  rig.editedMessages.length = 0;

  await (rig.controller as any).restorePendingUserInputs();

  const pending = [...(rig.controller as any).pendingUserInputs.values()][0];
  assert.ok(pending);
  assert.equal(pending.itemId, 'item-1');
  assert.match(rig.editedMessages[0]!, /Codex needs input:/);
});

test('submitted requestUserInput is resent with numeric request id after restore', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  (rig.controller as any).app.readThreadSnapshot = async () => ({
    threadId: 'thread-1',
    name: null,
    preview: 'waiting',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'app',
    path: null,
    status: 'active',
    activeFlags: ['waitingOnUserInput'],
    updatedAt: 1,
    turns: [{
      turnId: 'turn-1',
      status: 'inProgress',
      error: null,
      items: [],
    }],
  });
  const responses: any[] = [];
  (rig.controller as any).app.respond = async (requestId: string | number, result: unknown) => {
    responses.push({ requestId, result });
  };

  await (rig.controller as any).handleServerRequest({
    id: 9,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [{
        id: 'confirm',
        header: 'Continue?',
        question: 'Apply the plan?',
        options: [{ label: 'Yes', description: 'Implement now' }],
      }],
    },
  });
  const pending = [...(rig.controller as any).pendingUserInputs.values()][0];
  await (rig.controller as any).handleCallback(createCallback(`ui:${pending.localId}:0:0`, 1));
  responses.length = 0;
  (rig.controller as any).pendingUserInputs.clear();

  await (rig.controller as any).restorePendingUserInputs();

  assert.deepEqual(responses, [{
    requestId: 9,
    result: { answers: { confirm: { answers: ['Yes'] } } },
  }]);
});

test('submitted requestUserInput is resolved on restore when app-server no longer waits', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  (rig.controller as any).app.readThreadSnapshot = async () => ({
    threadId: 'thread-1',
    name: null,
    preview: 'running',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'app',
    path: null,
    status: 'active',
    activeFlags: [],
    updatedAt: 1,
    turns: [{
      turnId: 'turn-1',
      status: 'inProgress',
      error: null,
      items: [],
    }],
  });
  const responses: any[] = [];
  (rig.controller as any).app.respond = async (requestId: string | number, result: unknown) => {
    responses.push({ requestId, result });
  };

  await (rig.controller as any).handleServerRequest({
    id: 10,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [{
        id: 'confirm',
        header: 'Continue?',
        question: 'Apply the plan?',
        options: [{ label: 'Yes', description: 'Implement now' }],
      }],
    },
  });
  const pending = [...(rig.controller as any).pendingUserInputs.values()][0];
  await (rig.controller as any).handleCallback(createCallback(`ui:${pending.localId}:0:0`, 1));
  responses.length = 0;
  rig.editedMessages.length = 0;
  (rig.controller as any).pendingUserInputs.clear();

  await (rig.controller as any).restorePendingUserInputs();

  assert.deepEqual(responses, []);
  assert.equal((rig.controller as any).pendingUserInputs.size, 0);
  assert.equal(rig.store.listPendingUserInputs().length, 0);
  assert.match(rig.editedMessages[0]!, /Submitted to Codex\./);
});

test('plan mode completion offers implementation prompt and starts default-mode run', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  rig.store.setChatCollaborationMode('telegram:99::root', 'plan');
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => binding;
  const starts: any[] = [];
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any, input: any[], overrides: any) => {
    starts.push({ binding, input, overrides });
    return { threadId: binding.threadId, turnId: 'turn-2' };
  };
  (rig.controller as any).registerActiveTurn = async () => {};

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  active.segments = [{
    itemId: 'plan-1',
    phase: 'commentary',
    outputKind: 'commentary',
    isPlan: true,
    text: '- Inspect\n- Patch',
    completed: true,
    messages: [],
  }];
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.match(rig.sentMessages[0]!, /Plan mode produced a plan/);
  const pending = [...(rig.controller as any).pendingPlanImplementations.values()][0];
  assert.ok(pending);

  await (rig.controller as any).handleCallback(createCallback(`planimpl:${pending.localId}:run`, 1));

  assert.equal(starts[0]?.input[0]?.text, 'Implement the plan.');
  assert.equal(starts[0]?.overrides?.collaborationMode, 'default');
  assert.match(rig.editedMessages[0]!, /Started executing the plan/);
});

test('plan mode prompts for implementation after clarification answer and plan update', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  rig.store.setChatCollaborationMode('telegram:99::root', 'plan');
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};
  const responses: any[] = [];
  (rig.controller as any).app.respond = async (requestId: string, result: unknown) => {
    responses.push({ requestId, result });
  };

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleServerRequest({
    id: 'request-1',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      questions: [{
        id: 'scope',
        header: 'Scope',
        question: 'Which path should the plan cover?',
        options: [
          { label: 'Auth flow', description: 'Focus on login and switching' },
          { label: 'Everything', description: 'Cover the full bridge' },
        ],
      }],
    },
  });

  const pendingInput = [...(rig.controller as any).pendingUserInputs.values()][0];
  assert.ok(pendingInput);
  await (rig.controller as any).handleCallback(createCallback(`ui:${pendingInput.localId}:0:0`, 1));

  assert.deepEqual(responses, [{
    requestId: 'request-1',
    result: { answers: { scope: { answers: ['Auth flow'] } } },
  }]);
  assert.equal((rig.controller as any).pendingUserInputs.size, 1);

  await (rig.controller as any).handleNotification({
    method: 'serverRequest/resolved',
    params: { threadId: 'thread-1', requestId: 'request-1' },
  });
  await (rig.controller as any).handleNotification({
    method: 'turn/plan/updated',
    params: {
      turnId: 'turn-1',
      explanation: 'Plan:',
      plan: [
        { step: 'Inspect auth add handoff', status: 'completed' },
        { step: 'Patch plan implementation prompt', status: 'pending' },
      ],
    },
  });
  await (rig.controller as any).handleNotification({
    method: 'turn/completed',
    params: { turnId: 'turn-1' },
  });

  assert.ok(rig.sentMessages.some(message => /Plan mode produced a plan/.test(message)));
  const pendingPlan = [...(rig.controller as any).pendingPlanImplementations.values()][0];
  assert.ok(pendingPlan);
  assert.match(pendingPlan.planMarkdown, /Patch plan implementation prompt/);
});

test('/steer sends same-turn input to the active Codex turn', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const calls: any[] = [];
  (rig.controller as any).app.steerTurn = async (threadId: string, turnId: string, input: any[]) => {
    calls.push({ threadId, turnId, input });
    return { turnId };
  };
  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleCommand(createEvent('/steer focus tests'), 'en', 'steer', ['focus', 'tests']);

  assert.deepEqual(calls, [{
    threadId: 'thread-1',
    turnId: 'turn-1',
    input: [{ type: 'text', text: 'focus tests', text_elements: [] }],
  }]);
  assert.match(rig.sentMessages.at(-1)!, /Steered active turn turn-1/);
});

test('device login, cancel, and logout commands call app-server auth APIs', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const calls: string[] = [];
  (rig.controller as any).app.startDeviceLogin = async () => {
    calls.push('start');
    return {
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.example/device',
      userCode: 'CODE-1',
    };
  };
  (rig.controller as any).app.cancelLogin = async (loginId: string) => {
    calls.push(`cancel:${loginId}`);
  };
  (rig.controller as any).app.logoutAccount = async () => {
    calls.push('logout');
  };

  await (rig.controller as any).handleCommand(createEvent('/login_device'), 'en', 'login_device', []);
  await (rig.controller as any).handleCommand(createEvent('/login_cancel'), 'en', 'login_cancel', []);
  await (rig.controller as any).handleCommand(createEvent('/logout confirm'), 'en', 'logout', ['confirm']);

  assert.deepEqual(calls, ['start', 'cancel:login-1', 'logout']);
  assert.match(rig.sentMessages[0]!, /CODE-1/);
});

test('permissions approval server request returns granted permissions', async (t) => {
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
    id: 'perm-1',
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      cwd: rig.tempDir,
      reason: 'Need network',
      permissions: {
        network: { enabled: true },
        fileSystem: { read: [rig.tempDir], write: null },
      },
    },
  });
  const row = (rig.store as any).db.prepare('SELECT local_id FROM pending_approvals WHERE kind = ?').get('permissions');
  await (rig.controller as any).handleCallback(createCallback(`approval:${row.local_id}:session`, 1));

  assert.deepEqual(responses, [{
    requestId: 'perm-1',
    result: {
      permissions: {
        network: { enabled: true },
        fileSystem: { read: [rig.tempDir], write: null },
      },
      scope: 'session',
    },
  }]);
});

test('MCP elicitation form accepts JSON replies', async (t) => {
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
    id: 'mcp-1',
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'linear',
      mode: 'form',
      message: 'Pick issue',
      requestedSchema: { type: 'object', properties: { issue: { type: 'string' } } },
    },
  });
  const record = [...(rig.controller as any).pendingMcpElicitations.values()][0];
  assert.ok(record);

  await (rig.controller as any).handleText(createEvent('{"issue":"ABC-1"}'));
  await (rig.controller as any).handleCallback(createCallback(`mcpel:${record.localId}:accept`, 1));

  assert.deepEqual(responses, [{
    requestId: 'mcp-1',
    result: { action: 'accept', content: { issue: 'ABC-1' }, _meta: null },
  }]);
});

test('skills and MCP commands render app-server data', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  (rig.controller as any).app.listSkills = async () => [{
    cwd: rig.tempDir,
    skills: [{
      name: 'skill-a',
      description: 'Does a thing',
      shortDescription: null,
      path: path.join(rig.tempDir, 'SKILL.md'),
      scope: 'project',
      enabled: true,
      displayName: 'Skill A',
      defaultPrompt: null,
    }],
    errors: [],
  }];
  (rig.controller as any).app.listMcpServerStatus = async () => [{
    name: 'linear',
    authStatus: 'authenticated',
    toolNames: ['issue_search'],
    resourceUris: ['linear://me'],
    resourceTemplateUris: [],
  }];

  await (rig.controller as any).handleCommand(createEvent('/skills'), 'en', 'skills', []);
  await (rig.controller as any).handleCommand(createEvent('/mcp'), 'en', 'mcp', []);

  assert.match(rig.sentMessages[0]!, /Skill A/);
  assert.match(rig.sentMessages[1]!, /linear: authenticated/);
});

test('diagnostic read-only commands render app-server inventory', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  (rig.controller as any).app.listLoadedThreads = async () => ['thread-1'];
  (rig.controller as any).app.listHooks = async () => [{
    cwd: rig.tempDir,
    hooks: [{
      key: 'format',
      eventName: 'post-edit',
      handlerType: 'command',
      enabled: true,
      trustStatus: 'trusted',
      sourcePath: path.join(rig.tempDir, 'hooks.toml'),
      pluginId: null,
      command: 'npm run format',
      statusMessage: null,
    }],
    errors: [],
    warnings: [],
  }];
  (rig.controller as any).app.listPlugins = async () => [{
    name: 'local',
    displayName: 'Local',
    path: path.join(rig.tempDir, 'marketplace.json'),
    plugins: [{
      id: 'plugin-a',
      name: 'Plugin A',
      enabled: true,
      installed: true,
      source: 'local',
      availability: 'available',
      authPolicy: 'none',
      installPolicy: 'allow',
      keywords: [],
    }],
  }];
  (rig.controller as any).app.readPlugin = async () => ({
    marketplaceName: 'local',
    marketplacePath: null,
    summary: {
      id: 'plugin-a',
      name: 'Plugin A',
      enabled: true,
      installed: true,
      source: 'local',
      availability: 'available',
      authPolicy: 'none',
      installPolicy: 'allow',
      keywords: [],
    },
    description: 'Plugin details',
    skills: [{ name: 'plugin-skill', description: 'Skill', shortDescription: null, enabled: true, path: null }],
    hooks: [{ key: 'format', eventName: 'post-edit' }],
    apps: [{ id: 'app-a', name: 'App A', description: null, needsAuth: false }],
    mcpServers: ['linear'],
  });
  (rig.controller as any).app.readPluginSkill = async () => '# Plugin skill';
  (rig.controller as any).app.listApps = async () => [{
    id: 'app-a',
    name: 'App A',
    description: 'Connector',
    isEnabled: true,
    isAccessible: true,
    installUrl: null,
    distributionChannel: 'local',
    pluginDisplayNames: ['Plugin A'],
  }];
  (rig.controller as any).app.listExperimentalFeatures = async () => [{
    name: 'apps',
    displayName: 'Apps',
    enabled: true,
    defaultEnabled: false,
    stage: 'beta',
    description: 'Connector apps',
  }];
  (rig.controller as any).app.readConfig = async () => ({
    config: { model: 'gpt-5', approval_policy: 'never', sandbox_mode: 'read-only' },
    layers: [{ name: 'user', version: '1', config: {} }],
    origins: {},
  });
  (rig.controller as any).app.readConfigRequirements = async () => ({
    allowedApprovalPolicies: ['never'],
    allowedSandboxModes: ['read-only'],
    allowedWebSearchModes: ['disabled'],
    enforceResidency: null,
    featureRequirements: { apps: true },
  });
  (rig.controller as any).app.readModelProviderCapabilities = async () => ({
    webSearch: true,
    imageGeneration: false,
    namespaceTools: true,
  });

  await (rig.controller as any).handleCommand(createEvent('/loaded'), 'en', 'loaded', []);
  await (rig.controller as any).handleCommand(createEvent('/hooks'), 'en', 'hooks', []);
  await (rig.controller as any).handleCommand(createEvent('/plugins'), 'en', 'plugins', []);
  await (rig.controller as any).handleCommand(createEvent('/plugin plugin-a'), 'en', 'plugin', ['plugin-a']);
  await (rig.controller as any).handleCommand(createEvent('/plugin_skill local plugin-a plugin-skill'), 'en', 'plugin_skill', ['local', 'plugin-a', 'plugin-skill']);
  await (rig.controller as any).handleCommand(createEvent('/apps'), 'en', 'apps', []);
  await (rig.controller as any).handleCommand(createEvent('/features'), 'en', 'features', []);
  await (rig.controller as any).handleCommand(createEvent('/config'), 'en', 'config', []);
  await (rig.controller as any).handleCommand(createEvent('/requirements'), 'en', 'requirements', []);
  await (rig.controller as any).handleCommand(createEvent('/provider'), 'en', 'provider', []);

  assert.match(rig.sentMessages[0]!, /thread-1/);
  assert.match(rig.sentMessages[1]!, /format/);
  assert.match(rig.sentMessages[2]!, /Plugin A/);
  assert.match(rig.sentMessages[3]!, /Plugin details/);
  assert.match(rig.sentMessages[4]!, /# Plugin skill/);
  assert.match(rig.sentMessages[5]!, /App A/);
  assert.match(rig.sentMessages[6]!, /Apps/);
  assert.match(rig.sentMessages[7]!, /model: gpt-5/);
  assert.match(rig.sentMessages[8]!, /approval: never/);
  assert.match(rig.sentMessages[9]!, /webSearch: yes/);
});

test('diagnostic notifications are routed to bound Telegram scope', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);

  await (rig.controller as any).handleNotification({
    method: 'thread/status/changed',
    params: { threadId: 'thread-1', status: { type: 'systemError' } },
  });
  await (rig.controller as any).handleNotification({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        modelContextWindow: 1000,
        total: { totalTokens: 10_000 },
        last: { totalTokens: 900 },
      },
    },
  });
  await (rig.controller as any).handleNotification({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        modelContextWindow: 1000,
        total: { totalTokens: 11_000 },
        last: { totalTokens: 910 },
      },
    },
  });
  await (rig.controller as any).handleNotification({
    method: 'warning',
    params: { threadId: 'thread-1', message: 'Heads up' },
  });

  assert.match(rig.sentMessages[0]!, /systemError/);
  assert.match(rig.sentMessages[1]!, /90%/);
  assert.match(rig.sentMessages[2]!, /Heads up/);
});

test('token usage alerts use current context usage, not accumulated thread total', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  await (rig.controller as any).handleNotification({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        modelContextWindow: 258_400,
        total: { totalTokens: 58_665_546 },
        last: { totalTokens: 12_000 },
      },
    },
  });

  assert.deepEqual(rig.sentMessages, []);
});

test('thread management commands call fork, rename, rollback, compact, archive, and review APIs', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  const calls: string[] = [];
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => binding;
  (rig.controller as any).app.forkThread = async () => {
    calls.push('fork');
    return {
      thread: {
        threadId: 'thread-fork',
        name: null,
        preview: 'fork',
        cwd: rig.tempDir,
        modelProvider: 'openai',
        source: 'app',
        path: null,
        status: 'idle',
        updatedAt: 1,
      },
      model: 'gpt-5',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      cwd: rig.tempDir,
    };
  };
  (rig.controller as any).app.setThreadName = async (_threadId: string, name: string) => {
    calls.push(`rename:${name}`);
  };
  (rig.controller as any).app.rollbackThread = async (_threadId: string, count: number) => {
    calls.push(`rollback:${count}`);
    return null;
  };
  (rig.controller as any).app.compactThread = async () => {
    calls.push('compact');
  };
  (rig.controller as any).app.archiveThread = async () => {
    calls.push('archive');
  };
  (rig.controller as any).app.startReview = async () => {
    calls.push('review');
    return { turnId: 'turn-review', reviewThreadId: 'thread-fork' };
  };
  (rig.controller as any).registerActiveTurn = async () => {};

  await (rig.controller as any).handleCommand(createEvent('/fork trial'), 'en', 'fork', ['trial']);
  await (rig.controller as any).handleCommand(createEvent('/rename done'), 'en', 'rename', ['done']);
  await (rig.controller as any).handleCommand(createEvent('/undo 2 confirm'), 'en', 'undo', ['2', 'confirm']);
  await (rig.controller as any).handleCommand(createEvent('/compact'), 'en', 'compact', []);
  await (rig.controller as any).handleCommand(createEvent('/review'), 'en', 'review', []);
  await (rig.controller as any).handleCommand(createEvent('/archive'), 'en', 'archive', []);

  assert.deepEqual(calls, [
    'fork',
    'rename:trial',
    'rename:done',
    'rollback:2',
    'compact',
    'review',
    'archive',
  ]);
  assert.equal(rig.store.getBinding('telegram:99::root'), null);
});

test('/threads panel supports rename and archive callbacks', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const thread = {
    threadId: 'thread-panel',
    name: 'Panel thread',
    preview: 'preview',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'cli',
    path: null,
    status: 'idle' as const,
    updatedAt: 1,
  };
  const calls: string[] = [];
  (rig.controller as any).app.listThreads = async () => [thread];
  (rig.controller as any).app.setThreadName = async (threadId: string, name: string) => {
    calls.push(`rename:${threadId}:${name}`);
  };
  (rig.controller as any).app.archiveThread = async (threadId: string) => {
    calls.push(`archive:${threadId}`);
  };
  rig.store.setBinding('telegram:99::root', 'thread-panel', rig.tempDir);

  await (rig.controller as any).handleText(createEvent('/threads'));

  assert.equal(rig.sentHtmlMessages.length, 1);
  assert.deepEqual(rig.sentHtmlKeyboards[0], [
    [{ text: '1. Panel thread', callback_data: 'thread:open:thread-panel' }],
    [
      { text: 'Rename', callback_data: 'thread:rename:thread-panel' },
      { text: 'Archive/Delete', callback_data: 'thread:archive:thread-panel' },
    ],
    [{ text: 'Archived', callback_data: 'thread:list:archived' }],
  ]);

  await (rig.controller as any).handleCallback(createCallback('thread:rename:thread-panel', 1001));
  assert.equal(rig.callbackAnswers.at(-1), 'Send the new name');
  assert.match(rig.sentMessages.at(-1)!, /Send the new name for: Panel thread/);

  await (rig.controller as any).handleText(createEvent('Renamed from panel'));
  assert.deepEqual(calls, ['rename:thread-panel:Renamed from panel']);
  assert.match(rig.sentMessages.at(-1)!, /Renamed thread to: Renamed from panel/);

  await (rig.controller as any).handleCallback(createCallback('thread:archive:thread-panel', 1001));
  assert.deepEqual(calls, [
    'rename:thread-panel:Renamed from panel',
    'archive:thread-panel',
  ]);
  assert.equal(rig.store.getBinding('telegram:99::root'), null);
  assert.equal(rig.callbackAnswers.at(-1), 'Thread archived');
});

test('/threads archived panel supports unarchive callback', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const archivedThread = {
    threadId: 'thread-archived',
    name: 'Archived work',
    preview: 'old',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'cli',
    path: null,
    status: 'idle' as const,
    updatedAt: 1,
  };
  const calls: string[] = [];
  const listArchived: boolean[] = [];
  (rig.controller as any).app.listThreads = async (options: { archived?: boolean }) => {
    listArchived.push(Boolean(options.archived));
    return options.archived ? [archivedThread] : [];
  };
  (rig.controller as any).app.unarchiveThread = async (threadId: string) => {
    calls.push(`unarchive:${threadId}`);
  };
  (rig.controller as any).app.resumeThread = async ({ threadId }: { threadId: string }) => ({
    thread: { ...archivedThread, threadId },
    model: 'gpt-5',
    modelProvider: 'openai',
    reasoningEffort: 'medium',
    cwd: rig.tempDir,
  });

  await (rig.controller as any).handleText(createEvent('/threads archived'));

  assert.equal(rig.sentHtmlMessages.length, 1);
  assert.deepEqual(rig.sentHtmlKeyboards[0], [
    [{ text: '1. Archived work', callback_data: 'thread:open:thread-archived' }],
    [{ text: 'Unarchive', callback_data: 'thread:unarchive:thread-archived' }],
    [{ text: 'Recent', callback_data: 'thread:list:recent' }],
  ]);

  await (rig.controller as any).handleCallback(createCallback('thread:unarchive:thread-archived', 1001));

  assert.deepEqual(calls, ['unarchive:thread-archived']);
  assert.equal(rig.store.getBinding('telegram:99::root')?.threadId, 'thread-archived');
  assert.equal(rig.callbackAnswers.at(-1), 'Thread unarchived');
  assert.deepEqual(listArchived, [true, false]);
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

test('startup preview cleanup recovers still-live app-server turns', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    (rig.controller as any).clearObservedThreadWatchers();
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.saveActiveTurnPreview({
    turnId: 'turn-live',
    scopeId: 'telegram:99::root',
    threadId: 'thread-1',
    messageId: 123,
  });
  (rig.controller as any).app.readThreadSnapshot = async () => ({
    threadId: 'thread-1',
    name: null,
    preview: 'live',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'app',
    path: null,
    status: 'active',
    activeFlags: [],
    updatedAt: 1,
    turns: [{
      turnId: 'turn-live',
      status: 'inProgress',
      error: null,
      items: [{
        itemId: 'item-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: 'already relayed',
        command: null,
        status: null,
        aggregatedOutput: null,
      }],
    }],
  });
  let renders = 0;
  (rig.controller as any).queueTurnRender = async () => {
    renders += 1;
  };

  await (rig.controller as any).cleanupStaleTurnPreviews();

  assert.ok((rig.controller as any).activeTurns.has('turn-live'));
  assert.equal((rig.controller as any).observedThreadWatchers.get('telegram:99::root')?.activeTurnId, 'turn-live');
  assert.equal(rig.store.listActiveTurnPreviews().length, 1);
  assert.equal(rig.editedMessages.length, 0);
  assert.equal(renders, 1);
});

test('startup preview cleanup interrupts orphan waiting user-input turns', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    (rig.controller as any).clearObservedThreadWatchers();
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.saveActiveTurnPreview({
    turnId: 'turn-waiting',
    scopeId: 'telegram:99::root',
    threadId: 'thread-1',
    messageId: 123,
  });
  (rig.controller as any).app.readThreadSnapshot = async () => ({
    threadId: 'thread-1',
    name: null,
    preview: 'waiting',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'app',
    path: null,
    status: 'active',
    activeFlags: ['waitingOnUserInput'],
    updatedAt: 1,
    turns: [{
      turnId: 'turn-waiting',
      status: 'inProgress',
      error: null,
      items: [],
    }],
  });
  const interrupted: Array<{ threadId: string; turnId: string }> = [];
  (rig.controller as any).app.interruptTurn = async (threadId: string, turnId: string) => {
    interrupted.push({ threadId, turnId });
  };

  await (rig.controller as any).cleanupStaleTurnPreviews();

  assert.deepEqual(interrupted, [{ threadId: 'thread-1', turnId: 'turn-waiting' }]);
  assert.equal((rig.controller as any).activeTurns.size, 0);
  assert.equal(rig.store.listActiveTurnPreviews().length, 0);
  assert.match(rig.editedMessages[0]!, /stale Codex input request/);
});

test('controller stop preserves live preview records for restart recovery', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 123);
  (rig.controller as any).activeTurns.set('turn-1', active);
  rig.store.saveActiveTurnPreview({
    turnId: 'turn-1',
    scopeId: 'telegram:99::root',
    threadId: 'thread-1',
    messageId: 123,
  });

  await rig.controller.stop();

  assert.equal((rig.controller as any).activeTurns.size, 0);
  assert.equal(rig.store.listActiveTurnPreviews().length, 1);
  assert.equal(rig.editedMessages.length, 0);
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
      isPlan: false,
      text: 'thinking',
      completed: true,
      messages: [{ messageId: 11, text: 'thinking' }],
    },
    {
      itemId: 'final-1',
      phase: 'final_answer',
      outputKind: 'final_answer',
      isPlan: false,
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

test('/watch tails local vscode session files when a bound thread has a path', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    (rig.controller as any).clearObservedThreadWatchers();
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const sessionPath = path.join(rig.tempDir, 'vscode-session.jsonl');
  fs.writeFileSync(sessionPath, '');
  rig.store.setBinding('telegram:99::root', 'thread-vscode', rig.tempDir);
  (rig.controller as any).app.readThread = async () => ({
    threadId: 'thread-vscode',
    name: null,
    preview: 'vscode',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'vscode',
    path: sessionPath,
    status: 'idle',
    updatedAt: 1,
  });
  (rig.controller as any).ensureThreadReady = async () => {
    throw new Error('watch should use the local session file');
  };

  await (rig.controller as any).handleCommand(createEvent('/watch'), 'en', 'watch', []);

  const watcher = (rig.controller as any).observedThreadWatchers.get('telegram:99::root');
  assert.equal(watcher?.mode, 'session_file');
  assert.equal(watcher?.sessionPath, sessionPath);
  assert.equal(rig.sentMessages[0], 'Watching thread thread-vscode. I will mirror the next live turn from Codex CLI here.');
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
