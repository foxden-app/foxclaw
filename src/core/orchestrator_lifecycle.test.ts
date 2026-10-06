import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UnifiedChannelOrchestrator } from './orchestrator.js';
import { BridgeStore } from '../store/database.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { ChannelTextEvent } from './channel_events.js';
import type { ChannelGateway, ChannelPort } from './channel_port.js';
import type { BackendDescriptor, EngineTurnRequest, EngineTurnResult } from './engine_spi.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < end, 'State did not settle'); await delay(10); }
}
function event(text: string, scopeId = 'a'): ChannelTextEvent {
  return { scopeId, chatId: '1', topicId: null, chatType: 'private', userId: '1', messageId: 1, text, attachments: [], entities: [], replyToBot: false };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-lifecycle-'));
  const store = new BridgeStore(path.join(root, 'bridge.db'));
  const turns: Array<{ request: EngineTurnRequest; events: EventEmitter; complete: (status?: EngineTurnResult['status']) => void }> = [];
  const messages: string[] = [];
  let cancel: () => void | Promise<void> = () => {};
  const backend: BackendDescriptor = { id: 'custom', name: 'Custom', engineType: 'custom',
    defaults: { reasoningEffort: null, supportedReasoningEfforts: ['budget_8192'], boost: false, tokenUsage: false },
    adapter: { id: 'custom', name: 'Custom', listModels: async () => [], executeTurn: request => {
      const events = new EventEmitter();
      let resolve!: (result: EngineTurnResult) => void;
      const promise = new Promise<EngineTurnResult>(r => { resolve = r; });
      const complete = (status: EngineTurnResult['status'] = 'SUCCESS') => {
        const result: EngineTurnResult = { kind: 'result', status, response: 'done', conversationId: null };
        resolve(result); events.emit('result', result);
      };
      turns.push({ request, events, complete });
      return { cancel: () => { const pending = cancel(); complete('INTERRUPTED'); return pending; }, waitForResult: () => promise,
        on: (name: string, listener: (...args: any[]) => void) => { events.on(name, listener); } };
    } },
  };
  const config = { defaultCwd: root, telegramPanelTtlMs: 0 } as AppConfig;
  const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as unknown as Logger;
  const messaging = {
    sendRichMarkdown: async (_scope: string, text: string) => { messages.push(text); return messages.length; },
    editRichMarkdown: async (_scope: string, _id: number, text: string) => { messages.push(text); },
    sendTypingInScope: async () => {}, answerCallback: async () => {}, deleteMessage: async () => {},
  } as unknown as ChannelPort;
  const bot = { start: async () => {}, stop: () => {}, username: 'Fixture' } as ChannelGateway;
  const make = () => new UnifiedChannelOrchestrator({ config, store, logger, messaging, bot, backends: [backend] });
  const orchestrator = make();
  const cores = [orchestrator];
  t.after(async () => { for (const core of cores) await core.stop(); store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, turns, messages, messaging, orchestrator, backend,
    setCancel: (fn: typeof cancel) => { cancel = fn; },
    restart: async () => { await orchestrator.stop(); const core = make(); cores.push(core); await core.start(); return core; },
  };
}

test('concurrent launches serialize per scope while other scopes remain responsive', async t => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  const send = f.messaging.sendRichMarkdown.bind(f.messaging);
  f.messaging.sendRichMarkdown = async (scope, text, keyboard) => {
    if (scope === 'a' && text.includes('正在思考')) { entered.resolve(); await release.promise; }
    return send(scope, text, keyboard);
  };
  const first = f.orchestrator.handleText(event('first'));
  await entered.promise;
  const second = f.orchestrator.handleText(event('second'));
  await f.orchestrator.handleText(event('independent', 'b'));
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0]!.request.scopeId, 'b');
  release.resolve(); await Promise.all([first, second]);
  assert.equal(f.turns.length, 2);
  assert.equal(f.store.countQueuedTurnInputs('a'), 1);
});

