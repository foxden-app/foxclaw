import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { BackendSetupManager, BackendSetupUi, runBackendCommand, writeBackendEnv, type BackendSetupDefinition, type BackendCandidate } from './backend_setup.js';
import type { BackendDescriptor } from '../core/engine_spi.js';
import type { ChannelInlineKeyboard, ChannelPort } from '../core/channel_port.js';
import type { ChannelTextEvent } from '../core/channel_events.js';
import type { AppConfig } from '../config.js';
import { UnifiedChannelOrchestrator } from '../core/orchestrator.js';
import { BridgeStore } from '../store/database.js';
import { Logger } from '../logger.js';
import { UnifiedBridgeCore } from '../bridge/unified_bridge.js';
import { createDshSetupDefinition } from '../dsh/setup.js';
import { fakeDsh } from '../dsh/test_support.js';
import type { ChannelInbound } from '../core/channel_events.js';
import type { TelegramGateway } from '../telegram/gateway.js';
import type { AntigravityAuthManager } from '../antigravity/auth.js';
import type { CodexEngineAdapter } from '../codex_app/adapter.js';

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-setup-test-'));
  const envPath = path.join(directory, '.env');
  const original = '# Existing settings\nBOT_TOKEN=test-value\nDSH_ENABLED=false\n';
  fs.writeFileSync(envPath, original);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidate: BackendCandidate = { label: 'Local DSH', location: path.join(directory, 'dsh'),
    updates: { DSH_ENABLED: 'true', DSH_CLI_BIN: path.join(directory, 'dsh'), DSH_SOURCE_DIR: '' } };
  let validations = 0;
  let installations = 0;
  const definition: BackendSetupDefinition = {
    id: 'dsh', name: 'DeepSeek Harness (DSH)', discover: async () => [candidate],
    fromPath: async location => ({ ...candidate, location }),
    validate: async () => { validations++; },
    factory: () => () => ({ id: 'dsh', name: 'DSH', engineType: 'dsh' } as BackendDescriptor),
    install: async () => { installations++; return candidate; },
  };
  return { directory, envPath, original, candidate, definition, validations: () => validations, installations: () => installations };
}

test('enabling a backend checks startup, preserves configuration, and registers every bot', async t => {
  const f = fixture(t);
  const manager = new BackendSetupManager([f.definition], f.envPath);
  const enabled: string[] = [];
  manager.attach(() => enabled.push('bot-a'));
  manager.attach(() => enabled.push('bot-b'));
  await manager.enable('dsh', f.candidate);
  assert.equal(f.validations(), 1);
  assert.deepEqual(enabled, ['bot-a', 'bot-b']);
  assert.deepEqual(dotenv.parse(fs.readFileSync(f.envPath)), {
    BOT_TOKEN: 'test-value', DSH_ENABLED: 'true', DSH_CLI_BIN: f.candidate.location, DSH_SOURCE_DIR: '',
  });
  assert.match(fs.readFileSync(f.envPath, 'utf8'), /# Existing settings/);
  assert.equal(manager.busy, false);
  await manager.stop();
});

test('failed initialization never persists configuration or registers a backend', async t => {
  const f = fixture(t);
  f.definition.validate = async () => { throw new Error('missing dependency'); };
  const manager = new BackendSetupManager([f.definition], f.envPath);
  let registered = false;
  manager.attach(() => { registered = true; });
  await assert.rejects(manager.enable('dsh', f.candidate), /missing dependency/);
  assert.equal(fs.readFileSync(f.envPath, 'utf8'), f.original);
  assert.equal(registered, false);
  await manager.stop();
});

test('two bots cannot provision concurrently and shutdown cancels and joins the active check', async t => {
  const f = fixture(t);
  let checked = false;
  let cleanupFinished = false;
  f.definition.validate = async (_candidate, signal) => {
    checked = true;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 10), { once: true }));
    cleanupFinished = true;
    signal.throwIfAborted();
  };
  const manager = new BackendSetupManager([f.definition], f.envPath);
  const first = manager.enable('dsh', f.candidate);
  const rejected = assert.rejects(first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checked, true);
  await assert.rejects(manager.enable('dsh', f.candidate), /Another backend/);
  await manager.stop();
  await rejected;
  assert.equal(cleanupFinished, true);
  assert.equal(fs.readFileSync(f.envPath, 'utf8'), f.original);
  await assert.rejects(manager.enable('dsh', f.candidate), /stopped/);
});

