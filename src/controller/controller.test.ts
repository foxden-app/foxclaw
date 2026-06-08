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
import type { SelfUpdateRuntime, SelfUpdateStatus } from '../update.js';
import type { CoreCoordinator } from './controller.js';
import type { GuidedPlanSessionRecord } from '../types.js';

const loggerStub = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

function createConfig(tempDir: string): AppConfig {
  return {
    tgBotToken: 'token',
    tgBotTokens: ['token'],
    tgMultiBotMode: false,
    tgDefaultRuntimeBotToken: null,
    tgScopeBotId: null,
    tgRequireExplicitGroupAddressing: false,
    tgAllowedUserId: '42',
    tgAllowedChatId: null,
    tgAllowedTopicId: null,
    codexCliBin: 'codex',
    codexAppAutolaunch: false,
    codexAppLaunchCmd: 'codex app',
    codexAppServerStatePath: path.join(tempDir, 'codex-app-server.json'),
    codexAppServerLogPath: path.join(tempDir, 'codex-app-server.log'),
    codexAuthDir: null,
    codexHome: null,
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
    envPath: path.join(tempDir, '.env'),
    wxEnabled: false,
    wxAllowedIlinkUserIds: [],
    weixinAccountsDir: path.join(tempDir, 'weixin', 'accounts'),
    weixinSyncBufDir: path.join(tempDir, 'weixin', 'sync-buf'),
    weixinMediaDir: path.join(tempDir, 'weixin', 'media'),
    wxIlinkRouteTag: null,
    authSyncEnabled: false,
    authSyncTransport: 'telegram-private',
    authSyncKey: null,
    authSyncPeers: [],
    authSyncNodeId: null,
    authSyncClusterId: 'default',
    authSyncStatePath: path.join(tempDir, 'auth-sync.json'),
    authSyncTempDir: path.join(tempDir, 'auth-sync'),
    authAutoDeleteNeedsRepair: false,
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

function setActiveTurnForTest(rig: ReturnType<typeof createControllerRig>, active: any): void {
  (rig.controller as any).setActiveTurn(active.scopeId, active.turnId, active);
}

function getActiveTurnForTest(
  rig: ReturnType<typeof createControllerRig>,
  scopeId = 'telegram:99::root',
  turnId = 'turn-1',
): any {
  return (rig.controller as any).getActiveTurn(scopeId, turnId);
}

function hasActiveTurnForTest(rig: ReturnType<typeof createControllerRig>, turnId: string): boolean {
  return (rig.controller as any).hasAnyActiveTurnForTurn(turnId);
}

function deleteActiveTurnForTest(rig: ReturnType<typeof createControllerRig>, active: any): void {
  (rig.controller as any).deleteActiveTurn(active.scopeId, active.turnId);
}

function queuedTextsForTest(rig: ReturnType<typeof createControllerRig>, scopeId: string): string[] {
  return rig.store.listQueuedTurnInputs(scopeId).map((record) => {
    const input = JSON.parse(record.inputJson) as Array<{ text?: string }>;
    return input[0]?.text ?? '';
  });
}

function saveQueuedTurnForTest(
  rig: ReturnType<typeof createControllerRig>,
  scopeId: string,
  text: string,
  overrides: { chatId?: string; chatType?: string; topicId?: number | null; threadId?: string } = {},
): string {
  const now = Date.now();
  const queueId = `queue${Math.random().toString(16).slice(2, 10)}`;
  rig.store.saveQueuedTurnInput({
    queueId,
    scopeId,
    chatId: overrides.chatId ?? (scopeId.startsWith('weixin:') ? 'wx-user-1' : '99'),
    chatType: overrides.chatType ?? 'private',
    topicId: overrides.topicId ?? null,
    threadId: overrides.threadId ?? 'thread-1',
    inputJson: JSON.stringify([{ type: 'text', text, text_elements: [] }]),
    sourceSummary: text,
    messageId: 1,
    status: 'queued',
    error: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  });
  return queueId;
}

function savePlanSessionForTest(
  rig: ReturnType<typeof createControllerRig>,
  overrides: Partial<GuidedPlanSessionRecord> = {},
): GuidedPlanSessionRecord {
  const now = Date.now();
  const session: GuidedPlanSessionRecord = {
    sessionId: 'planabc1',
    scopeId: 'telegram:99::root',
    chatId: '99',
    chatType: 'private',
    topicId: null,
    threadId: 'thread-1',
    turnId: 'turn-plan',
    cwd: rig.tempDir,
    planMarkdown: '- Do one thing',
    messageId: null,
    state: 'awaiting_confirmation',
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    ...overrides,
  };
  rig.store.saveGuidedPlanSession(session);
  return session;
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

function writeChatGptAuthCandidate(
  authDir: string,
  name: string,
  accountId: string,
  lastRefresh = '2026-01-01T00:00:00.000Z',
  identity: { userId?: string; email?: string } = {},
): void {
  const tokens: Record<string, string> = { account_id: accountId };
  if (identity.userId || identity.email) {
    tokens.access_token = fakeJwt({
      'https://api.openai.com/auth.chatgpt_account_id': accountId,
      'https://api.openai.com/auth.chatgpt_user_id': identity.userId,
      'https://api.openai.com/profile.email': identity.email,
    });
  }
  fs.writeFileSync(path.join(authDir, name), `${JSON.stringify({
    tokens,
    last_refresh: lastRefresh,
  })}\n`);
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

function chatGptAccount(planType = 'plus'): any {
  return {
    type: 'chatgpt',
    email: 'user@example.com',
    planType,
    requiresOpenaiAuth: false,
  };
}

function codexRateLimits(primaryUsedPercent = 80, secondaryUsedPercent = 75, planType = 'plus'): any {
  return {
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: primaryUsedPercent, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: secondaryUsedPercent, windowDurationMins: 10080, resetsAt: null },
      credits: null,
      planType,
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  };
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

function createControllerRig(selfUpdater: SelfUpdateRuntime | null = null, coordinator: CoreCoordinator | null = null) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-controller-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const sentMessages: string[] = [];
  const sentKeyboards: any[] = [];
  const sentHtmlMessages: string[] = [];
  const editedMessages: string[] = [];
  const editedKeyboards: any[] = [];
  const editedHtmlMessages: string[] = [];
  const sentHtmlKeyboards: any[] = [];
  const editedHtmlKeyboards: any[] = [];
  const callbackAnswers: string[] = [];
  const deletedMessageIds: number[] = [];
  const bot = {
    identity: 'bot1',
    stop: () => {},
    sendMessage: async (_chatId: string, text: string, keyboard?: any) => {
      sentMessages.push(text);
      sentKeyboards.push(keyboard ?? []);
      return sentMessages.length;
    },
    sendHtmlMessage: async (_chatId: string, text: string, keyboard?: any) => {
      sentHtmlMessages.push(text);
      sentHtmlKeyboards.push(keyboard ?? []);
      return 1000 + sentHtmlMessages.length;
    },
    editMessage: async (_chatId: string, _messageId: number, text: string, keyboard?: any) => {
      editedMessages.push(text);
      editedKeyboards.push(keyboard ?? []);
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
    startThread: async (options: { cwd: string }) => ({
      thread: {
        threadId: 'thread-new',
        name: null,
        preview: 'new',
        cwd: options.cwd,
        modelProvider: 'openai',
        source: 'app',
        path: null,
        status: 'idle',
        updatedAt: 1,
      },
      model: 'gpt-5',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      cwd: options.cwd,
    }),
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
  const controller = new BridgeController(createConfig(tempDir), store, loggerStub as any, bot as any, app as any, outbound, selfUpdater, coordinator);
  (controller as any).updateStatus = () => {};
  return {
    controller,
    store,
    sentMessages,
    sentKeyboards,
    sentHtmlMessages,
    editedMessages,
    editedKeyboards,
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
  const active = getActiveTurnForTest(rig);
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
  setActiveTurnForTest(rig, active);
  saveQueuedTurnForTest(rig, 'telegram:99::root', 'later');

  const calls: string[] = [];
  (rig.controller as any).requestInterrupt = async (turn: any) => {
    calls.push(`interrupt:${turn.turnId}`);
    turn.interruptRequested = true;
    setTimeout(() => {
      turn.resolver();
      deleteActiveTurnForTest(rig, turn);
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

  assert.equal(rig.store.countQueuedTurnInputs('telegram:99::root'), 0);
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
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleCommand(createEvent('/queue first'), 'en', 'queue', ['first']);
  assert.deepEqual(queuedTextsForTest(rig, 'telegram:99::root'), ['first']);
  assert.match(rig.sentMessages[0]!, /Queued #1/);

  await (rig.controller as any).handleCommand(createEvent('/queue second'), 'en', 'queue', ['second']);
  assert.deepEqual(queuedTextsForTest(rig, 'telegram:99::root'), ['first', 'second']);
  assert.match(rig.sentMessages[1]!, /Queued #2/);
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
  setActiveTurnForTest(rig, active);
  await (rig.controller as any).handleText(createEvent('please adjust'));

  assert.equal(steers.length, 1);
  assert.equal(steers[0]?.input[0]?.text, 'please adjust');
  assert.equal(rig.sentMessages.at(-1), 'Steered active turn turn-1.');

  rig.store.setChatActiveTurnMessageMode('telegram:99::root', 'queue');
  await (rig.controller as any).handleText(createEvent('next after this'));

  assert.equal(steers.length, 1);
  assert.deepEqual(queuedTextsForTest(rig, 'telegram:99::root'), ['next after this']);
  assert.match(rig.sentMessages.at(-1)!, /Queued #1/);
});

test('telegram attachments are staged and consumed by the next text prompt', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => binding;
  (rig.controller as any).stageAttachments = async () => [{
    kind: 'document',
    fileId: 'file-1',
    fileUniqueId: 'unique-1',
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    fileSize: 12,
    width: null,
    height: null,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
    localPath: path.join(rig.tempDir, 'notes.txt'),
    relativePath: '.telegram-inbox/notes.txt',
    nativeImage: false,
  }];
  (rig.controller as any).stopWatchingScopeThread = async () => {};
  (rig.controller as any).sendTyping = async () => {};
  const starts: any[] = [];
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any, input: any[]) => {
    starts.push({ binding, input });
    return { threadId: binding.threadId, turnId: 'turn-2', collaborationMode: 'default' };
  };
  (rig.controller as any).registerActiveTurn = async () => {};

  await (rig.controller as any).handleText({
    ...createEvent('reference notes'),
    attachments: [{
      kind: 'document',
      fileId: 'file-1',
      fileUniqueId: 'unique-1',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      fileSize: 12,
      width: null,
      height: null,
      durationSeconds: null,
      isAnimated: false,
      isVideo: false,
    }],
  } satisfies TelegramTextEvent);

  const batch = rig.store.getLatestPendingAttachmentBatch('telegram:99::root');
  assert.ok(batch);
  assert.equal(batch.caption, 'reference notes');
  assert.match(rig.sentMessages.at(-1)!, /Attachments staged: 1/);

  await (rig.controller as any).handleText(createEvent('please summarize it'));

  assert.equal(rig.store.getLatestPendingAttachmentBatch('telegram:99::root'), null);
  assert.equal(starts.length, 1);
  assert.match(starts[0].input[0].text, /please summarize it/);
  assert.match(starts[0].input[0].text, /notes\.txt/);
  assert.match(rig.editedMessages.at(-1)!, /Attachments attached/);
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
  setActiveTurnForTest(rig, active);
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

test('/mode opens setup panel, while /mode <value>, /plan, and /agent update collaboration mode settings', async (t) => {
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
  assert.equal(
    rig.sentMessages[0],
    'Plan mode is armed for the next turn only. After that turn starts, this chat returns to Agent.',
  );

  await (rig.controller as any).handleCommand(createEvent('/agent'), 'en', 'agent', []);
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.collaborationMode, 'default');
  assert.equal(rig.sentMessages[1], 'Mode set to: Agent\nApplies on the next turn.');

  await (rig.controller as any).handleCommand(createEvent('/plan'), 'en', 'plan', []);
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.collaborationMode, 'plan');
  assert.equal(
    rig.sentMessages[2],
    'Plan mode is armed for the next turn only. After that turn starts, this chat returns to Agent.',
  );
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

  const result = await (rig.controller as any).startTurnWithRecovery(
    'telegram:99::root',
    { threadId: 'thread-1', cwd: rig.tempDir },
    [{ type: 'text', text: 'hi', text_elements: [] }],
  );

  assert.equal(result.collaborationMode, 'plan');
  assert.deepEqual(calls[0]?.collaborationMode, {
    mode: 'plan',
    settings: {
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      developer_instructions: null,
    },
  });
});

test('plan mode is consumed after one started turn', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const scopeId = 'telegram:99::root';
  rig.store.setBinding(scopeId, 'thread-1', rig.tempDir);
  rig.store.setChatCollaborationMode(scopeId, 'plan');
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => binding;
  const starts: any[] = [];
  (rig.controller as any).app.startTurn = async (options: any) => {
    starts.push(options);
    return { id: `turn-${starts.length}`, status: 'running' };
  };
  const registrations: any[][] = [];
  (rig.controller as any).registerActiveTurn = async (...args: any[]) => {
    registrations.push(args);
  };

  await (rig.controller as any).startBoundTurnFromEvent(createEvent('make a plan'), 'en', 'make a plan');

  assert.equal(starts[0]?.collaborationMode?.mode, 'plan');
  assert.equal(rig.store.getChatSettings(scopeId)?.collaborationMode, 'default');
  assert.equal(registrations[0]?.[7]?.collaborationMode, 'plan');
  assert.equal(registrations[0]?.[8], 'plan');

  await (rig.controller as any).startBoundTurnFromEvent(createEvent('continue'), 'en', 'continue');

  assert.equal(starts[1]?.collaborationMode?.mode, 'default');
  assert.equal(rig.store.getChatSettings(scopeId)?.collaborationMode, 'default');
  assert.equal(registrations[1]?.[7]?.collaborationMode, 'default');
  assert.equal(registrations[1]?.[8], 'default');
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
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleCallback(createCallback('setup:model:gpt-5-codex', 10));
  assert.equal(rig.callbackAnswers[0], 'Wait for the current turn to finish');
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.model ?? null, null);

  await (rig.controller as any).handleCallback(createCallback('setup:access:full-access', 10));
  assert.equal(rig.store.getChatSettings('telegram:99::root')?.accessPreset, 'full-access');
  assert.equal(rig.callbackAnswers[1], 'Access: Full access');
});

test('resuming a shared thread uses Telegram access settings over Weixin settings', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const telegramScope = 'telegram:99::root';
  const weixinScope = 'weixin:acc1:wx-user-1';
  rig.store.setBinding(telegramScope, 'thread-shared', rig.tempDir);
  rig.store.setBinding(weixinScope, 'thread-shared', rig.tempDir);
  rig.store.setChatAccessPreset(telegramScope, 'full-access');
  rig.store.setChatAccessPreset(weixinScope, 'read-only');

  const resumes: any[] = [];
  (rig.controller as any).app.resumeThread = async (options: any) => {
    resumes.push(options);
    return {
      thread: {
        threadId: options.threadId,
        name: null,
        preview: 'shared',
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

  await (rig.controller as any).ensureThreadReady(telegramScope, rig.store.getBinding(telegramScope));

  assert.equal(resumes[0]?.threadId, 'thread-shared');
  assert.equal(resumes[0]?.approvalPolicy, 'never');
  assert.equal(resumes[0]?.sandboxMode, 'danger-full-access');
});

test('/permissions full-access invalidates attached Telegram thread for access refresh', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const scope = 'telegram:99::root';
  rig.store.setBinding(scope, 'thread-1', rig.tempDir);
  (rig.controller as any).attachedThreads.add(`${scope}:thread-1`);
  const resumes: any[] = [];
  (rig.controller as any).app.resumeThread = async (options: any) => {
    resumes.push(options);
    return {
      thread: {
        threadId: options.threadId,
        name: null,
        preview: 'thread',
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

  await (rig.controller as any).handleCommand(createEvent('/permissions full-access'), 'en', 'permissions', ['full-access']);
  await (rig.controller as any).ensureThreadReady(scope, rig.store.getBinding(scope));

  assert.equal(resumes.length, 1);
  assert.equal(resumes[0]?.approvalPolicy, 'never');
  assert.equal(resumes[0]?.sandboxMode, 'danger-full-access');
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
  assert.ok(rig.sentMessages[0]!.includes(`CWD: ${rig.tempDir}`));
  assert.match(rig.sentMessages[0]!, /Codex plan: Plus/);
  assert.match(rig.sentMessages[0]!, /Codex usage \(codex\):/);
  assert.match(rig.sentMessages[0]!, /5h window: 37% remaining/);
  assert.match(rig.sentMessages[0]!, /7d window: 43.5% remaining/);
  assert.doesNotMatch(rig.sentMessages[0]!, /user@example\.com/);
});

test('/status in multi-bot mode reports auth runtime types and recent coordination state', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  (rig.controller as any).config.tgMultiBotMode = true;
  (rig.controller as any).coordinator = {
    getServiceStatus: async () => ({
      bots: [
        { id: 'bot1', username: 'bot_one', connected: true, activeTurns: 1, currentAuth: 'auth.json_a' },
        { id: 'bot2', username: 'bot_two', connected: true, activeTurns: 0, runtimeKind: 'default' as const, currentAuth: 'auth.json_b' },
      ],
      authMirror: {
        candidateName: 'auth.json_a',
        sourceRuntimeId: 'bot1',
        sourceLabel: '@bot_one',
        syncedAt: '2026-05-27T10:00:00.000Z',
      },
      authSync: {
        enabled: true,
        nodeId: 'node-a',
        transportLabel: '@bot_one',
        peers: ['@botB'],
        pendingImports: 1,
        lastSentAt: '2026-05-27T10:00:01.000Z',
        lastReceivedAt: null,
        lastImportedAt: null,
        lastImportCandidate: null,
        lastPullAt: null,
        lastPullCandidate: null,
        lastError: 'peer offline',
        activeLeaseId: null,
      },
      lastUpdate: {
        state: 'succeeded',
        scopeId: 'telegram:bot1:99::root',
        locale: 'en',
        fromVersion: '0.3.19',
        toVersion: '0.4.0',
        codexUpdate: 'Codex CLI updated with pnpm.',
        codexFromVersion: '0.135.0',
        codexToVersion: '0.136.0',
        error: null,
        updatedAt: '2026-05-27T10:01:00.000Z',
      },
    }),
  };

  await (rig.controller as any).handleCommand(createEvent('/status'), 'en', 'status', []);

  assert.match(rig.sentMessages[0]!, /Telegram bot runtimes:/);
  assert.match(rig.sentMessages[0]!, /@bot_one: connected yes, runtime isolated, auth auth\.json_a, active turns 1/);
  assert.match(rig.sentMessages[0]!, /@bot_two: connected yes, runtime default\/shared terminal, auth auth\.json_b, active turns 0/);
  assert.match(rig.sentMessages[0]!, /Last auth mirror: auth\.json_a from @bot_one/);
  assert.match(rig.sentMessages[0]!, /Cross-node auth sync: node node-a, contact @bot_one, peers 1, pending imports 1/);
  assert.match(rig.sentMessages[0]!, /Cross-node auth sync error: peer offline/);
  assert.match(rig.sentMessages[0]!, /Last service update: 0\.3\.19 -> 0\.4\.0/);
  assert.match(rig.sentMessages[0]!, /Last Codex update: Codex CLI: 0\.135\.0 -> 0\.136\.0\./);
});

test('a Weixin-only default runtime does not own Telegram scopes', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  (rig.controller as any).ownsTelegramRuntime = false;

  assert.equal((rig.controller as any).ownsScope('telegram:bot1:99::root'), false);
  assert.equal((rig.controller as any).ownsScope('weixin:account:user'), true);
});

test('/update launches a background self-update and reports the completed result', async (t) => {
  let status: SelfUpdateStatus | null = null;
  let launches = 0;
  const completed: { status: SelfUpdateStatus | null } = { status: null };
  const updater: SelfUpdateRuntime = {
    async launch(scopeId, locale) {
      launches += 1;
      status = {
        state: 'pending',
        scopeId,
        locale,
        fromVersion: '0.3.13',
        toVersion: null,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    },
    async readStatus() {
      return status;
    },
    async clearStatus() {
      status = null;
    },
  };
  const rig = createControllerRig(updater);
  (rig.controller as any).coordinator = {
    selfUpdateCompleted: (terminalStatus: SelfUpdateStatus) => {
      completed.status = terminalStatus;
    },
  };
  t.after(() => {
    (rig.controller as any).clearSelfUpdateStatusPoll();
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCommand(createEvent('/update'), 'zh', 'update', []);

  assert.equal(launches, 1);
  assert.match(rig.sentMessages[0]!, /已开始升级 FoxClaw/);

  status = {
    state: 'succeeded',
    scopeId: 'telegram:99::root',
    locale: 'zh',
    fromVersion: '0.3.13',
    toVersion: '0.3.14',
    releaseNotes: ['修复升级回报', '显示更新内容'],
    releaseNotesVersion: '0.3.14',
    codexFromVersion: '0.135.0',
    codexToVersion: '0.136.0',
    error: null,
    updatedAt: new Date().toISOString(),
  };
  await (rig.controller as any).pollSelfUpdateStatus();

  assert.match(rig.sentMessages[1]!, /FoxClaw 已升级并重启：0\.3\.13 -> 0\.3\.14/);
  assert.match(rig.sentMessages[1]!, /更新内容：/);
  assert.match(rig.sentMessages[1]!, /- 修复升级回报/);
  assert.match(rig.sentMessages[1]!, /- 显示更新内容/);
  assert.match(rig.sentMessages[1]!, /Codex CLI：0\.135\.0 -> 0\.136\.0/);
  assert.equal(status, null);
  assert.equal(completed.status?.toVersion, '0.3.14');
});

test('/update reports terminal fallback when self-update is unavailable', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCommand(createEvent('/update'), 'en', 'update', []);

  assert.match(rig.sentMessages[0]!, /foxclaw update/);
});

test('/help pins important commands and sorts the rest by recent use', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCommand(createEvent('/watch'), 'en', 'watch', []);
  await (rig.controller as any).handleCommand(createEvent('/features'), 'en', 'features', []);
  await (rig.controller as any).handleCommand(createEvent('/help'), 'en', 'help', []);

  const lines = rig.sentMessages.at(-1)!.split('\n');
  assert.deepEqual(lines.slice(1, 6), ['/help', '/setup', '/status', '/threads [query]', '/auth']);
  assert.equal(lines[6], '/features');
  assert.equal(lines[7], '/watch');
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
      timestamp: '2026-05-26T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-a' },
    }),
    JSON.stringify({
      timestamp: '2026-05-26T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
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
      timestamp: '2026-05-26T00:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
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
    JSON.stringify({
      timestamp: '2026-05-26T00:00:06.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-a' },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(sessionDir, 'rollout-b.jsonl'), [
    JSON.stringify({
      timestamp: '2026-05-26T00:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-b' },
    }),
    JSON.stringify({
      timestamp: '2026-05-26T00:01:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
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
    }),
    JSON.stringify({
      timestamp: '2026-05-26T00:01:06.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-b' },
    }),
  ].join('\n'));

  await (rig.controller as any).refreshCodexLocalUsageStats();
  await (rig.controller as any).handleCommand(createEvent('/status'), 'en', 'status', []);

  assert.match(rig.sentMessages[0]!, /Codex local history: 2 sessions, 2 turns, 3 usage records/);
  assert.match(
    rig.sentMessages[0]!,
    /Codex local tokens: total 147; input 130, visible output 10, reasoning output 7, total output 17, cached input 24/,
  );
  assert.match(
    rig.sentMessages[0]!,
    /Codex visible reply throughput \(end-to-end, excluding reasoning\): overall 0\.8 token\/s, last 2 completed turns 0\.8 token\/s \(2 completed turns sampled\)/,
  );
  assert.match(rig.sentMessages[0]!, /Codex local stats snapshot: /);
});

test('/status does not wait for local usage history when no snapshot exists', async (t) => {
  const rig = createControllerRig();
  installTempCodexHome(t, rig.tempDir);
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCommand(createEvent('/status'), 'en', 'status', []);

  assert.match(rig.sentMessages[0]!, /Codex local history: building snapshot in background/);
  await (rig.controller as any).localUsageRefresh;
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
  setActiveTurnForTest(rig, active);

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
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => {
    const currentName = path.basename(fs.realpathSync(path.join(authDir, 'auth.json')));
    return currentName === 'auth.json_a'
      ? codexRateLimits(80, 75)
      : codexRateLimits(10, 5);
  };

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.match(rig.sentMessages[0]!, /Codex auth files:/);
  assert.match(rig.sentMessages[0]!, /5h:20\|7d:25\|a \*/);
  assert.match(rig.sentMessages[0]!, /\|b/);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:1`, 1));

  assert.equal(restarts, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_b'));
  assert.equal(rig.callbackAnswers[0], 'Auth selected');
  assert.match(rig.editedMessages[0]!, /Switching Codex auth: auth\.json_a -> auth\.json_b/);
  assert.match(rig.editedMessages.at(-1)!, /Current auth: b/);
  assert.match(rig.editedMessages.at(-1)!, /5h:90\|7d:95\|b \* \[Plus · ready · refreshed 0m ago\]/);
  assert.equal(rig.store.listCodexAuthCandidateStates().get('auth.json_b'), 'active');
  assert.equal((rig.controller as any).pendingAuthChoiceLists.get(list.localId), list);
  assert.match(rig.editedKeyboards.at(-1)?.[1]?.[0]?.text, /✅ 90\|95\|b/);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:0`, 1));

  assert.equal(restarts, 2);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_a'));
  assert.match(rig.editedMessages.at(-1)!, /Current auth: a/);
  assert.match(rig.editedKeyboards.at(-1)?.[0]?.[0]?.text, /✅ 20\|25\|a/);
});

test('/auth switch validates selected candidate and marks unusable auth for repair', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  fs.writeFileSync(path.join(authDir, 'auth.json_b'), '{"account":"broken"}\n');

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => codexRateLimits();

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);
  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:1`, 1));

  assert.equal(restarts, 2);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_a'));
  assert.equal(rig.store.listCodexAuthCandidateStates().get('auth.json_b'), 'needs_repair');
  assert.match(rig.editedMessages.at(-1)!, /Selected auth failed validation: candidate is not a readable ChatGPT auth file/);
  assert.match(rig.editedMessages.at(-1)!, /Restored the previous auth after the failed switch/);
  assert.match(rig.editedMessages.at(-1)!, /\|b \[needs login repair\]/);
  assert.deepEqual(rig.editedKeyboards.at(-1)?.[1], [
    { text: '? —|—|b', callback_data: `auth:${list.localId}:repair:1` },
    { text: '?', callback_data: `auth:${list.localId}:repair:1` },
  ]);
});

test('/auth sync commands report status, test peers, and push all', async (t) => {
  let pushed = false;
  let tested = false;
  const rig = createControllerRig(null, {
    canSelfUpdate: () => true,
    getAuthSyncStatus: () => ({
      enabled: true,
      nodeId: 'node-a',
      transportLabel: '@botA',
      peers: ['@botB'],
      pendingImports: 0,
      lastSentAt: '2026-06-01T00:00:00.000Z',
      lastReceivedAt: null,
      lastImportedAt: null,
      lastImportCandidate: null,
      lastPullAt: null,
      lastPullCandidate: null,
      lastError: null,
      candidateFailures: [{
        candidateName: 'auth.json_bad',
        reason: 'token invalidated',
        sourceNodeId: 'node-b',
        sourceLabel: '@botB',
        peer: '@botB',
        mode: 'push',
        updatedAt: '2026-06-01T00:01:00.000Z',
      }],
      activeLeaseId: null,
      peerStatuses: [{ peer: '@botB', lastReceivedAt: '2026-06-01T00:02:00.000Z' }],
      recentEvents: [{
        id: 'evt-1',
        createdAt: '2026-06-01T00:03:00.000Z',
        direction: 'out',
        kind: 'push.bundle',
        stage: 'sent',
        peer: '@botB',
        requestId: 'req-1',
        candidateName: 'auth.json_bad',
        detail: null,
      }],
    }),
    authSyncSafeAll: async () => {
      pushed = true;
      return { localSynced: 3, localSkipped: 4, sent: 2, skipped: 1 };
    },
    authSyncTest: async () => {
      tested = true;
      return { sent: 1, replied: 0, missing: ['@botB'] };
    },
  });
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  await (rig.controller as any).handleCommand(createEvent('/auth sync status'), 'en', 'auth', ['sync', 'status']);
  await (rig.controller as any).handleCommand(createEvent('/auth sync events auth.json_bad'), 'en', 'auth', ['sync', 'events', 'auth.json_bad']);
  await (rig.controller as any).handleCommand(createEvent('/auth sync trace req-1'), 'en', 'auth', ['sync', 'trace', 'req-1']);
  await (rig.controller as any).handleCommand(createEvent('/auth sync test'), 'en', 'auth', ['sync', 'test']);
  await (rig.controller as any).handleCommand(createEvent('/auth sync push all'), 'en', 'auth', ['sync', 'push', 'all']);

  assert.match(rig.sentMessages[0]!, /Cross-node auth sync:/);
  assert.match(rig.sentMessages[0]!, /Node: node-a/);
  assert.match(rig.sentMessages[0]!, /Peer activity:/);
  assert.match(rig.sentMessages[0]!, /Recent events:/);
  assert.match(rig.sentMessages[0]!, /Candidate failures:/);
  assert.match(rig.sentMessages[0]!, /auth\.json_bad: token invalidated/);
  assert.match(rig.sentMessages[1]!, /Auth sync events:/);
  assert.match(rig.sentMessages[1]!, /requestId=req-1/);
  assert.match(rig.sentMessages[2]!, /Auth sync trace: req-1/);
  assert.match(rig.sentMessages[2]!, /candidate=auth\.json_bad/);
  assert.equal(rig.sentMessages[3], 'Auth sync test complete: sent 1, replies 0.\nMissing replies: @botB');
  assert.equal(rig.sentMessages[4], 'Safe auth sync complete: local synced 3, local skipped 4; cross-node sent 2, skipped 1.');
  assert.equal(tested, true);
  assert.equal(pushed, true);
});

test('/auth panel can trigger safe auth sync', async (t) => {
  let pushed = false;
  const rig = createControllerRig(null, {
    authSyncSafeAll: async () => {
      pushed = true;
      return { localSynced: 1, localSkipped: 2, sent: 3, skipped: 4 };
    },
  });
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  installTempAuthFiles(t, rig.tempDir);

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);
  assert.deepEqual(rig.sentKeyboards[0]?.at(-1), [
    { text: '🧷 Safe sync', callback_data: `auth:${list.localId}:safe_sync` },
    { text: '🔄 Reload auth', callback_data: `auth:${list.localId}:reload` },
  ]);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:safe_sync`, 1));

  assert.equal(pushed, true);
  assert.equal(rig.callbackAnswers.at(-1), 'Safely syncing auth across local bot runtimes and cross-node peers...');
  assert.equal(rig.editedMessages[0], 'Safely syncing auth across local bot runtimes and cross-node peers...');
  assert.match(rig.editedMessages.at(-1)!, /Safe auth sync complete: local synced 1, local skipped 2; cross-node sent 3, skipped 4\./);
  assert.match(rig.editedMessages.at(-1)!, /Codex auth files:/);
});

test('/auth switch recovers a newer same-account credential before restart and syncs after restart', async (t) => {
  const events: string[] = [];
  const rig = createControllerRig(null, {
    recoverAuthCandidate: async (runtimeId, candidateName, options) => {
      events.push(`recover:${runtimeId}:${candidateName}:crossNode=${String(options?.crossNode)}`);
      return true;
    },
    authCandidateUpdated: async (runtimeId, candidateName) => {
      events.push(`sync:${runtimeId}:${candidateName}`);
    },
  });
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());
  (rig.controller as any).app.restart = async () => {
    events.push('restart');
  };
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => codexRateLimits();

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);
  events.length = 0;

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:1`, 1));

  assert.deepEqual(events, [
    'recover:default:auth.json_b:crossNode=false',
    'restart',
    'sync:default:auth.json_b',
  ]);
  assert.match(rig.editedMessages.at(-1)!, /Current auth: b/);
  assert.equal((rig.controller as any).pendingAuthChoiceLists.get(list.localId), list);
});

test('/auth identifies the requesting bot runtime in multi-bot mode', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  installTempAuthFiles(t, rig.tempDir);
  (rig.controller as any).config.tgScopeBotId = 'bot123';
  (rig.controller as any).botUsername = 'bot_one';

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.match(rig.sentMessages[0]!, /Bot runtime: @bot_one \(bot123\)/);
});

test('/auth switch labels resolve symlink-backed auth files', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  const currentRealPath = path.join(authDir, 'personal-real.json');
  const targetRealPath = path.join(authDir, 'work-real.json');
  fs.writeFileSync(currentRealPath, `${JSON.stringify({ tokens: { account_id: 'acct-personal' }, last_refresh: new Date().toISOString() })}\n`);
  fs.writeFileSync(targetRealPath, `${JSON.stringify({ tokens: { account_id: 'acct-work' }, last_refresh: new Date().toISOString() })}\n`);
  fs.rmSync(path.join(authDir, 'auth.json_a'), { force: true });
  fs.rmSync(path.join(authDir, 'auth.json_b'), { force: true });
  fs.unlinkSync(path.join(authDir, 'auth.json'));
  fs.symlinkSync(currentRealPath, path.join(authDir, 'auth.json_a'));
  fs.symlinkSync(targetRealPath, path.join(authDir, 'auth.json_b'));
  fs.symlinkSync(path.join(authDir, 'auth.json_a'), path.join(authDir, 'auth.json'));

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => codexRateLimits();

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.match(rig.sentMessages[0]!, /Current auth: personal-real\.json/);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);
  const targetIndex = list.candidates.findIndex((candidate: any) => candidate.name === 'auth.json_b');
  assert.notEqual(targetIndex, -1);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:${targetIndex}`, 1));

  assert.equal(restarts, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_b'));
  assert.match(rig.editedMessages[0]!, /Switching Codex auth: personal-real\.json -> work-real\.json/);
  assert.match(rig.editedMessages.at(-1)!, /Current auth: work-real\.json/);
});