test('a cancelled turn cannot bind, finish or drain the replacement turn', async t => {
  const f = await fixture(t);
  await f.orchestrator.handleText(event('first'));
  const old = f.turns[0]!;
  await f.orchestrator.handleText(event('queued'));
  await f.orchestrator.handleText(event('/steer replacement'));
  f.turns[1]!.events.emit('conversation', 'current-session');
  old.events.emit('conversation', 'stale-session');
  old.complete(); old.events.emit('error', new Error('late error'));
  await delay(20);
  assert.equal(f.store.getBinding('a')?.threadId, 'current-session');
  assert.equal(f.orchestrator.getActiveTurnsCount(), 1);
  assert.equal(f.store.countQueuedTurnInputs('a'), 1);
  assert.equal(f.turns.length, 2);
});

test('native cancellation must finish before replacement starts; failure retains the occupied slot', async t => {
  const f = await fixture(t); const cancelled = deferred(); const entered = deferred();
  f.setCancel(() => { entered.resolve(); return cancelled.promise; });
  await f.orchestrator.handleText(event('first'));
  const replacement = f.orchestrator.handleText(event('/steer replacement'));
  await entered.promise;
  assert.equal(f.turns.length, 1);
  assert.equal(f.orchestrator.getActiveTurnsCount(), 1);
  cancelled.resolve(); await replacement;
  assert.equal(f.turns.length, 2);
  f.setCancel(async () => { throw new Error('native cancellation failed'); });
  await assert.rejects(f.orchestrator.handleInterrupt('a', 'en'), /native cancellation failed/);
  assert.equal(f.orchestrator.getActiveTurnsCount(), 1);
  f.setCancel(() => {});
  await f.orchestrator.handleInterrupt('a', 'en');
  assert.equal(f.orchestrator.getActiveTurnsCount(), 0);
});

test('new-session waits for launch and ignores old callbacks after the directory reset', async t => {
  const f = await fixture(t); const gate = deferred(); const entered = deferred();
  const send = f.messaging.sendRichMarkdown.bind(f.messaging);
  f.messaging.sendRichMarkdown = async (scope, text, keyboard) => {
    if (text.includes('正在思考')) { entered.resolve(); await gate.promise; }
    return send(scope, text, keyboard);
  };
  const launch = f.orchestrator.handleText(event('first')); await entered.promise;
  const nextCwd = path.join(f.root, 'next'); await fs.mkdir(nextCwd);
  const reset = f.orchestrator.handleNewSession('a', 'en', nextCwd);
  gate.resolve(); await Promise.all([launch, reset]);
  f.turns[0]!.events.emit('conversation', 'stale'); f.turns[0]!.complete();
  assert.equal(f.orchestrator.getActiveTurnsCount(), 0);
  assert.equal(f.store.getBinding('a')?.cwd, nextCwd);
  assert.equal(f.store.getBinding('a')?.threadId, '');
  assert.equal(f.store.listActiveTurnPreviews().length, 0);
});

test('final delivery reserves the scope and duplicate terminal events do not launch queued work twice', async t => {
  const f = await fixture(t); const delivered = deferred(); const entered = deferred();
  const edit = f.messaging.editRichMarkdown.bind(f.messaging);
  f.messaging.editRichMarkdown = async (scope, id, text, keyboard) => {
    if (text === 'done') { entered.resolve(); await delivered.promise; }
    return edit(scope, id, text, keyboard);
  };
  await f.orchestrator.handleText(event('first'));
  f.turns[0]!.complete(); await entered.promise;
  await f.orchestrator.handleText(event('queued'));
  f.turns[0]!.events.emit('error', new Error('duplicate terminal event'));
  assert.equal(f.turns.length, 1);
  assert.equal(f.orchestrator.getActiveTurnsCount(), 1);
  assert.equal(f.store.listQueuedTurnInputs('a')[0]?.status, 'queued');
  delivered.resolve(); await until(() => f.turns.length === 2);
  f.turns[0]!.complete(); await delay(20);
  assert.equal(f.turns.length, 2);
  assert.equal(f.store.listQueuedTurnInputs('a')[0]?.status, 'processing');
  f.turns[1]!.complete(); await until(() => f.orchestrator.getActiveTurnsCount() === 0);
  assert.equal(f.store.countQueuedTurnInputs('a'), 0);
});