test('a service update blocks backend installation before any package or config mutation', async t => {
  const f = fixture(t);
  const manager = new BackendSetupManager([f.definition], f.envPath, async () => false);
  await assert.rejects(manager.enable('dsh'), /service update/);
  assert.equal(f.installations(), 0);
  assert.equal(f.validations(), 0);
  assert.equal(fs.readFileSync(f.envPath, 'utf8'), f.original);
  await manager.stop();
});

test('configuration updates preserve symlinks and safely encode paths containing shell syntax', t => {
  const f = fixture(t);
  const link = path.join(f.directory, 'service.env');
  fs.symlinkSync(f.envPath, link);
  const location = path.join(f.directory, "space $HOME `literal` 'quoted' ");
  writeBackendEnv(link, { DSH_CLI_BIN: location });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(dotenv.parse(fs.readFileSync(f.envPath)).DSH_CLI_BIN, location);
  assert.throws(() => writeBackendEnv(link, { DSH_CLI_BIN: '/tmp/dsh\nUNRELATED=1' }), /Invalid/);
  assert.equal(dotenv.parse(fs.readFileSync(f.envPath)).BOT_TOKEN, 'test-value');
});

function text(scopeId: string, content: string): ChannelTextEvent {
  return { scopeId, chatId: '99', topicId: null, chatType: 'private', userId: '1', text: content,
    messageId: 1, attachments: [], entities: [], replyToBot: false };
}

test('setup choices are scope-bound and cannot enable twice or silently switch a session', async t => {
  const f = fixture(t);
  const manager = new BackendSetupManager([f.definition], f.envPath);
  const messages: { scope: string; text: string; keyboard: ChannelInlineKeyboard }[] = [];
  let enabled = false;
  manager.attach(() => { enabled = true; });
  const ui = new BackendSetupUi(manager, {
    listBackends: async () => enabled ? [{ id: 'dsh', engineType: 'dsh' } as BackendDescriptor] : [],
    send: async (scope, text, keyboard) => { messages.push({ scope, text, keyboard }); },
  });
  await ui.command('a', 'backend', 'add dsh', 'zh');
  const choice = messages.at(-1)!.keyboard.flat().find(button => button.callback_data.startsWith('backend-setup:use:'))!.callback_data;
  assert.ok(Buffer.byteLength(choice) <= 64);
  await ui.callback('b', choice, 'zh');
  assert.equal(f.validations(), 0);
  await ui.callback('a', choice, 'zh');
  assert.equal(enabled, true);
  assert.equal(f.validations(), 1);
  assert.match(messages.at(-1)!.text, /当前会话继续使用原后端/);
  assert.ok(messages.at(-1)!.keyboard.flat().some(button => button.callback_data === 'engine:backend:dsh'));
  await ui.callback('a', choice, 'zh');
  assert.equal(f.validations(), 1);
  await manager.stop();
});

test('explicit paths require a confirmation and another command cancels pending path input', async t => {
  const f = fixture(t);
  const manager = new BackendSetupManager([f.definition], f.envPath);
  const keyboards: ChannelInlineKeyboard[] = [];
  const ui = new BackendSetupUi(manager, { listBackends: async () => [], send: async (_scope, _text, keyboard) => { keyboards.push(keyboard); } });
  await ui.callback('a', 'backend-setup:path:dsh', 'zh');
  assert.equal(await ui.inbound(text('a', f.candidate.location), 'zh'), true);
  assert.equal(f.validations(), 0);
  assert.ok(keyboards.at(-1)!.flat().some(button => button.callback_data.startsWith('backend-setup:use:')));
  await ui.callback('a', 'backend-setup:path:dsh', 'zh');
  assert.equal(await ui.command('a', 'new', '', 'zh'), false);
  assert.equal(await ui.inbound(text('a', 'ordinary task'), 'zh'), false);
  await manager.stop();
});