test('/auth panel can disable and enable candidates for auto rotation', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  installTempAuthFiles(t, rig.tempDir);

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.match(rig.sentMessages[0]!, /\|b \[invalid auth file\]/);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);
  assert.deepEqual(rig.sentKeyboards[0]?.slice(0, 2), [
    [
      { text: '✅ —|—|a', callback_data: `auth:${list.localId}:0` },
      { text: '✅', callback_data: `auth:${list.localId}:toggle:0` },
    ],
    [
      { text: '🔐 —|—|b', callback_data: `auth:${list.localId}:1` },
      { text: '✅', callback_data: `auth:${list.localId}:toggle:1` },
    ],
  ]);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:toggle:1`, 1));

  assert.deepEqual([...rig.store.listDisabledCodexAuthCandidateNames()], ['auth.json_b']);
  assert.equal(rig.callbackAnswers.at(-1), 'Auth disabled');
  assert.match(rig.editedMessages.at(-1)!, /\|b \[disabled\]/);
  assert.deepEqual(rig.editedKeyboards.at(-1)?.[1], [
    { text: '🔐 —|—|b · off', callback_data: `auth:${list.localId}:1` },
    { text: '⏸️', callback_data: `auth:${list.localId}:toggle:1` },
  ]);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:toggle:1`, 1));

  assert.deepEqual([...rig.store.listDisabledCodexAuthCandidateNames()], []);
  assert.equal(rig.callbackAnswers.at(-1), 'Auth enabled');
  assert.match(rig.editedMessages.at(-1)!, /\|b \[invalid auth file\]/);
  assert.deepEqual(rig.editedKeyboards.at(-1)?.[1], [
    { text: '🔐 —|—|b', callback_data: `auth:${list.localId}:1` },
    { text: '✅', callback_data: `auth:${list.localId}:toggle:1` },
  ]);
});