test('processing queues require confirmation then recover original input and staged attachments once', async t => {
  const f = await fixture(t);
  const photo = path.join(f.root, 'photo.png'); const json = path.join(f.root, 'data.json');
  await fs.writeFile(photo, 'image'); await fs.writeFile(json, '{"value":1}');
  await f.orchestrator.handleText(event('first'));
  const queued = event('queued files');
  const metadata = { fileId: 'file', fileUniqueId: 'file', fileSize: null, width: null, height: null, durationSeconds: null, isAnimated: false, isVideo: false };
  queued.attachments = [
    { ...metadata, kind: 'photo', fileName: 'photo.png', mimeType: 'image/png', localPath: photo },
    { ...metadata, kind: 'document', fileName: 'data.json', mimeType: 'application/json', localPath: json },
  ];
  await f.orchestrator.handleText(queued);
  const queueId = f.store.listQueuedTurnInputs('a')[0]!.queueId;
  f.turns[0]!.complete(); await until(() => f.turns.length === 2);
  assert.equal(f.store.getQueuedTurnInput(queueId)?.status, 'processing');
  assert.equal(f.turns[1]!.request.prompt, 'queued files');
  assert.equal(f.turns[1]!.request.stagedAttachments?.length, 2);
  const recovered = await f.restart();
  assert.equal(f.turns.length, 2);
  assert.equal(f.store.taskJournal.forQueue(queueId)?.state, 'awaiting_confirmation');
  await recovered.handleText(event('/recover retry'));
  await until(() => f.turns.length >= 3);
  assert.equal(f.turns.length, 3);
  assert.equal(f.turns[2]!.request.prompt, 'queued files');
  assert.equal(f.turns[2]!.request.stagedAttachments?.length, 2);
  assert.equal(f.store.getQueuedTurnInput(queueId)?.status, 'processing');
  assert.equal(await fs.readFile(f.turns[2]!.request.stagedAttachments![1]!.localPath, 'utf8'), '{"value":1}');
  f.turns[2]!.complete(); await until(() => recovered.getActiveTurnsCount() === 0);
  assert.equal(f.store.getQueuedTurnInput(queueId)?.status, 'completed');
});

test('switching any backend is blocked by active or queued work and restores opaque preferences independently', async t => {
  const f = await fixture(t);
  f.orchestrator.registerBackend({ ...f.backend, id: 'other', name: 'Other', engineType: 'other' });
  await f.orchestrator.handleText(event('first'));
  await assert.rejects(f.orchestrator.switchBackend('a', 'other', 'en'), /Interrupt/);
  await f.orchestrator.handleText(event('queued'));
  await f.orchestrator.handleInterrupt('a', 'en');
  await assert.rejects(f.orchestrator.switchBackend('a', 'other', 'en'), /clear its queue/);
  await f.orchestrator.handleText(event('/queue clear'));
  f.store.setChatModel('a', 'custom/model'); f.store.setChatEngineEffort('a', 'budget_8192'); f.store.setChatAccessPreset('a', 'read-only');
  await f.orchestrator.switchBackend('a', 'other', 'en');
  assert.equal(f.store.getChatSettings('a')?.model, null);
  assert.equal(f.store.getChatSettings('a')?.reasoningEffort, null);
  assert.equal(f.store.getChatSettings('a')?.accessPreset, null);
  f.store.setChatAccessPreset('a', 'full-access');
  await f.orchestrator.switchBackend('a', 'custom', 'en');
  assert.equal(f.store.getChatSettings('a')?.model, 'custom/model');
  assert.equal(f.store.getChatSettings('a')?.reasoningEffort, 'budget_8192');
  assert.equal(f.store.getChatSettings('a')?.accessPreset, 'read-only');
});

test('a disabled selected backend preserves its session and never falls back to another executor', async t => {
  const f = await fixture(t);
  f.store.setBinding('a', 'disabled-session', f.root); f.store.setActiveBackend('a', 'disabled');
  await f.orchestrator.handleText(event('work'));
  assert.equal(f.turns.length, 0);
  assert.equal(f.store.getBinding('a')?.threadId, 'disabled-session');
  assert.ok(f.messages.some(text => text.includes('不可用')));
  await f.orchestrator.handleText(event('/backend'));
  assert.ok(f.messages.at(-1)?.includes('Custom'));
  await f.orchestrator.handleText(event('/backend custom'));
  assert.equal(f.store.getActiveBackend('a'), 'custom');
  assert.equal(f.store.getScopeBackendBinding('a', 'disabled')?.threadId, 'disabled-session');
});