test('path input remains an administrative interaction after restart, including expired input', async t => {
  const f = fixture(t);
  const dbPath = path.join(f.directory, 'path-state.sqlite');
  let store = new BridgeStore(dbPath);
  const manager = new BackendSetupManager([f.definition], f.envPath);
  const messages: string[] = [];
  const host = {
    listBackends: async () => [], send: async (_scope: string, text: string) => { messages.push(text); },
    readPathState: (scope: string) => store.getServiceInteraction(scope, 'backend-setup:path'),
    writePathState: (scope: string, state: string | null) => store.setServiceInteraction(scope, 'backend-setup:path', state),
  };
  const first = new BackendSetupUi(manager, host);
  await first.callback('a', 'backend-setup:path:dsh', 'zh');
  first.stop(); store.close(); store = new BridgeStore(dbPath);
  const restored = new BackendSetupUi(manager, host);
  try {
    assert.equal(await restored.inbound(text('b', 'ordinary prompt'), 'zh'), false);
    assert.equal(await restored.inbound(text('a', f.candidate.location), 'zh'), true);
    assert.equal(f.validations(), 0);
    const pending = JSON.parse(store.getServiceInteraction('a', 'backend-setup:path')!);
    pending.expires = 0;
    store.setServiceInteraction('a', 'backend-setup:path', JSON.stringify(pending));
    const expired = new BackendSetupUi(manager, host);
    assert.equal(await expired.inbound(text('a', f.candidate.location), 'zh'), true);
    assert.match(messages.at(-1)!, /已过期/);
    await expired.command('a', 'new', '', 'zh');
    assert.equal(store.getServiceInteraction('a', 'backend-setup:path'), null);
    assert.equal(await expired.inbound(text('a', 'ordinary prompt'), 'zh'), false);
  } finally { await manager.stop(); store.close(); }
});

test('the backend menu exposes service setup and its path inputs never reach an engine', async t => {
  const f = fixture(t);
  const store = new BridgeStore(path.join(f.directory, 'store.sqlite'));
  let executions = 0;
  const adapter = { id: 'codex', name: 'Codex', executeTurn: () => { executions++; throw new Error('must not execute'); }, listModels: async () => [] };
  const messages: { text: string; keyboard: ChannelInlineKeyboard }[] = [];
  const send = async (_scope: string, content: string, keyboard: ChannelInlineKeyboard = []) => { messages.push({ text: content, keyboard }); return messages.length; };
  const messaging = { sendRichMarkdown: send, editRichMarkdown: async () => {}, answerCallback: async () => {}, deleteMessage: async () => {} } as unknown as ChannelPort;
  const manager = new BackendSetupManager([f.definition], f.envPath);
  const orchestrator: UnifiedChannelOrchestrator = new UnifiedChannelOrchestrator({
    config: { defaultCwd: f.directory, telegramPanelTtlMs: 60000 } as AppConfig, store,
    logger: new Logger('error', path.join(f.directory, 'test.log')), adapter,
    bot: { on: () => {}, start: async () => {}, stop: () => {} }, messaging,
    serviceUi: {
      renderBackendMenuRows: async (_scope, locale) => ui.rows(locale),
      handleCustomCommand: (scope, command, args, locale) => ui.command(scope, command, args, locale),
      handleCustomInbound: (event, locale) => ui.inbound(event, locale),
      handleCustomCallback: (scope, data, locale, messageId) => ui.callback(scope, data, locale, messageId),
    },
  });
  const ui: BackendSetupUi = new BackendSetupUi(manager, { listBackends: () => orchestrator.listBackends(), send: async (scope, text, keyboard) => { await send(scope, text, keyboard); } });
  try {
    await orchestrator.handleText(text('a', '/backend'));
    assert.ok(messages.at(-1)!.keyboard.flat().some(button => button.callback_data === 'backend-setup:list'));
    await orchestrator.handleCallback({ scopeId: 'a', chatId: '99', topicId: null, userId: '1', messageId: 1,
      callbackQueryId: 'click', data: 'backend-setup:path:dsh' });
    await orchestrator.handleText(text('a', f.candidate.location));
    assert.equal(executions, 0);
    assert.equal(store.taskJournal.listUnfinished().length, 0);
    assert.ok(messages.at(-1)!.keyboard.flat().some(button => button.callback_data.startsWith('backend-setup:use:')));
  } finally { await manager.stop(); await orchestrator.stop(); store.close(); }
});