test('/auth records and displays current candidate remaining quota without probing other candidates', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  fs.rmSync(path.join(authDir, 'auth.json'), { force: true });
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());
  fs.symlinkSync(path.join(authDir, 'auth.json_a'), path.join(authDir, 'auth.json'));
  let reads = 0;
  (rig.controller as any).app.readAccountRateLimits = async () => {
    reads += 1;
    const usedPercent = reads === 1
      ? { primary: 80, secondary: 75 }
      : { primary: 10, secondary: 5 };
    return {
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: usedPercent.primary, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: usedPercent.secondary, windowDurationMins: 10080, resetsAt: null },
        credits: null,
        planType: 'plus',
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    };
  };

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.equal(reads, 1);
  assert.match(rig.sentMessages[0]!, /Quota remaining: window:percent\|auth/);
  assert.match(rig.sentMessages[0]!, /5h:20\|7d:25\|a \* \[Plus · ready · refreshed 0m ago\]/);
  assert.match(rig.sentMessages[0]!, /--\|b \[quota unknown · refreshed 0m ago\]/);
  assert.match(rig.sentKeyboards[0]?.[0]?.[0]?.text, /✅ 20\|25\|a/);
  assert.equal(
    fs.existsSync(path.join(rig.tempDir, 'codex-auth-quota.json')),
    true,
  );

  fs.unlinkSync(path.join(authDir, 'auth.json'));
  fs.symlinkSync(path.join(authDir, 'auth.json_b'), path.join(authDir, 'auth.json'));
  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.equal(reads, 2);
  assert.match(rig.sentMessages[1]!, /5h:20\|7d:25\|a \[Plus · ready · refreshed 0m ago\]/);
  assert.match(rig.sentMessages[1]!, /5h:90\|7d:95\|b \* \[Plus · ready · refreshed 0m ago\]/);
});