test('a registered backend owns its panels and callbacks while service commands take precedence', async t => {
  const f = await fixture(t); let stopped = 0; let legacyCalls = 0; let serviceCalls = 0;
  const seenLocales: string[] = []; let pending = 1;
  const registered: BackendDescriptor = { ...f.backend, id: 'external', engineType: 'external',
    createUi: host => ({
      ownsCallback: data => data.startsWith('external:'), getPendingApprovals: () => pending, stop: async () => { stopped++; },
      renderSetupMenu: async (scope, locale) => { seenLocales.push(locale); await host.sendMessage(scope, 'External panel'); return true; },
      handleCustomCommand: async (_scope, cmd) => cmd === 'update' ? (assert.fail('Backend intercepted global update'), true) : false,
      handleCustomCallback: async (scope, data, locale) => {
        if (data !== 'external:approval' || scope !== 'a') return false;
        seenLocales.push(locale); pending = 0; return true;
      },
    }),
  };
  const orchestrator = new UnifiedChannelOrchestrator({ config: { defaultCwd: f.root, telegramPanelTtlMs: 0 } as AppConfig, store: f.store,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger,
    messaging: f.messaging, bot: { stop: () => {}, username: 'Fixture' } as ChannelGateway,
    backends: [registered, { ...f.backend, id: 'other' }],
    serviceUi: { handleCustomCommand: async (_scope, cmd) => { if (cmd !== 'update') return false; serviceCalls++; return true; } },
    customUi: { handleCustomCommand: async () => { legacyCalls++; return true; } },
  });
  t.after(() => orchestrator.stop());
  f.store.setChatLocale('a', 'en');
  await orchestrator.handleText(event('/setup')); await orchestrator.handleText(event('/update'));
  await orchestrator.handleText(event('/auth'));
  assert.equal(serviceCalls, 1); assert.equal(legacyCalls, 0);
  assert.ok(f.messages.includes('External panel'));
  assert.ok(f.messages.at(-1)?.includes('does not support /auth'));
  assert.equal(orchestrator.getPendingApprovals(), 1);
  await orchestrator.switchBackend('a', 'other', 'en');
  await orchestrator.handleCallback({ scopeId: 'a', data: 'external:approval', callbackQueryId: 'approval', messageId: 1 } as any);
  assert.deepEqual(seenLocales, ['en', 'en']); assert.equal(orchestrator.getPendingApprovals(), 0);
  await orchestrator.stop(); await orchestrator.stop(); assert.equal(stopped, 1);
});

test('an explicit queue on an idle scope is claimed immediately and records its final outcome', async t => {
  const f = await fixture(t);
  await f.orchestrator.handleText(event('/queue run while idle'));
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0]!.request.prompt, 'run while idle');
  const queueId = f.store.listQueuedTurnInputs('a')[0]!.queueId;
  assert.equal(f.store.getQueuedTurnInput(queueId)?.status, 'processing');
  f.turns[0]!.complete('ERROR');
  await until(() => f.orchestrator.getActiveTurnsCount() === 0);
  assert.equal(f.store.getQueuedTurnInput(queueId)?.status, 'failed');
});


test('incoming prompts are persisted before waiting for a busy scope; duplicate delivery is ignored', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred();
  const send = f.messaging.sendRichMarkdown.bind(f.messaging);
  f.messaging.sendRichMarkdown = async (scope, text, keyboard) => {
    if (text.includes('正在思考')) { entered.resolve(); await release.promise; }
    return send(scope, text, keyboard);
  };
  const first = f.orchestrator.handleText(event('first')); await entered.promise;
  const secondEvent = { ...event('second'), messageId: 2 };
  const second = f.orchestrator.handleText(secondEvent);
  const duplicate = f.orchestrator.handleText(secondEvent);
  assert.deepEqual(f.store.taskJournal.listUnfinished('a').map(task => task.sourcePrompt), ['first', 'second']);
  release.resolve(); await Promise.all([first, second, duplicate]);
  assert.equal(f.turns.length, 1); assert.equal(f.store.countQueuedTurnInputs('a'), 1);
});