test('backend process commands separate diagnostics from JSON and join cancelled children', async t => {
  const f = fixture(t);
  const output = await runBackendCommand(process.execPath, ['-e', 'console.error("diagnostic");console.log(JSON.stringify("0.2.0-rc.2"))'], f.directory,
    process.env, new AbortController().signal);
  assert.equal(JSON.parse(output), '0.2.0-rc.2');
  const controller = new AbortController();
  const running = runBackendCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], f.directory, process.env, controller.signal);
  const cancelled = assert.rejects(running, /cancelled/);
  controller.abort();
  await cancelled;
});

test('a real shared bridge panel enables DSH on both bots and switches only on an explicit command', async t => {
  const f = fixture(t);
  const dsh = await fakeDsh();
  const store = new BridgeStore(path.join(f.directory, 'shared.sqlite'));
  const logger = new Logger('error', path.join(f.directory, 'shared.log'));
  const definition = createDshSetupDefinition(logger, { DSH_CLI_BIN: dsh.options.cliBin, DSH_HOME: dsh.options.home!, PATH: '' }, path.join(f.directory, 'managed'));
  const manager = new BackendSetupManager([definition], f.envPath);
  const config = { defaultCwd: f.directory, telegramPanelTtlMs: 60000, antigravityAuthDir: f.directory,
    antigravityCliBin: 'unused-agy', codexHome: f.directory, tgMultiBotMode: true, threadListLimit: 10 } as AppConfig;
  const cores: UnifiedBridgeCore[] = [];
  const create = (id: string) => {
    const messages: { text: string; keyboard: ChannelInlineKeyboard }[] = [];
    const send = async (_scope: string, text: string, keyboard: ChannelInlineKeyboard = []) => { messages.push({ text, keyboard }); return messages.length; };
    const messaging = { sendRichMarkdown: send, editRichMarkdown: async (_scope: string, _message: number, text: string, keyboard: ChannelInlineKeyboard = []) => { messages.push({ text, keyboard }); },
      answerCallback: async () => {}, deleteMessage: async () => {} } as unknown as ChannelPort;
    let consumer!: (id: string, inbound: ChannelInbound) => Promise<void>;
    const bot = { identity: id, username: id, on: () => {}, start: async () => {}, stop: () => {},
      setInboundConsumer: (handler: typeof consumer) => { consumer = handler; return () => {}; } } as unknown as TelegramGateway;
    const auth = { authDir: f.directory, getActiveAccount: async () => null, stopKeepAlive: async () => {} } as unknown as AntigravityAuthManager;
    const codex = { id: 'codex', name: 'Codex', listModels: async () => [], executeTurn: () => { throw new Error('Existing engine must not run'); } } as unknown as CodexEngineAdapter;
    const core = new UnifiedBridgeCore(config, store, logger, bot, undefined, auth, messaging, {
      defaultBackendId: 'codex', codexAdapter: codex, backendSetup: manager, ownsScope: () => true,
    });
    core.registerInboundHandlers();
    cores.push(core);
    let sequence = 0;
    const scope = `telegram:bot${id}:99`;
    return { messages, scope, deliver: (inbound: ChannelInbound) => consumer(`${id}:${++sequence}`, inbound) };
  };
  try {
    const a = create('a');
    const b = create('b');
    await a.deliver({ kind: 'text', event: text(a.scope, '/backend add dsh') });
    const action = a.messages.at(-1)!.keyboard.flat().find(button => button.callback_data.startsWith('backend-setup:use:'))!.callback_data;
    await a.deliver({ kind: 'callback', event: { scopeId: a.scope, chatId: '99', topicId: null, userId: '1',
      data: action, callbackQueryId: 'setup', messageId: 1 } });
    assert.match(a.messages.at(-1)!.text, /后端已接入/);
    assert.equal(store.getActiveBackend(a.scope), null);
    assert.equal(store.getActiveBackend(b.scope), null);
    await b.deliver({ kind: 'text', event: text(b.scope, '/backend') });
    assert.ok(b.messages.at(-1)!.keyboard.flat().some(button => button.callback_data === 'engine:backend:dsh'));
    await b.deliver({ kind: 'text', event: text(b.scope, '/backend dsh') });
    assert.equal(store.getActiveBackend(b.scope), 'dsh');
    assert.equal(store.getActiveBackend(a.scope), null);
    assert.ok(b.messages.some(message => message.text.includes('DeepSeek Harness')));
  } finally {
    await manager.stop();
    await Promise.all(cores.map(core => core.stop()));
    store.close();
    await dsh.cleanup();
  }
});