test('/auth supplements quota snapshots from other runtimes by quota identity id', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  fs.rmSync(path.join(authDir, 'auth.json'), { force: true });
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a');
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b');
  fs.symlinkSync(path.join(authDir, 'auth.json_a'), path.join(authDir, 'auth.json'));
  rig.store.setCodexAuthQuotaSnapshot('bot-other', 'auth.json_different_name', 'acct-b', 'acct-b', {
    capturedAtMs: 10_000,
    planType: 'plus',
    primaryWindowDurationMins: 300,
    primaryRemainingPercent: 70,
    secondaryWindowDurationMins: 10080,
    secondaryRemainingPercent: 65,
  });
  rig.store.setCodexAuthQuotaSnapshot('bot-conflict', 'auth.json_b', 'acct-c', 'acct-c', {
    capturedAtMs: 20_000,
    planType: 'plus',
    primaryWindowDurationMins: 300,
    primaryRemainingPercent: 5,
    secondaryWindowDurationMins: 10080,
    secondaryRemainingPercent: 4,
  });
  (rig.controller as any).app.readAccountRateLimits = async () => ({
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 75, windowDurationMins: 10080, resetsAt: null },
      credits: null,
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  });

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.match(rig.sentMessages[0]!, /5h:20\|7d:25\|a \* \[Plus · not recently refreshed · refreshed \d+d ago\]/);
  assert.match(rig.sentMessages[0]!, /5h:70\|7d:65\|b \[Plus · not recently refreshed · refreshed \d+d ago\]/);
  assert.doesNotMatch(rig.sentMessages[0]!, /5h:5\|7d:4\|b/);
});

test('/auth separates quota snapshots for ChatGPT users on the same account id', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  fs.rmSync(path.join(authDir, 'auth.json'), { force: true });
  const refreshedAt = new Date().toISOString();
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-team', refreshedAt, {
    userId: 'user-a',
    email: 'a@example.test',
  });
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-team', refreshedAt, {
    userId: 'user-b',
    email: 'b@example.test',
  });
  fs.symlinkSync(path.join(authDir, 'auth.json_a'), path.join(authDir, 'auth.json'));
  rig.store.setCodexAuthQuotaSnapshot('bot-other', 'auth.json_b', 'acct-team', 'acct-team:user:user-b', {
    capturedAtMs: Date.now(),
    planType: 'team',
    primaryWindowDurationMins: 300,
    primaryRemainingPercent: 98,
    secondaryWindowDurationMins: null,
    secondaryRemainingPercent: null,
  });
  (rig.controller as any).app.readAccountRateLimits = async () => ({
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      credits: null,
      planType: 'team',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  });

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.match(rig.sentMessages[0]!, /5h:86\|a \* \[Team · ready · refreshed 0m ago\]/);
  assert.match(rig.sentMessages[0]!, /5h:98\|b \[Team · ready · refreshed 0m ago\]/);
  assert.doesNotMatch(rig.sentMessages[0]!, /5h:86\|b/);
});

test('/auth marks team candidate as invalid when file email does not match candidate name', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  fs.rmSync(path.join(authDir, 'auth.json'), { force: true });
  fs.rmSync(path.join(authDir, 'auth.json_a'), { force: true });
  fs.rmSync(path.join(authDir, 'auth.json_b'), { force: true });
  const refreshedAt = new Date().toISOString();
  writeChatGptAuthCandidate(authDir, 'auth.json_team_jnmot7rqo4hle', 'acct-team', refreshedAt, {
    email: 'jnmot7rqo4hle@edu.aiceo.dev',
  });
  writeChatGptAuthCandidate(authDir, 'auth.json_team_jnmzk1668ese3', 'acct-team', refreshedAt, {
    email: 'jnmot7rqo4hle@edu.aiceo.dev',
  });
  fs.symlinkSync(path.join(authDir, 'auth.json_team_jnmot7rqo4hle'), path.join(authDir, 'auth.json'));
  fs.writeFileSync(path.join(rig.tempDir, 'codex-auth-quota.json'), `${JSON.stringify({
    'auth.json_team_jnmzk1668ese3': {
      capturedAtMs: Date.now(),
      accountId: 'acct-team',
      quotaIdentityId: 'acct-team:email:jnmot7rqo4hle@edu.aiceo.dev',
      planType: 'team',
      primaryWindowDurationMins: 300,
      primaryRemainingPercent: 33,
      secondaryWindowDurationMins: null,
      secondaryRemainingPercent: null,
    },
  })}\n`);
  (rig.controller as any).app.readAccountRateLimits = async () => ({
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 67, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      credits: null,
      planType: 'team',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  });

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  assert.match(rig.sentMessages[0]!, /5h:33\|team_jnmot7rqo4hle \* \[Team · ready · refreshed 0m ago\]/);
  assert.match(rig.sentMessages[0]!, /--\|team_jnmzk1668ese3 \[invalid auth file\]/);
  assert.doesNotMatch(rig.sentMessages[0]!, /5h:33\|team_jnmzk1668ese3/);
});

test('/auth panel paginates large inventories, filters attention candidates, and searches by filename', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  fs.rmSync(path.join(authDir, 'auth.json'), { force: true });
  fs.rmSync(path.join(authDir, 'auth.json_a'), { force: true });
  fs.rmSync(path.join(authDir, 'auth.json_b'), { force: true });
  const refreshedAt = new Date().toISOString();
  for (let index = 0; index < 100; index += 1) {
    writeChatGptAuthCandidate(
      authDir,
      `auth.json_free${String(index).padStart(3, '0')}`,
      `acct-${index}`,
      refreshedAt,
    );
  }
  fs.symlinkSync(path.join(authDir, 'auth.json_free000'), path.join(authDir, 'auth.json'));
  (rig.controller as any).app.readAccountRateLimits = async () => ({
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 3, windowDurationMins: 43200, resetsAt: null },
      secondary: null,
      credits: null,
      planType: 'free',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  });

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);

  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()].at(-1);
  assert.ok(list);
  assert.match(rig.sentMessages.at(-1)!, /Candidates: 100/);
  assert.match(rig.sentMessages.at(-1)!, /Showing 1-8 of 100 matched candidates \(100 total\), page 1\/13/);
  assert.match(rig.sentMessages.at(-1)!, /30d:97\|free000 \* \[Free · ready · refreshed 0m ago\]/);
  assert.match(rig.sentMessages.at(-1)!, /\|free007/);
  assert.doesNotMatch(rig.sentMessages.at(-1)!, /\|free008/);
  assert.equal(rig.sentKeyboards.at(-1)?.filter((row: any[]) => row[1]?.callback_data?.includes(':toggle:')).length, 8);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:page:next`, 1));

  assert.match(rig.editedMessages.at(-1)!, /Showing 9-16 of 100 matched candidates \(100 total\), page 2\/13/);
  assert.match(rig.editedMessages.at(-1)!, /\|free008/);
  assert.doesNotMatch(rig.editedMessages.at(-1)!, /\|free007/);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:filter:attention`, 1));

  assert.match(rig.editedMessages.at(-1)!, /Filter: attention/);
  assert.match(rig.editedMessages.at(-1)!, /Showing 1-8 of 99 matched candidates \(100 total\), page 1\/13/);
  assert.doesNotMatch(rig.editedMessages.at(-1)!, /\d+\. .*\|free000/);
  assert.match(rig.editedMessages.at(-1)!, /\|free001 \[quota unknown · refreshed 0m ago\]/);

  await (rig.controller as any).handleCommand(createEvent('/auth list free099'), 'en', 'auth', ['list', 'free099']);

  assert.match(rig.sentMessages.at(-1)!, /Search: free099/);
  assert.match(rig.sentMessages.at(-1)!, /\|free099/);
  assert.doesNotMatch(rig.sentMessages.at(-1)!, /\|free098/);
});