test('accepted task survives shutdown during preparation and keeps the captured model and access', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred();
  const send = f.messaging.sendRichMarkdown.bind(f.messaging);
  f.messaging.sendRichMarkdown = async (scope, text, keyboard) => {
    if (text.includes('正在思考')) { entered.resolve(); await release.promise; }
    return send(scope, text, keyboard);
  };
  f.store.setChatModel('a', 'recorded-model'); f.store.setChatAccessPreset('a', 'read-only');
  const launch = f.orchestrator.handleText(event('original input')); await entered.promise;
  const stored = f.store.taskJournal.listUnfinished('a')[0]!;
  assert.equal(stored.sourcePrompt, 'original input'); assert.equal(stored.state, 'accepted');
  f.store.setChatModel('a', 'later-model'); f.store.setChatAccessPreset('a', 'full-access');
  const stop = f.orchestrator.stop(); release.resolve(); await launch.catch(() => {}); await stop;
  assert.equal(f.turns.length, 0);
  f.messaging.sendRichMarkdown = send;
  const recovered = await f.restart(); await until(() => f.turns.length === 1);
  assert.equal(f.turns[0]!.request.prompt, 'original input');
  assert.equal(f.turns[0]!.request.model, 'recorded-model'); assert.equal(f.turns[0]!.request.accessPreset, 'read-only');
  f.turns[0]!.complete(); await until(() => recovered.getActiveTurnsCount() === 0);
});

test('failed final delivery retries the saved outcome without executing the tools again', async t => {
  const f = await fixture(t); let fail = false;
  const send = f.messaging.sendRichMarkdown.bind(f.messaging); const edit = f.messaging.editRichMarkdown.bind(f.messaging);
  f.messaging.sendRichMarkdown = async (scope, text, keyboard) => { if (fail) throw new Error('delivery offline'); return send(scope, text, keyboard); };
  f.messaging.editRichMarkdown = async (scope, id, text, keyboard) => { if (fail) throw new Error('delivery offline'); await edit(scope, id, text, keyboard); };
  await f.orchestrator.handleText(event('change files')); fail = true;
  f.turns[0]!.complete(); await until(() => f.orchestrator.getActiveTurnsCount() === 0);
  const task = f.store.taskJournal.listUnfinished('a')[0]!;
  assert.equal(task.state, 'delivery_pending'); assert.equal(task.result?.status, 'SUCCESS');
  fail = false; await f.restart();
  assert.equal(f.turns.length, 1); assert.equal(f.store.taskJournal.get(task.id)?.state, 'completed');
});

test('shutdown waits for in-flight delivery and preserves the known native result', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred();
  const edit = f.messaging.editRichMarkdown.bind(f.messaging);
  f.messaging.editRichMarkdown = async (scope, id, text, keyboard) => { entered.resolve(); await release.promise; await edit(scope, id, text, keyboard); };
  await f.orchestrator.handleText(event('finish before restart')); f.turns[0]!.complete(); await entered.promise;
  const task = f.store.taskJournal.listUnfinished('a')[0]!; assert.equal(task.result?.status, 'SUCCESS');
  let stopped = false; const stop = f.orchestrator.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release.resolve(); await stop; await f.restart();
  assert.equal(f.turns.length, 1); assert.equal(f.store.taskJournal.get(task.id)?.state, 'completed');
});

test('clearing the queue resolves its journal entries and uncertain work must be explicitly resolved', async t => {
  const f = await fixture(t);
  await f.orchestrator.handleText(event('running')); await f.orchestrator.handleText(event('queued'));
  const queued = f.store.taskJournal.listUnfinished('a').find(task => task.state === 'queued')!;
  await f.orchestrator.handleText(event('/queue clear')); assert.equal(f.store.taskJournal.get(queued.id)?.state, 'cancelled');
  const running = f.store.taskJournal.listUnfinished('a')[0]!;
  const recovered = await f.restart();
  await recovered.handleText(event('/new')); assert.equal(f.store.taskJournal.get(running.id)?.state, 'awaiting_confirmation');
  await recovered.handleText(event('/recover cancel')); assert.equal(f.store.taskJournal.get(running.id)?.state, 'cancelled');
  assert.equal(recovered.isIdleForServiceUpdate(), true);
});

test('a recovery button in another scope cannot execute or discard the original task', async t => {
  const f = await fixture(t); await f.orchestrator.handleText(event('owned task')); const recovered = await f.restart();
  const task = f.store.taskJournal.listUnfinished('a')[0]!;
  await recovered.handleCallback({ scopeId: 'b', chatId: '1', topicId: null, userId: '1', messageId: 1,
    callbackQueryId: 'foreign', data: `engine:recover:retry:${task.id}` });
  assert.equal(f.turns.length, 1); assert.equal(f.store.taskJournal.get(task.id)?.state, 'awaiting_confirmation');
});


test('a queue claim interrupted before native execution is safely requeued on restart', async t => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  const send = f.messaging.sendRichMarkdown.bind(f.messaging);
  f.messaging.sendRichMarkdown = async (scope, text, keyboard) => {
    if (text.includes('开始执行排队任务')) { entered.resolve(); await release.promise; }
    return send(scope, text, keyboard);
  };
  const pending = f.orchestrator.handleText(event('/queue preserved input'));
  await entered.promise;
  const queued = f.store.listQueuedTurnInputs('a')[0]!;
  assert.equal(queued.status, 'processing');
  assert.equal(f.store.taskJournal.forQueue(queued.queueId)?.state, 'queued');
  const stop = f.orchestrator.stop(); release.resolve(); await Promise.all([stop, pending]);
  assert.equal(f.turns.length, 0);
  const recovered = await f.restart();
  assert.equal(f.store.getQueuedTurnInput(queued.queueId)?.status, 'queued');
  await until(() => f.turns.length === 1);
  assert.equal(f.turns[0]!.request.prompt, 'preserved input');
  f.turns[0]!.complete(); await until(() => recovered.getActiveTurnsCount() === 0);
  assert.equal(f.store.taskJournal.forQueue(queued.queueId)?.state, 'completed');
});


test('durable intake recovers a message lost during classification and ignores acknowledged redelivery', async t => {
  const f = await fixture(t);
  f.orchestrator.handleText = async () => { throw new Error('interrupted classification'); };
  const inbound = { kind: 'text' as const, event: event('original input') };
  await assert.rejects((f.orchestrator as any).receiveInbound('channel:7', inbound), /classification/);
  assert.equal(f.store.channelInbox.pending().length, 1);
  assert.equal(f.turns.length, 0);
  const recovered = await f.restart();
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0]!.request.prompt, 'original input');
  assert.equal(f.store.channelInbox.pending().length, 0);
  await (recovered as any).receiveInbound('channel:7', inbound);
  assert.equal(f.turns.length, 1);
});

test('sensitive configuration input is redacted before durable intake and never replayed as a task', async t => {
  const f = await fixture(t);
  f.backend.createUi = () => ({
    isSensitiveInbound: input => input.scopeId === 'a',
    handleCustomInbound: async () => true,
  });
  const core = await f.restart();
  core.handleText = async () => { throw new Error('interrupted secret handler'); };
  const key = 'sk-fixture-sensitive-value';
  await assert.rejects((core as any).receiveInbound('channel:secret', { kind: 'text', event: event(key) }), /secret handler/);
  const pending = f.store.channelInbox.pending();
  assert.equal(pending.length, 1);
  assert.doesNotMatch(JSON.stringify(pending), /sk-fixture-sensitive-value/);
  assert.equal(pending[0]!.inbound.kind === 'text' && pending[0]!.inbound.event.redacted, true);
  assert.equal((await fs.readFile(path.join(f.root, 'bridge.db'))).includes(Buffer.from(key)), false);
  const recovered = await f.restart();
  assert.equal(f.turns.length, 0);
  assert.equal(f.store.taskJournal.listUnfinished('a').length, 0);
  assert.match(f.messages.at(-1)!, /敏感内容未保存/);
  await (recovered as any).receiveInbound('channel:secret', { kind: 'text', event: event(key) });
  assert.equal(f.turns.length, 0);
});

test('a missing credential backend still consumes private input and commands clear its pending intent', async t => {
  const f = await fixture(t);
  f.store.setServiceInteraction('a', 'sensitive-input', JSON.stringify({ owner: 'custom:key' }));
  await (f.orchestrator as any).receiveInbound('channel:missing-key', { kind: 'text', event: event('sk-disabled-backend-value') });
  assert.equal(f.turns.length, 0);
  assert.equal(f.store.taskJournal.listUnfinished('a').length, 0);
  assert.match(f.messages.at(-1)!, /未交给模型/);
  await f.orchestrator.handleText(event('/new'));
  assert.equal(f.store.getServiceInteraction('a', 'sensitive-input'), null);
});