test('/auth panel can start device login from an inline action', async (t) => {
  const events: string[] = [];
  const rig = createControllerRig(null, {
    authCandidateUpdated: async (runtimeId, candidateName) => {
      events.push(`sync:${runtimeId}:${candidateName}`);
    },
  });
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);

  const calls: string[] = [];
  (rig.controller as any).app.startDeviceLogin = async () => {
    calls.push('start');
    return {
      type: 'chatgptDeviceCode',
      loginId: 'login-panel',
      verificationUrl: 'https://auth.example/device',
      userCode: 'PANEL-CODE',
    };
  };

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:login_device`, 1));

  assert.deepEqual(calls, ['start']);
  assert.equal(rig.callbackAnswers.at(-1), 'Device login started.');
  assert.match(rig.sentMessages.at(-1)!, /enable device code authorization for Codex/);
  assert.match(rig.sentMessages.at(-1)!, /PANEL-CODE/);

  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', '2026-06-05T01:00:00.000Z');
  await (rig.controller as any).handleNotification({
    method: 'account/login/completed',
    params: { loginId: 'login-panel', success: true, error: null },
  });

  assert.deepEqual(events, ['sync:default:auth.json_a']);
  assert.match(rig.sentMessages.at(-1)!, /Login completed/);
});

test('/auth marks repair candidates with a question action and can repair login', async (t) => {
  const events: string[] = [];
  const rig = createControllerRig(null, {
    authCandidateUpdated: async (runtimeId, candidateName) => {
      events.push(`sync:${runtimeId}:${candidateName}`);
    },
  });
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  rig.store.setCodexAuthCandidateState('auth.json_b', 'needs_repair');

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.startDeviceLogin = async () => ({
    type: 'chatgptDeviceCode',
    loginId: 'login-repair',
    verificationUrl: 'https://auth.example/device',
    userCode: 'REPAIR-CODE',
  });

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);
  assert.match(rig.sentMessages[0]!, /\|b \[needs login repair\]/);
  assert.deepEqual(rig.sentKeyboards[0]?.[1], [
    { text: '? —|—|b', callback_data: `auth:${list.localId}:repair:1` },
    { text: '?', callback_data: `auth:${list.localId}:repair:1` },
  ]);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:repair:1`, 1));

  assert.equal(rig.callbackAnswers.at(-1), 'Repair actions');
  assert.match(rig.editedMessages.at(-1)!, /b has been verified unusable/);
  assert.deepEqual(rig.editedKeyboards.at(-1), [
    [{ text: '🔑 Login repair', callback_data: `auth:${list.localId}:repair_login:1` }],
    [{ text: '🗑️ Delete', callback_data: `auth:${list.localId}:repair_delete:1` }],
    [{ text: '✖️ Cancel', callback_data: `auth:${list.localId}:repair_cancel:1` }],
  ]);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:repair_login:1`, 1));

  assert.equal(rig.callbackAnswers.at(-1), 'Device login started.');
  assert.equal(restarts, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_b'));
  assert.match(rig.sentMessages.at(-1)!, /REPAIR-CODE/);

  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', '2026-06-08T01:00:00.000Z');
  await (rig.controller as any).handleNotification({
    method: 'account/login/completed',
    params: { loginId: 'login-repair', success: true, error: null },
  });

  assert.equal(rig.store.listCodexAuthCandidateStates().get('auth.json_b'), 'active');
  assert.deepEqual([...rig.store.listDisabledCodexAuthCandidateNames()], []);
  assert.deepEqual(events, ['sync:default:auth.json_b']);
  assert.match(rig.sentMessages.at(-1)!, /Auth candidate repaired: auth\.json_b/);
});

test('/auth repair menu can delete an unrecoverable candidate', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  rig.store.setCodexAuthCandidateState('auth.json_b', 'needs_repair');

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:repair:1`, 1));
  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:repair_delete:1`, 1));

  assert.equal(rig.callbackAnswers.at(-1), 'Auth deleted');
  assert.equal(fs.existsSync(path.join(authDir, 'auth.json_b')), false);
  assert.equal(rig.store.listCodexAuthCandidateStates().get('auth.json_b'), undefined);
  assert.match(rig.editedMessages.at(-1)!, /Deleted auth candidate: auth\.json_b/);
  assert.doesNotMatch(rig.editedMessages.at(-1)!, /\|b \[/);
});

test('/auth refresh all command can refresh all ChatGPT candidates and keep an auth panel', async (t) => {
  const events: string[] = [];
  const rig = createControllerRig(null, {
    canSelfUpdate: () => true,
    authCandidateUpdated: async (runtimeId, candidateName) => {
      events.push(`sync:${runtimeId}:${candidateName}`);
    },
  });
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', '2026-01-01T00:00:00.000Z');
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', '2026-01-01T00:00:00.000Z');
  fs.writeFileSync(path.join(authDir, 'auth.json_api'), '{"openai_api_key":"sk-test"}\n');

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async (refreshToken = false) => {
    assert.equal(refreshToken, true);
    const currentName = path.basename(fs.realpathSync(path.join(authDir, 'auth.json')));
    events.push(`refresh:${currentName}`);
    writeChatGptAuthCandidate(
      authDir,
      currentName,
      currentName === 'auth.json_a' ? 'acct-a' : 'acct-b',
      currentName === 'auth.json_a' ? '2026-02-01T00:00:00.000Z' : '2026-02-02T00:00:00.000Z',
    );
    return {
      type: 'chatgpt',
      email: 'user@example.com',
      planType: 'plus',
      requiresOpenaiAuth: false,
    };
  };
  (rig.controller as any).app.readAccountRateLimits = async () => ({
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: null },
      credits: null,
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  });

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);
  assert.deepEqual(rig.sentKeyboards[0]?.at(-1), [
    { text: '🧷 Safe sync', callback_data: `auth:${list.localId}:safe_sync` },
    { text: '🔄 Reload auth', callback_data: `auth:${list.localId}:reload` },
  ]);
  events.length = 0;

  await (rig.controller as any).handleCommand(createEvent('/auth refresh all'), 'en', 'auth', ['refresh', 'all']);
  const confirmationList = [...(rig.controller as any).pendingAuthChoiceLists.values()].at(-1);
  assert.ok(confirmationList);

  assert.equal(restarts, 0);
  assert.deepEqual(events, []);
  assert.match(rig.sentMessages.at(-1)!, /will rotate ChatGPT refresh tokens/);
  assert.deepEqual(rig.sentKeyboards.at(-1), [
    [{ text: '⚠️ Accept risk & refresh', callback_data: `auth:${confirmationList.localId}:refresh_all_confirm` }],
    [{ text: '✖️ Cancel', callback_data: `auth:${confirmationList.localId}:refresh_all_cancel` }],
  ]);

  await (rig.controller as any).handleCallback(createCallback(`auth:${confirmationList.localId}:refresh_all_confirm`, rig.sentMessages.length));

  assert.equal(rig.callbackAnswers.at(-1), 'Refreshing all ChatGPT auth candidates. Every runtime must stay idle...');
  assert.equal(restarts, 3);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_a'));
  assert.deepEqual(events, [
    'refresh:auth.json_a',
    'sync:default:auth.json_a',
    'refresh:auth.json_b',
    'sync:default:auth.json_b',
  ]);
  assert.match(rig.editedMessages[0]!, /Refreshing all ChatGPT auth candidates/);
  assert.match(rig.editedMessages.at(-1)!, /Auth refresh all complete: 2 refreshed, 1 skipped, 0 failed/);
  assert.match(rig.editedMessages.at(-1)!, /Current auth: a/);
  assert.deepEqual(rig.editedKeyboards.at(-1)?.at(-1), [
    { text: '🧷 Safe sync', callback_data: `auth:${confirmationList.localId}:safe_sync` },
    { text: '🔄 Reload auth', callback_data: `auth:${confirmationList.localId}:reload` },
  ]);
  assert.match(fs.readFileSync(path.join(authDir, 'auth.json_a'), 'utf8'), /2026-02-01T00:00:00.000Z/);
  assert.match(fs.readFileSync(path.join(authDir, 'auth.json_b'), 'utf8'), /2026-02-02T00:00:00.000Z/);
});

test('proactive auth refresh locks peers and refreshes stale enabled ChatGPT candidates only', async (t) => {
  const events: string[] = [];
  const rig = createControllerRig(null, {
    acquireAuthRefreshLease: async (reason) => {
      events.push(`lease:${reason}`);
      return { ok: true, leaseId: 'lease-proactive' };
    },
    releaseAuthRefreshLease: async (leaseId) => {
      events.push(`release:${leaseId}`);
    },
    authCandidateUpdated: async (runtimeId, candidateName) => {
      events.push(`sync:${runtimeId}:${candidateName}`);
    },
  });
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  rig.store.rememberTelegramPrivateScope('bot1', 'telegram:99::root', '99');
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', '2026-01-01T00:00:00.000Z');
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_c', 'acct-c', '2026-01-01T00:00:00.000Z');
  rig.store.setCodexAuthCandidateDisabled('auth.json_c', true, 'default');

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async (refreshToken = false) => {
    assert.equal(refreshToken, true);
    const currentName = path.basename(fs.realpathSync(path.join(authDir, 'auth.json')));
    events.push(`refresh:${currentName}`);
    writeChatGptAuthCandidate(authDir, currentName, 'acct-a', '2026-02-01T00:00:00.000Z');
    return {
      type: 'chatgpt',
      email: 'user@example.com',
      planType: 'plus',
      requiresOpenaiAuth: false,
    };
  };
  (rig.controller as any).app.readAccountRateLimits = async () => ({
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      credits: null,
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  });

  await (rig.controller as any).runProactiveAuthRefresh();

  assert.equal(restarts, 2);
  assert.deepEqual(events, [
    'lease:proactive auth refresh: auth.json_a',
    'refresh:auth.json_a',
    'sync:default:auth.json_a',
    'release:lease-proactive',
  ]);
  assert.match(rig.sentMessages[0]!, /Proactive auth refresh started/);
  assert.match(rig.editedMessages.at(-1)!, /Proactive auth refresh complete: 1 refreshed, 0 skipped, 0 failed/);
  assert.match(fs.readFileSync(path.join(authDir, 'auth.json_a'), 'utf8'), /2026-02-01T00:00:00.000Z/);
  assert.doesNotMatch(fs.readFileSync(path.join(authDir, 'auth.json_b'), 'utf8'), /2026-02-01T00:00:00.000Z/);
  assert.doesNotMatch(fs.readFileSync(path.join(authDir, 'auth.json_c'), 'utf8'), /2026-02-01T00:00:00.000Z/);
});

test('plain messages wait while external auth validation restarts app-server', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  installTempAuthFiles(t, rig.tempDir);
  let releaseRestart!: () => void;
  let restartStarted!: () => void;
  const restartStartedPromise = new Promise<void>((resolve) => {
    restartStarted = resolve;
  });
  const releaseRestartPromise = new Promise<void>((resolve) => {
    releaseRestart = resolve;
  });
  t.after(() => releaseRestart?.());
  let restartCalls = 0;
  let startThreadCalls = 0;
  (rig.controller as any).app.restart = async () => {
    restartCalls += 1;
    if (restartCalls === 1) {
      restartStarted();
      await releaseRestartPromise;
    }
  };
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => codexRateLimits();
  (rig.controller as any).app.startThread = async () => {
    startThreadCalls += 1;
    throw new Error('startThread should wait during external auth validation');
  };

  const rawAuth = `${JSON.stringify({
    tokens: { account_id: 'acct-remote' },
    last_refresh: '2026-02-01T00:00:00.000Z',
  })}\n`;
  const validation = (rig.controller as any).validateExternalCodexAuthCandidate('auth.json_remote', rawAuth, 'acct-remote');
  await restartStartedPromise;

  assert.equal((rig.controller as any).isIdleForServiceUpdate(), false);
  await (rig.controller as any).handleText(createEvent('continue'));

  assert.equal(startThreadCalls, 0);
  assert.match(rig.sentMessages.at(-1)!, /Auth sync is validating refreshed credentials/);
  releaseRestart();
  assert.deepEqual(await validation, { ok: true });
  assert.equal((rig.controller as any).isIdleForServiceUpdate(), true);
});

test('/auth panel refresh all is blocked until every runtime is idle', async (t) => {
  const rig = createControllerRig(null, {
    canSelfUpdate: () => false,
  });
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  installTempAuthFiles(t, rig.tempDir);

  await (rig.controller as any).handleCommand(createEvent('/auth'), 'en', 'auth', []);
  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);

  await (rig.controller as any).handleCallback(createCallback(`auth:${list.localId}:refresh_all`, 1));

  assert.match(rig.callbackAnswers.at(-1)!, /Cannot refresh all auth candidates/);
  assert.equal(rig.editedMessages.length, 0);
});

test('/auth refresh all command requires explicit risk confirmation', async (t) => {
  const rig = createControllerRig(null, {
    canSelfUpdate: () => true,
  });
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  installTempAuthFiles(t, rig.tempDir);

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };

  await (rig.controller as any).handleCommand(createEvent('/auth refresh all'), 'en', 'auth', ['refresh', 'all']);

  const list = [...(rig.controller as any).pendingAuthChoiceLists.values()][0];
  assert.ok(list);
  assert.equal(restarts, 0);
  assert.match(rig.sentMessages.at(-1)!, /will rotate ChatGPT refresh tokens/);
  assert.deepEqual(rig.sentKeyboards.at(-1), [
    [{ text: '⚠️ Accept risk & refresh', callback_data: `auth:${list.localId}:refresh_all_confirm` }],
    [{ text: '✖️ Cancel', callback_data: `auth:${list.localId}:refresh_all_cancel` }],
  ]);
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
  assert.match(rig.sentMessages[1]!, /enable device code authorization for Codex/);
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

  assert.match(rig.sentMessages.at(-1)!, /\|work \*/);
});

test('/auth add cancel restores previous auth', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());

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

test('auth auto-rotation first tries to recover the current candidate', async (t) => {
  const events: string[] = [];
  const rig = createControllerRig(null, {
    recoverAuthCandidate: async (runtimeId, candidateName, options) => {
      events.push(`recover:${runtimeId}:${candidateName}:crossNode=${String(options?.crossNode)}`);
      return true;
    },
    authCandidateUpdated: async (runtimeId, candidateName) => {
      events.push(`sync:${runtimeId}:${candidateName}`);
    },
  });
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
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => binding;
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
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  });

  assert.deepEqual(events, ['recover:default:auth.json_a:crossNode=true', 'sync:default:auth.json_a']);
  assert.equal(restarts, 1);
  assert.equal(retryStarts.length, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_a'));
  assert.ok(rig.sentMessages.some(message => /Recovered a newer same-account credential for auth\.json_a/.test(message)));
  assert.ok(hasActiveTurnForTest(rig, 'turn-2'));
});

test('usage limit errors auto-rotate auth after a final auth error', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());

  let restarts = 0;
  const retryReadies: any[] = [];
  const retryStarts: any[] = [];
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => codexRateLimits();
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any, options: any) => {
    retryReadies.push({ binding, options });
    return binding;
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
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: { message: 'Usage limit exceeded', codexErrorInfo: 'usageLimitExceeded' },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  });

  assert.equal(restarts, 1);
  assert.equal(retryReadies.length, 1);
  assert.equal(retryReadies[0].binding.chatId, 'telegram:99::root');
  assert.equal(retryReadies[0].binding.threadId, 'thread-1');
  assert.equal(retryReadies[0].binding.cwd, rig.tempDir);
  assert.equal(typeof retryReadies[0].binding.updatedAt, 'number');
  assert.deepEqual(retryReadies[0].options, { recoverMissingThread: false });
  assert.equal(retryStarts.length, 1);
  assert.equal(retryStarts[0].binding, retryReadies[0].binding);
  assert.deepEqual(retryStarts.map(({ input, overrides }) => ({ input, overrides })), [{
    input: [{ type: 'text', text: 'try this', text_elements: [] }],
    overrides: { collaborationMode: undefined, recoverMissingThread: false },
  }]);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_b'));
  assert.ok(rig.sentMessages.some(message => /Auto-switched Codex auth: auth\.json_a -> auth\.json_b/.test(message)));
  assert.ok(rig.sentMessages.includes('Retrying the same request with the new auth...'));
  assert.ok(hasActiveTurnForTest(rig, 'turn-2'));
  assert.equal(rig.store.listCodexAuthCandidateStates().get('auth.json_a'), 'needs_repair');

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: { message: 'Usage limit exceeded again', codexErrorInfo: 'usageLimitExceeded' },
      threadId: 'thread-1',
      turnId: 'turn-2',
      willRetry: false,
    },
  });

  assert.equal(restarts, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_b'));
  assert.ok(rig.sentMessages.some(message => /no unused auth candidate is available/.test(message)));
  assert.equal(rig.store.listCodexAuthCandidateStates().get('auth.json_b'), 'needs_repair');
});

test('auth auto-rotation skips disabled candidates', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_c', 'acct-c', new Date().toISOString());
  rig.store.setCodexAuthCandidateDisabled('auth.json_b', true);

  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => codexRateLimits();
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => binding;
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any) => ({
    threadId: binding.threadId,
    turnId: 'turn-2',
  });
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
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: { message: 'Usage limit exceeded', codexErrorInfo: 'usageLimitExceeded' },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  });

  assert.equal(restarts, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_c'));
  assert.ok(rig.sentMessages.some(message => /Auto-switched Codex auth: auth\.json_a -> auth\.json_c/.test(message)));
});

test('auth rotation retries on the scope that owns authRetry even with another bound scope active', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());

  const retryStarts: any[] = [];
  (rig.controller as any).app.restart = async () => {};
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => codexRateLimits();
  (rig.controller as any).ensureThreadReady = async (scopeId: string, binding: any, options: any) => ({
    ...binding,
    scopeId,
    options,
  });
  (rig.controller as any).startTurnWithRecovery = async (scopeId: string, binding: any, input: any[], overrides: any) => {
    retryStarts.push({ scopeId, binding, input, overrides });
    return { threadId: binding.threadId, turnId: 'turn-2' };
  };
  (rig.controller as any).queueTurnRender = async () => {};
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};

  const telegramActive = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  const weixinActive = (rig.controller as any).createActiveTurnState('weixin:acc1:wx-user-1', 'wx-user-1', 'private', null, 'thread-1', 'turn-1', 0);
  weixinActive.authRetry = {
    input: [{ type: 'text', text: 'from weixin', text_elements: [] }],
    threadId: 'thread-1',
    cwd: rig.tempDir,
    chatId: 'wx-user-1',
    chatType: 'private',
    topicId: null,
    failedAuthTargets: new Set(),
  };
  setActiveTurnForTest(rig, telegramActive);
  setActiveTurnForTest(rig, weixinActive);

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: { message: 'Usage limit exceeded', codexErrorInfo: 'usageLimitExceeded' },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  });

  assert.equal(retryStarts.length, 1);
  assert.equal(retryStarts[0].scopeId, 'weixin:acc1:wx-user-1');
  assert.equal(getActiveTurnForTest(rig, 'weixin:acc1:wx-user-1', 'turn-2')?.chatId, 'wx-user-1');
  assert.equal(getActiveTurnForTest(rig, 'telegram:99::root', 'turn-2'), null);
  assert.ok(rig.sentMessages.includes('Retrying the same request with the new auth...'));
});

test('auth retry stops instead of creating a replacement thread when original thread is missing', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());

  let restarts = 0;
  let retryStartCalls = 0;
  const retryReadies: any[] = [];
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => codexRateLimits();
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any, options: any) => {
    retryReadies.push({ binding, options });
    throw new Error('thread not found');
  };
  (rig.controller as any).startTurnWithRecovery = async () => {
    retryStartCalls += 1;
    return { threadId: 'thread-1', turnId: 'turn-2' };
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
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: { message: 'Usage limit exceeded', codexErrorInfo: 'usageLimitExceeded' },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  });

  assert.equal(restarts, 1);
  assert.equal(retryReadies.length, 1);
  assert.equal(retryReadies[0].binding.threadId, 'thread-1');
  assert.deepEqual(retryReadies[0].options, { recoverMissingThread: false });
  assert.equal(retryStartCalls, 0);
  assert.ok(rig.sentMessages.some(message => /original thread is no longer available/.test(message)));
});

test('Codex error notifications are shown on the active Telegram turn', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  setActiveTurnForTest(rig, active);

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

test('ChatGPT backend HTML 403 errors are summarized and do not rotate auth', async (t) => {
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
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleNotification({
    method: 'error',
    params: {
      error: {
        message: 'unexpected status 403 Forbidden: <html><head><style global>body{}</style></head><body><p>Unable to load site</p><script>x()</script></body></html>, url: wss://chatgpt.com/backend-api/codex/responses, cf-ray: 9fb7e2029dfd68e6-LAX',
        codexErrorInfo: 'other',
        additionalDetails: null,
      },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
    },
  });

  assert.equal(restarts, 0);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_a'));
  const message = rig.sentMessages.find(entry => entry.startsWith('Codex error: ChatGPT backend 403 Forbidden'));
  assert.ok(message);
  assert.doesNotMatch(message, /<html|style global|script/i);
  assert.ok(message.length < 400);
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
  setActiveTurnForTest(rig, active);

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

  const active = (rig.controller as any).createActiveTurnState(
    'telegram:99::root',
    '99',
    'private',
    null,
    'thread-1',
    'turn-1',
    0,
    false,
    'plan',
  );
  active.segments = [{
    itemId: 'plan-1',
    phase: 'commentary',
    outputKind: 'commentary',
    isPlan: true,
    text: '- Inspect\n- Patch',
    completed: true,
    messages: [],
  }];
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.match(rig.sentMessages[0]!, /Plan mode produced a plan/);
  const pending = rig.store.findOpenGuidedPlanSession('telegram:99::root', 'turn-1');
  assert.ok(pending);

  await (rig.controller as any).handleCallback(createCallback(`planimpl:${pending.sessionId}:run`, 1));

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

  const active = (rig.controller as any).createActiveTurnState(
    'telegram:99::root',
    '99',
    'private',
    null,
    'thread-1',
    'turn-1',
    0,
    false,
    'plan',
  );
  setActiveTurnForTest(rig, active);

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
  const pendingPlan = rig.store.findOpenGuidedPlanSession('telegram:99::root', 'turn-1');
  assert.ok(pendingPlan);
  assert.match(pendingPlan.planMarkdown, /Patch plan implementation prompt/);
});

test('weixin default turn with proposed_plan final offers plan implementation command', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const scope = 'weixin:acc1:wx-user-1';
  rig.store.setChatLocale(scope, 'zh');
  rig.store.setBinding(scope, 'thread-1', rig.tempDir);
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};

  const active = (rig.controller as any).createActiveTurnState(
    scope,
    'wx-user-1',
    'private',
    null,
    'thread-1',
    'turn-1',
    0,
    false,
    'default',
  );
  active.segments = [{
    itemId: 'final-1',
    phase: 'final',
    outputKind: 'final_answer',
    isPlan: false,
    text: '<proposed_plan>\n# 计划\n- 修改 /auth 面板\n</proposed_plan>',
    completed: true,
    messages: [],
  }];
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  const pending = rig.store.findOpenGuidedPlanSession(scope, 'turn-1');
  assert.ok(pending);
  assert.match(pending.planMarkdown, /修改 \/auth 面板/);
  assert.match(rig.sentMessages.at(-1)!, /Plan 模式已经产出计划/);
  assert.match(rig.sentMessages.at(-1)!, new RegExp(`/planimpl ${pending.sessionId} run`));
});

test('default turn plan progress does not offer implementation without proposed_plan tag', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};

  const active = (rig.controller as any).createActiveTurnState(
    'telegram:99::root',
    '99',
    'private',
    null,
    'thread-1',
    'turn-1',
    0,
    false,
    'default',
  );
  active.segments = [{
    itemId: 'plan-1',
    phase: 'commentary',
    outputKind: 'commentary',
    isPlan: true,
    text: '- Inspect\n- Patch',
    completed: true,
    messages: [],
  }];
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.equal(rig.store.findOpenGuidedPlanSession('telegram:99::root', 'turn-1'), null);
  assert.ok(!rig.sentMessages.some(message => /Plan mode produced a plan/.test(message)));
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
  setActiveTurnForTest(rig, active);

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
  assert.match(rig.sentMessages[0]!, /enable device code authorization for Codex/);
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

test('/config toggles auth auto-delete and writes the env file', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  (rig.controller as any).app.readConfig = async () => ({
    config: { model: 'gpt-5', approval_policy: 'never', sandbox_mode: 'read-only' },
    layers: [],
    origins: {},
  });

  await (rig.controller as any).handleCommand(
    createEvent('/config auth_auto_delete on'),
    'en',
    'config',
    ['auth_auto_delete', 'on'],
  );

  assert.equal((rig.controller as any).config.authAutoDeleteNeedsRepair, true);
  assert.match(rig.sentMessages.at(-1)!, /Auto-delete unrecoverable auth candidates set to: yes/);
  assert.match(rig.sentMessages.at(-1)!, /Auth pool: total seen 0, alive 0, invalid-deleted 0\./);
  assert.match(fs.readFileSync(path.join(rig.tempDir, '.env'), 'utf8'), /AUTH_AUTO_DELETE_NEEDS_REPAIR=true/);
  assert.equal(rig.sentKeyboards.at(-1)?.[0]?.[0]?.callback_data, 'config:auth_auto_delete:off');

  await (rig.controller as any).handleCallback(createCallback('config:auth_auto_delete:off', 1));

  assert.equal((rig.controller as any).config.authAutoDeleteNeedsRepair, false);
  assert.equal(rig.callbackAnswers.at(-1), 'Decision recorded');
  assert.match(rig.editedMessages.at(-1)!, /Auto-delete unrecoverable auth candidates set to: no/);
  assert.match(fs.readFileSync(path.join(rig.tempDir, '.env'), 'utf8'), /AUTH_AUTO_DELETE_NEEDS_REPAIR=false/);
  assert.equal(rig.editedKeyboards.at(-1)?.[0]?.[0]?.callback_data, 'config:auth_auto_delete:on');
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
    cwd: '/tmp/panel',
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
  assert.match(rig.sentHtmlMessages[0]!, /\n✅ 1\. panel\|Panel thread/);
  assert.deepEqual(rig.sentHtmlKeyboards[0], [
    [{ text: '✅ 1. panel|Panel thread', callback_data: 'thread:open:thread-panel' }],
    [
      { text: '✏️', callback_data: 'thread:rename:thread-panel' },
      { text: '👀', callback_data: 'thread:watch:thread-panel' },
      { text: '🗑️', callback_data: 'thread:archive:thread-panel' },
      { text: '➕', callback_data: 'thread:new:thread-panel' },
    ],
    [{ text: '➕ New', callback_data: 'thread:new' }],
    [{ text: '🗄️ Archived', callback_data: 'thread:list:archived' }],
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
    cwd: '/tmp/archive',
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
  assert.match(rig.sentHtmlMessages[0]!, /\n1\. archive\|Archived work/);
  assert.deepEqual(rig.sentHtmlKeyboards[0], [
    [{ text: '1. archive|Archived work', callback_data: 'thread:open:thread-archived' }],
    [{ text: '♻️ Unarchive', callback_data: 'thread:unarchive:thread-archived' }],
    [{ text: '➕ New', callback_data: 'thread:new' }],
    [{ text: '🕘 Recent', callback_data: 'thread:list:recent' }],
  ]);

  await (rig.controller as any).handleCallback(createCallback('thread:unarchive:thread-archived', 1001));

  assert.deepEqual(calls, ['unarchive:thread-archived']);
  assert.equal(rig.store.getBinding('telegram:99::root')?.threadId, 'thread-archived');
  assert.equal(rig.callbackAnswers.at(-1), 'Thread unarchived');
  assert.deepEqual(listArchived, [true, false]);
});

test('/threads panel supports new-thread PWD prompt and watch callback', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    (rig.controller as any).clearObservedThreadWatchers();
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const sessionPath = path.join(rig.tempDir, 'watched-session.jsonl');
  fs.writeFileSync(sessionPath, '');
  const thread = {
    threadId: 'thread-panel',
    name: 'Panel thread',
    preview: 'work',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'cli',
    path: sessionPath,
    status: 'idle' as const,
    updatedAt: 1,
  };
  (rig.controller as any).app.listThreads = async () => [thread];
  (rig.controller as any).app.resumeThread = async ({ threadId }: { threadId: string }) => ({
    thread: { ...thread, threadId },
    model: 'gpt-5',
    modelProvider: 'openai',
    reasoningEffort: 'medium',
    cwd: rig.tempDir,
  });
  (rig.controller as any).app.readThread = async () => thread;
  (rig.controller as any).app.listThreadTurns = async () => [
    {
      turnId: 'turn-latest',
      status: 'completed',
      error: null,
      items: [
        { itemId: 'user-latest', type: 'userMessage', phase: null, text: 'resume this thread', command: null, status: null, aggregatedOutput: null },
        { itemId: 'codex-latest', type: 'agentMessage', phase: 'final_answer', text: 'ready to continue', command: null, status: null, aggregatedOutput: null },
      ],
    },
  ];

  await (rig.controller as any).handleText(createEvent('/threads'));
  await (rig.controller as any).handleCallback(createCallback('thread:new:thread-panel', 1001));

  assert.equal(rig.callbackAnswers.at(-1), 'Starting new thread');
  assert.equal(rig.store.getBinding('telegram:99::root')?.threadId, 'thread-new');
  assert.equal(rig.store.getBinding('telegram:99::root')?.cwd, rig.tempDir);
  assert.match(rig.sentMessages.at(-1)!, /Started new thread thread-new/);

  await (rig.controller as any).handleCallback(createCallback('thread:new', 1001));

  assert.equal(rig.callbackAnswers.at(-1), 'Send PWD');
  assert.match(rig.sentMessages.at(-1)!, /Send the PWD for the new thread/);

  const newCwd = path.join(rig.tempDir, 'project-a');
  fs.mkdirSync(newCwd, { recursive: true });
  await (rig.controller as any).handleText(createEvent(newCwd));

  assert.equal(rig.store.getBinding('telegram:99::root')?.threadId, 'thread-new');
  assert.equal(rig.store.getBinding('telegram:99::root')?.cwd, newCwd);
  assert.match(rig.sentMessages.at(-1)!, /Started new thread thread-new/);

  await (rig.controller as any).handleCallback(createCallback('thread:watch:thread-panel', 1001));

  const watcher = (rig.controller as any).observedThreadWatchers.get('telegram:99::root');
  assert.equal(watcher?.threadId, 'thread-panel');
  assert.equal(watcher?.mode, 'session_file');
  assert.equal(rig.store.getBinding('telegram:99::root')?.threadId, 'thread-panel');
  assert.match(rig.callbackAnswers.at(-1)!, /Watching thread thread-panel/);
  assert.match(rig.sentMessages.at(-1)!, /Recent context:\nUser:\nresume this thread\n\nCodex:\nready to continue/);
});

test('/new asks before creating a missing PWD and starts there after confirmation', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const newCwd = path.join(rig.tempDir, 'missing-project', 'app');
  assert.equal(fs.existsSync(newCwd), false);

  await (rig.controller as any).handleText(createEvent(`/new ${newCwd}`));

  assert.equal(fs.existsSync(newCwd), false);
  assert.equal(rig.store.getBinding('telegram:99::root'), null);
  assert.match(rig.sentMessages.at(-1)!, /PWD does not exist/);
  assert.match(rig.sentMessages.at(-1)!, new RegExp(newCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await (rig.controller as any).handleCallback(createCallback('thread:newcwd:create'));

  assert.equal(fs.existsSync(newCwd), true);
  assert.equal(rig.store.getBinding('telegram:99::root')?.threadId, 'thread-new');
  assert.equal(rig.store.getBinding('telegram:99::root')?.cwd, newCwd);
  assert.match(rig.editedMessages.at(-1)!, /Created directory/);
  assert.match(rig.sentMessages.at(-1)!, /Started new thread thread-new/);
});

test('turn notifications create independent active turns for every bound scope', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const wxScope = 'weixin:acc1:wx-user-1';
  rig.store.setBinding('telegram:99::root', 'thread-shared', rig.tempDir);
  rig.store.setBinding(wxScope, 'thread-shared', rig.tempDir);
  (rig.controller as any).queueTurnRender = async () => {};

  await (rig.controller as any).handleTurnStartedNotification({
    threadId: 'thread-shared',
    turn: { id: 'turn-shared' },
  });

  assert.ok(getActiveTurnForTest(rig, 'telegram:99::root', 'turn-shared'));
  assert.ok(getActiveTurnForTest(rig, wxScope, 'turn-shared'));

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'agent_message_delta',
    turnId: 'turn-shared',
    itemId: 'item-1',
    outputKind: 'final_answer',
    delta: 'hello',
  });

  assert.equal(getActiveTurnForTest(rig, 'telegram:99::root', 'turn-shared')?.buffer, 'hello');
  assert.equal(getActiveTurnForTest(rig, wxScope, 'turn-shared')?.buffer, 'hello');
});

test('observed watcher keeps a separate active turn for the same turn id', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    (rig.controller as any).clearObservedThreadWatchers();
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const tgActive = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  const wxActive = (rig.controller as any).createActiveTurnState('weixin:acc1:wx-user-1', 'wx-user-1', 'private', null, 'thread-1', 'turn-1', 0, true);
  setActiveTurnForTest(rig, tgActive);
  setActiveTurnForTest(rig, wxActive);
  (rig.controller as any).observedThreadWatchers.set('weixin:acc1:wx-user-1', {
    scopeId: 'weixin:acc1:wx-user-1',
    chatId: 'wx-user-1',
    chatType: 'private',
    topicId: null,
    threadId: 'thread-1',
    mode: 'app_snapshot',
    timer: null,
    cursor: null,
    activeTurnId: 'turn-1',
    waitingOnApproval: false,
    sessionPath: null,
    sessionOffset: -1,
    sessionRemainder: '',
    sessionCursor: { activeTurnId: null, nextMessageIndex: 0 },
    stopped: false,
  });
  (rig.controller as any).queueTurnRender = async () => {};

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'agent_message_delta',
    turnId: 'turn-1',
    itemId: 'item-1',
    outputKind: 'final_answer',
    delta: 'op',
  }, 'telegram:99::root');
  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'agent_message_delta',
    turnId: 'turn-1',
    itemId: 'item-1',
    outputKind: 'final_answer',
    delta: 'wx',
  }, 'weixin:acc1:wx-user-1');

  assert.equal(getActiveTurnForTest(rig, 'telegram:99::root', 'turn-1')?.buffer, 'op');
  assert.equal(getActiveTurnForTest(rig, 'weixin:acc1:wx-user-1', 'turn-1')?.buffer, 'wx');
});

test('approval requests are mirrored to watcher scopes and can be approved there', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    (rig.controller as any).clearObservedThreadWatchers();
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const wxScope = 'weixin:acc1:wx-user-1';
  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  rig.store.setBinding(wxScope, 'thread-1', rig.tempDir);
  rig.store.setChatLocale(wxScope, 'zh');
  (rig.controller as any).observedThreadWatchers.set(wxScope, {
    scopeId: wxScope,
    chatId: 'wx-user-1',
    chatType: 'private',
    topicId: null,
    threadId: 'thread-1',
    mode: 'app_snapshot',
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
  const responses: any[] = [];
  (rig.controller as any).app.respond = async (requestId: string | number, result: unknown) => {
    responses.push({ requestId, result });
  };

  await (rig.controller as any).handleServerRequest({
    id: 'approval-shared',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-approval',
      command: 'npm test',
      cwd: rig.tempDir,
    },
  });

  const localId = ((rig.store as any).db.prepare('SELECT local_id FROM pending_approvals WHERE server_request_id = ?').get('approval-shared') as any).local_id;
  assert.equal(rig.sentMessages.length, 2);
  assert.match(rig.sentMessages[0]!, /Approval requested/);
  assert.match(rig.sentMessages[1]!, /审批命令：|Approval commands:/);
  assert.match(rig.sentMessages[1]!, new RegExp(`/approve ${localId} allow`));

  await (rig.controller as any).handleCommand(createWeixinEvent(`/approve ${localId} allow`), 'zh', 'approve', [localId, 'allow']);

  assert.deepEqual(responses.at(-1), { requestId: 'approval-shared', result: { decision: 'accept' } });
  assert.equal(rig.store.getPendingApproval(localId)?.resolvedAt !== null, true);
});

test('watcher active turns are read-only except approval commands', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setChatLocale('weixin:acc1:wx-user-1', 'zh');
  const active = (rig.controller as any).createActiveTurnState('weixin:acc1:wx-user-1', 'wx-user-1', 'private', null, 'thread-1', 'turn-1', 0, true);
  setActiveTurnForTest(rig, active);
  let steered = 0;
  (rig.controller as any).app.steerTurn = async () => {
    steered += 1;
  };

  await (rig.controller as any).handleText(createWeixinEvent('继续写'));

  assert.equal(steered, 0);
  assert.match(rig.sentMessages.at(-1)!, /只读观察/);
});

test('completed turns automatically start a queued prompt', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  setActiveTurnForTest(rig, active);
  saveQueuedTurnForTest(rig, 'telegram:99::root', 'continue');
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};

  const started: string[] = [];
  (rig.controller as any).startBoundTurnFromQueuedInput = async (record: any) => {
    const input = JSON.parse(record.inputJson) as Array<{ text?: string }>;
    started.push(input[0]?.text ?? '');
    rig.store.updateQueuedTurnInputStatus(record.queueId, 'completed');
  };

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.deepEqual(started, ['continue']);
  assert.equal(rig.store.countQueuedTurnInputs('telegram:99::root'), 0);
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
  const steers: any[] = [];
  (rig.controller as any).app.steerTurn = async (threadId: string, turnId: string, input: any[]) => {
    steers.push({ threadId, turnId, input });
    return { turnId };
  };

  await (rig.controller as any).cleanupStaleTurnPreviews();

  const active = getActiveTurnForTest(rig, 'telegram:99::root', 'turn-live');
  assert.ok(active);
  assert.equal(active.isObserved, false);
  assert.equal((rig.controller as any).observedThreadWatchers.get('telegram:99::root')?.activeTurnId, 'turn-live');
  assert.equal(rig.store.listActiveTurnPreviews().length, 1);
  assert.equal(rig.editedMessages.length, 0);
  assert.equal(renders, 1);

  await (rig.controller as any).handleText(createEvent('continue after restart'));

  assert.equal(steers.length, 1);
  assert.equal(steers[0]?.threadId, 'thread-1');
  assert.equal(steers[0]?.turnId, 'turn-live');
  assert.equal(steers[0]?.input[0]?.text, 'continue after restart');
});

test('startup preview cleanup keeps observed recovered turns read-only', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    (rig.controller as any).clearObservedThreadWatchers();
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.saveActiveTurnPreview({
    turnId: 'turn-watch',
    scopeId: 'telegram:99::root',
    threadId: 'thread-1',
    messageId: 123,
    isObserved: true,
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
      turnId: 'turn-watch',
      status: 'inProgress',
      error: null,
      items: [],
    }],
  });
  (rig.controller as any).queueTurnRender = async () => {};
  let steers = 0;
  (rig.controller as any).app.steerTurn = async () => {
    steers += 1;
    return { turnId: 'turn-watch' };
  };

  await (rig.controller as any).cleanupStaleTurnPreviews();

  const active = getActiveTurnForTest(rig, 'telegram:99::root', 'turn-watch');
  assert.ok(active);
  assert.equal(active.isObserved, true);

  await (rig.controller as any).handleText(createEvent('continue after restart'));

  assert.equal(steers, 0);
  assert.match(rig.sentMessages.at(-1)!, /watching that turn read-only/);
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
  setActiveTurnForTest(rig, active);
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
  setActiveTurnForTest(rig, active);

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
  setActiveTurnForTest(rig, active);
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
  setActiveTurnForTest(rig, active);

  await (rig.controller as any).handleCommand(createWeixinEvent('/queue next'), 'en', 'queue', ['next']);
  assert.deepEqual(queuedTextsForTest(rig, 'weixin:acc1:wx-user-1'), ['next']);
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
  setActiveTurnForTest(rig, active);

  const calls: string[] = [];
  (rig.controller as any).requestInterrupt = async (turn: any) => {
    calls.push(`interrupt:${turn.turnId}`);
    turn.interruptRequested = true;
    setTimeout(() => {
      turn.resolver();
      deleteActiveTurnForTest(rig, turn);
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
  const scope = 'weixin:acc1:wx-user-1';
  rig.store.setChatLocale(scope, 'zh');

  (rig.controller as any).app.listThreads = async () => [
    {
      threadId: 't-wx-1',
      name: '微信线程',
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
  assert.match(html, /可复制命令（微信）：/);
  assert.match(html, /\/open 1/);
  assert.match(html, /\/watch 1/);
  assert.match(html, /\/thread_rename 1 <name>/);
  assert.match(html, /\/thread_archive 1/);
  assert.match(html, /\/threads archived \[query\]/);
});

test('weixin thread copy commands manage cached threads', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    (rig.controller as any).clearObservedThreadWatchers();
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const scope = 'weixin:acc1:wx-user-1';
  const sessionPath = path.join(rig.tempDir, 'wx-session.jsonl');
  fs.writeFileSync(sessionPath, '');
  const thread = {
    threadId: 'thread-wx',
    name: '微信线程',
    preview: 'work',
    cwd: rig.tempDir,
    modelProvider: 'openai',
    source: 'cli',
    path: sessionPath,
    status: 'idle' as const,
    updatedAt: 1,
  };
  const calls: string[] = [];
  rig.store.cacheThreadList(scope, [{ ...thread, listIndex: 1, archived: false }]);
  (rig.controller as any).app.resumeThread = async ({ threadId }: { threadId: string }) => ({
    thread: { ...thread, threadId },
    model: 'gpt-5',
    modelProvider: 'openai',
    reasoningEffort: 'medium',
    cwd: rig.tempDir,
  });
  (rig.controller as any).app.readThread = async () => thread;
  (rig.controller as any).app.setThreadName = async (threadId: string, name: string) => {
    calls.push(`rename:${threadId}:${name}`);
  };
  (rig.controller as any).app.archiveThread = async (threadId: string) => {
    calls.push(`archive:${threadId}`);
  };
  (rig.controller as any).app.unarchiveThread = async (threadId: string) => {
    calls.push(`unarchive:${threadId}`);
  };

  await (rig.controller as any).handleCommand(createWeixinEvent('/watch 1'), 'zh', 'watch', ['1']);
  assert.equal(rig.store.getBinding(scope)?.threadId, 'thread-wx');
  assert.equal((rig.controller as any).observedThreadWatchers.get(scope)?.threadId, 'thread-wx');

  await (rig.controller as any).handleCommand(createWeixinEvent('/thread_rename 1 新名字'), 'zh', 'thread_rename', ['1', '新名字']);
  await (rig.controller as any).handleCommand(createWeixinEvent('/thread_archive 1'), 'zh', 'thread_archive', ['1']);
  rig.store.cacheThreadList(scope, [{ ...thread, listIndex: 1, archived: true }]);
  await (rig.controller as any).handleCommand(createWeixinEvent('/thread_unarchive 1'), 'zh', 'thread_unarchive', ['1']);

  assert.deepEqual(calls, [
    'rename:thread-wx:新名字',
    'archive:thread-wx',
    'unarchive:thread-wx',
  ]);
});

test('weixin /setup and /auth include Chinese copy-paste commands, and /auth use switches auth', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const scope = 'weixin:acc1:wx-user-1';
  rig.store.setChatLocale(scope, 'zh');
  const authDir = installTempAuthFiles(t, rig.tempDir);
  writeChatGptAuthCandidate(authDir, 'auth.json_a', 'acct-a', new Date().toISOString());
  writeChatGptAuthCandidate(authDir, 'auth.json_b', 'acct-b', new Date().toISOString());
  let restarts = 0;
  (rig.controller as any).app.restart = async () => {
    restarts += 1;
  };
  (rig.controller as any).app.readAccount = async () => chatGptAccount();
  (rig.controller as any).app.readAccountRateLimits = async () => codexRateLimits();

  await (rig.controller as any).handleCommand(createWeixinEvent('/setup'), 'zh', 'setup', []);
  assert.match(rig.sentHtmlMessages[0]!, /快捷命令：/);
  assert.match(rig.sentHtmlMessages[0]!, /\/status/);
  assert.match(rig.sentHtmlMessages[0]!, /\/threads/);
  assert.match(rig.sentHtmlMessages[0]!, /\/auth/);
  assert.match(rig.sentHtmlMessages[0]!, /\/mode default/);
  assert.match(rig.sentHtmlMessages[0]!, /\/active queue/);
  assert.match(rig.sentHtmlMessages[0]!, new RegExp(`/new ${rig.tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(rig.sentHtmlMessages[0]!, /\/interrupt/);

  await (rig.controller as any).handleCommand(createWeixinEvent('/auth'), 'zh', 'auth', []);
  assert.match(rig.sentMessages.at(-1)!, /认证命令：/);
  assert.match(rig.sentMessages.at(-1)!, /\/auth use 1/);
  assert.match(rig.sentMessages.at(-1)!, /\/login_device/);
  assert.match(rig.sentMessages.at(-1)!, /\/auth reload/);
  assert.match(rig.sentMessages.at(-1)!, /\/permissions/);

  await (rig.controller as any).handleCommand(createWeixinEvent('/auth use 2'), 'zh', 'auth', ['use', '2']);
  assert.equal(restarts, 1);
  assert.equal(fs.readlinkSync(path.join(authDir, 'auth.json')), path.join(authDir, 'auth.json_b'));

  const active = (rig.controller as any).createActiveTurnState(scope, 'wx-user-1', 'private', null, 'thread-1', 'turn-1', 0);
  setActiveTurnForTest(rig, active);
  await (rig.controller as any).handleCommand(createWeixinEvent('/auth use 1'), 'zh', 'auth', ['use', '1']);
  assert.equal(restarts, 1);
  assert.match(rig.sentMessages.at(-1)!, /当前有回复、审批或问题在进行中/);
});