test('credential control work blocks self-update and is cancelled before shutdown joins intake', async t => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  let busy = 0;
  f.backend.createUi = () => ({
    isSensitiveInbound: input => input.scopeId === 'a',
    handleCustomInbound: async () => { busy++; entered.resolve(); await release.promise; busy--; return true; },
    getPendingOperations: () => busy,
    stopPendingOperations: async () => { release.resolve(); },
  });
  const core = await f.restart();
  try {
    const inbound = (core as any).receiveInbound('channel:credential-control', { kind: 'text', event: event('fixture-private-input') });
    await entered.promise;
    assert.equal(core.isIdleForServiceUpdate(), false);
    await core.stop();
    await inbound;
    assert.equal(busy, 0);
    assert.equal(f.turns.length, 0);
  } finally { release.resolve(); }
});

test('final delivery waits for an in-flight native preview, clears it, then sends one persistent result', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred(); const lifecycle: string[] = [];
  f.messaging.beginTaskPreview = async () => { lifecycle.push('begin'); return 0; };
  f.messaging.updateTaskPreview = async () => { lifecycle.push('update'); entered.resolve(); await release.promise; return 0; };
  f.messaging.endTaskPreview = async () => { lifecycle.push('end'); };
  await f.orchestrator.handleText(event('input'));
  f.turns[0]!.events.emit('delta', '<untrusted>');
  f.turns[0]!.events.emit('tool', { name: 'build', status: 'running' });
  await entered.promise;
  f.turns[0]!.complete(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lifecycle, ['begin', 'update']);
  assert.equal(f.messages.length, 0);
  release.resolve(); await until(() => f.orchestrator.getActiveTurnsCount() === 0);
  assert.deepEqual(lifecycle, ['begin', 'update', 'end']);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0]!, /blockquote expandable/);
  assert.match(f.messages[0]!, /done/);
});

test('stop controls cannot cancel another scope or a replacement, preserve queued work and settle after native cancellation', async t => {
  const f = await fixture(t); const cancel = deferred();
  f.messaging.beginTaskPreview = async () => 77;
  f.messaging.endTaskPreview = async () => {};
  await f.orchestrator.handleText(event('first'));
  const task = f.store.taskJournal.listUnfinished('a')[0]!;
  await f.orchestrator.handleText(event('/queue second'));
  assert.equal(await f.orchestrator.stopTask('foreign', task.id), false);
  assert.equal(await f.orchestrator.stopTask('a', 'stale-task'), false);
  f.setCancel(() => cancel.promise);
  const stopping = f.orchestrator.stopTask('a', task.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.orchestrator.getActiveTurnsCount(), 1);
  cancel.resolve(); assert.equal(await stopping, true);
  assert.equal(f.orchestrator.getActiveTurnsCount(), 0);
  assert.equal(f.store.taskJournal.get(task.id)?.state, 'cancelled');
  assert.equal(f.store.countQueuedTurnInputs('a'), 1);
  assert.equal(f.turns.length, 1);
  await f.orchestrator.handleText(event('replacement'));
  assert.equal(await f.orchestrator.stopTask('a', task.id), false);
  assert.equal(f.orchestrator.getActiveTurnsCount(), 1);
});


test('a new backend and a new channel execute through the shared contracts without touching existing engines', async t => {
  const f = await fixture(t);
  Object.assign(f.messaging, { capabilities: { editableMessages: false, inlineActions: false, maxMessageLength: 2000 } });
  const inbound = event('future channel input', 'future-channel:room');
  await f.orchestrator.handleText(inbound);
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0]!.request.scopeId, 'future-channel:room');
  assert.equal(f.turns[0]!.request.prompt, 'future channel input');
  f.turns[0]!.complete();
  await until(() => f.orchestrator.getActiveTurnsCount() === 0);
  assert.ok(f.messages.includes('done'));
  assert.equal(f.store.taskJournal.findReceipt(inbound, inbound.text)?.state, 'completed');
});


test('shutdown during native preparation releases the allocated progress preview without losing accepted input', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred();
  let opened = 0; let closed = 0;
  f.messaging.beginTaskPreview = async () => { opened++; return 0; };
  f.messaging.endTaskPreview = async () => { closed++; };
  f.backend.adapter.preflightTurn = async () => { entered.resolve(); await release.promise; };
  const launch = f.orchestrator.handleText(event('preserve me')); await entered.promise;
  const stopping = f.orchestrator.stop(); release.resolve();
  await launch.catch(() => {}); await stopping;
  assert.equal(opened, 1); assert.equal(closed, 1);
  assert.equal(f.turns.length, 0);
  assert.equal(f.store.taskJournal.listUnfinished('a')[0]?.sourcePrompt, 'preserve me');
});

test('commentary stays independent while working and folds after a separate final answer', async t => {
  const f = await fixture(t);
  const operations: string[] = [];
  Object.defineProperty(f.backend.adapter, 'supportsCommentary', { value: true });
  f.messaging.beginTaskPreview = async () => 77;
  f.messaging.endTaskPreview = async () => { operations.push('end'); };
  f.messaging.foldTaskCommentary = async (_scope, id, text) => {
    assert.equal(f.messages.at(-1), 'done', 'The final answer must arrive before earlier commentary is folded');
    operations.push(`fold:${id}:${text}`);
  };
  f.messaging.editRichMarkdown = async (_scope, id, text) => { operations.push(`edit:${id}:${text}`); };
  await f.orchestrator.handleText(event('input'));
  f.turns[0]!.events.emit('commentary', { messageId: 'one', text: 'Checked the settings.' });
  f.turns[0]!.events.emit('commentary', { messageId: 'one', text: 'Checked the settings.' });
  await until(() => f.messages.length === 1);
  assert.deepEqual(f.messages, ['Checked the settings.']);
  assert.equal(operations.length, 0);
  f.turns[0]!.events.emit('tool', { name: 'verify', status: 'completed' });
  f.turns[0]!.complete();
  await until(() => f.orchestrator.getActiveTurnsCount() === 0);
  assert.ok(operations.includes('fold:1:Checked the settings.'));
  assert.equal(f.messages[1], 'done', 'Final answer is sent before collecting earlier messages');
  assert.equal(f.messages.at(-1), 'done');
  const task = f.store.taskJournal.findReceipt(event('input'), 'input')!;
  assert.equal(task.state, 'completed');
  assert.equal(task.commentary?.[0]?.folded, true);
  assert.equal(task.separateFinal, true);
});

test('an unconfirmed disconnect frees the live task and pauses the queue without replay', async t => {
  const f = await fixture(t);
  await f.orchestrator.handleText(event('first'));
  await f.orchestrator.handleText({ ...event('/queue second'), messageId: 2 });
  f.turns[0]!.events.emit('result', { kind: 'result', status: 'ERROR', outcomeUnknown: true, error: 'Connection closed', response: '', conversationId: null });
  await until(() => f.orchestrator.getActiveTurnsCount() === 0);
  assert.equal(f.store.taskJournal.listUnfinished('a').find(task => task.sourcePrompt === 'first')?.state, 'awaiting_confirmation');
  assert.equal(f.store.countQueuedTurnInputs('a'), 1);
  assert.equal(f.turns.length, 1);
  assert.ok(f.messages.some(text => text.includes('/recover')));
});

test('restart resumes final delivery without resending or refolding already collected commentary', async t => {
  const f = await fixture(t);
  Object.defineProperty(f.backend.adapter, 'supportsCommentary', { value: true });
  f.messaging.beginTaskPreview = async () => 0;
  let folds = 0;
  f.messaging.foldTaskCommentary = async () => { folds++; };
  const send = f.messaging.sendRichMarkdown;
  let failed = false;
  f.messaging.sendRichMarkdown = async (scope, text, keyboard) => {
    if (text === 'done' && !failed) { failed = true; throw new Error('Temporary delivery failure'); }
    return send(scope, text, keyboard);
  };
  await f.orchestrator.handleText(event('input'));
  f.turns[0]!.events.emit('commentary', { messageId: 'one', text: 'Progress before completion.' });
  await until(() => f.messages.length === 1);
  f.turns[0]!.complete();
  await until(() => f.orchestrator.getActiveTurnsCount() === 0);
  assert.equal(f.store.taskJournal.listUnfinished('a')[0]?.state, 'delivery_pending');
  const core = await f.restart();
  assert.deepEqual(f.messages, ['Progress before completion.', 'done']);
  assert.equal(folds, 1);
  assert.equal(f.turns.length, 1);
  assert.equal(core.getActiveTurnsCount(), 0);
  assert.equal(f.store.taskJournal.listUnfinished('a').length, 0);
});