test('weixin text fallback commands resolve approval, answers, plan implementation, and MCP elicitation', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });
  const scope = 'weixin:acc1:wx-user-1';
  rig.store.setChatLocale(scope, 'zh');
  rig.store.setBinding(scope, 'thread-1', rig.tempDir);
  const responses: any[] = [];
  (rig.controller as any).app.respond = async (requestId: string | number, result: unknown) => {
    responses.push({ requestId, result });
  };

  await (rig.controller as any).handleServerRequest({
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-approval',
      command: 'npm test',
      cwd: rig.tempDir,
    },
  });
  const localId = ((rig.store as any).db.prepare('SELECT local_id FROM pending_approvals WHERE server_request_id = ?').get('approval-1') as any).local_id;
  assert.match(rig.sentMessages.at(-1)!, /审批命令：/);
  assert.match(rig.sentMessages.at(-1)!, new RegExp(`/approve ${localId} allow`));
  await (rig.controller as any).handleCommand(createWeixinEvent(`/approve ${localId} session`), 'zh', 'approve', [localId, 'session']);
  assert.deepEqual(responses.at(-1), { requestId: 'approval-1', result: { decision: 'acceptForSession' } });

  await (rig.controller as any).handleServerRequest({
    id: 'input-1',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-input',
      questions: [{
        id: 'choice',
        header: '选择',
        question: '下一步？',
        options: [
          { label: '继续', description: '执行' },
          { label: '停止', description: '不执行' },
        ],
      }],
    },
  });
  const input = [...(rig.controller as any).pendingUserInputs.values()][0];
  assert.ok(input);
  assert.match(rig.sentMessages.at(-1)!, /回答命令：/);
  assert.match(rig.sentMessages.at(-1)!, new RegExp(`/answer ${input.localId} 1 2`));
  await (rig.controller as any).handleCommand(createWeixinEvent(`/answer ${input.localId} 1 2`), 'zh', 'answer', [input.localId, '1', '2']);
  assert.deepEqual(responses.at(-1), {
    requestId: 'input-1',
    result: { answers: { choice: { answers: ['停止'] } } },
  });

  const starts: any[] = [];
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => binding;
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any, input: any[], overrides: any) => {
    starts.push({ binding, input, overrides });
    return { threadId: binding.threadId, turnId: 'turn-plan-run' };
  };
  (rig.controller as any).registerActiveTurn = async () => {};
  const plan = savePlanSessionForTest(rig, {
    sessionId: 'planabc1',
    scopeId: scope,
    chatId: 'wx-user-1',
    chatType: 'private',
    topicId: null,
    threadId: 'thread-1',
    turnId: 'turn-plan',
    cwd: rig.tempDir,
    planMarkdown: '- 做一件事',
    messageId: null,
  });
  await (rig.controller as any).handleCommand(createWeixinEvent(`/planimpl ${plan.sessionId} run`), 'zh', 'planimpl', [plan.sessionId, 'run']);
  assert.equal(starts.at(-1)?.input[0]?.text, 'Implement the plan.');
  assert.equal(starts.at(-1)?.overrides?.collaborationMode, 'default');

  await (rig.controller as any).handleServerRequest({
    id: 'mcp-1',
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'linear',
      mode: 'form',
      message: '选择 issue',
      requestedSchema: { type: 'object', properties: { issue: { type: 'string' } } },
    },
  });
  const mcp = [...(rig.controller as any).pendingMcpElicitations.values()][0];
  assert.ok(mcp);
  assert.match(rig.sentMessages.at(-1)!, /MCP 命令：/);
  assert.match(rig.sentMessages.at(-1)!, new RegExp(`/mcpel ${mcp.localId} accept`));
  await (rig.controller as any).handleText(createWeixinEvent('{"issue":"ABC-1"}'));
  await (rig.controller as any).handleCommand(createWeixinEvent(`/mcpel ${mcp.localId} accept`), 'zh', 'mcpel', [mcp.localId, 'accept']);
  assert.deepEqual(responses.at(-1), {
    requestId: 'mcp-1',
    result: { action: 'accept', content: { issue: 'ABC-1' }, _meta: null },
  });
});
