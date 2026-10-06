import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DshUi } from './ui.js';
import { fakeDsh } from './test_support.js';
import { BridgeStore } from '../store/database.js';
import { Logger } from '../logger.js';
import { UnifiedChannelOrchestrator } from '../core/orchestrator.js';
import type { AppConfig } from '../config.js';
import type { TelegramGateway, TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';
import type { TelegramMessagingPort, InlineKeyboard } from '../channels/telegram/telegram_messaging_port.js';

async function setup(ownsScope?: (scopeId: string) => boolean) {
  const fixture = await fakeDsh();
  const store = new BridgeStore(path.join(fixture.root, 'bridge.db'));
  const messages: Array<{ text: string; keyboard: InlineKeyboard }> = [];
  const answers: Array<{ id: string; text: string }> = [];
  const messaging = {
    sendRichMarkdown: async (_scope: string, text: string, keyboard: InlineKeyboard = []) => { messages.push({ text, keyboard }); return messages.length; },
    editRichMarkdown: async (_scope: string, _id: number, text: string, keyboard: InlineKeyboard = []) => { messages.push({ text, keyboard }); },
    answerCallback: async (id: string, text = '') => { answers.push({ id, text }); },
    deleteMessage: async () => {},
    sendTypingInScope: async () => {},
  } as unknown as TelegramMessagingPort;
  const config = { dsh: fixture.options, defaultCwd: fixture.root, defaultSandboxMode: 'workspace-write', telegramPanelTtlMs: 0 } as AppConfig;
  const logger = new Logger('error', path.join(fixture.root, 'test.log'));
  const ui = new DshUi(config, store, logger, messaging);
  const orchestrator: UnifiedChannelOrchestrator = new UnifiedChannelOrchestrator({ config, store, logger, messaging, adapter: ui.adapter, bot: { start: async () => {}, stop: () => {}, username: 'FixtureBot' } as TelegramGateway,
    ...(ownsScope ? { ownsScope } : {}),
    backends: [{ id: 'dsh', name: ui.adapter.name, engineType: 'dsh', adapter: ui.adapter,
      defaults: { reasoningEffort: null, supportedReasoningEfforts: [], boost: false, tokenUsage: false },
      createUi: () => ({
      handleCustomCommand: (scope, command, args, locale) => ui.command(scope, command, args, locale, orchestrator),
      renderCustomStatus: async (scope, locale) => ui.status(scope, locale),
      renderModelsMenu: async (scope, locale, messageId) => { await ui.models(scope, locale, orchestrator, messageId); return true; },
      handleCustomCallback: (scope, data, locale, _messageId, event) => ui.callback(scope, data, locale, orchestrator, event),
    }) }],
  });
  const event = { callbackQueryId: 'real-query-id', messageId: 1 } as TelegramCallbackEvent;
  const callback = (scope: string, data: string) => ui.callback(scope, data, 'en', orchestrator, event);
  return { ...fixture, store, messages, answers, ui, orchestrator, callback, dispose: async () => { await orchestrator.stop(); await ui.stop(); store.close(); await fixture.cleanup(); } };
}

test('DSH panel uses native models/efforts, persists choices and rejects foreign controls', async () => {
  const f = await setup();
  try {
    await f.ui.setup('a', 'en', f.orchestrator);
    assert.doesNotMatch(JSON.stringify(f.messages.at(-1)), /account|quota|auth|boost|Fast tier/i);
    await f.orchestrator.sendStatus('a', 'en');
    assert.match(f.messages.at(-1)!.text, /Per-turn counts are not exposed/);
    assert.ok(f.messages.at(-1)!.keyboard.flat().some(button => button.callback_data === 'engine:setup:models'));
    await f.ui.models('a', 'en', f.orchestrator);
    const model = f.messages.at(-1)!.keyboard.flat().find(button => button.text === 'Long model')!;
    assert.ok(model);
    assert.ok(Buffer.byteLength(model.callback_data) <= 64);
    await f.callback('other-scope', model.callback_data);
    assert.equal(f.store.getChatSettings('other-scope')?.model ?? null, null);
    assert.match(f.messages.at(-1)!.text, /Panel expired/);
    await f.callback('a', model.callback_data);
    assert.match(f.store.getChatSettings('a')!.model!, /^fixture\/model-long/);
    assert.equal(f.answers.at(-1)!.id, 'real-query-id');
    await f.callback('a', 'dsh:efforts');
    const effort = f.messages.at(-1)!.keyboard.flat().find(button => button.text === 'Custom effort')!;
    await f.callback('a', effort.callback_data);
    assert.equal(f.store.getChatSettings('a')?.reasoningEffort, 'thinking_16384');
    assert.equal(f.store.getScopeBackendBinding('a', 'dsh')?.reasoningEffort, 'thinking_16384');
    await f.ui.command('a', 'model', 'default', 'en', f.orchestrator);
    assert.equal(f.store.getChatSettings('a')?.reasoningEffort, null);
    await f.callback('a', 'dsh:a:expired');
    assert.match(f.messages.at(-1)!.text, /Panel expired/);
    assert.equal(await f.callback('a', 'engine:setup:boost'), true);
    assert.match(f.answers.at(-1)!.text, /Open DSH settings/);
    f.store.setActiveBackend('a', 'codex');
    f.orchestrator.registerBackend({ id: 'codex', engineType: 'codex', name: 'Codex', adapter: f.ui.adapter, defaults: { reasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'], boost: true, tokenUsage: true } });
    await f.callback('a', model.callback_data);
    assert.match(f.answers.at(-1)!.text, /Switch to DSH/);
  } finally { await f.dispose(); }
});

let inboundMessageId = 0;
function textEvent(text: string): TelegramTextEvent {
  return { scopeId: 'a', chatId: '1', topicId: null, chatType: 'private', userId: '1', messageId: ++inboundMessageId, text, attachments: [], entities: [], replyToBot: false };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected state did not settle');
}

test('DSH crash recovery leaves other bots previews and processing queues untouched', async () => {
  const f = await setup(scope => scope === 'a');
  try {
    for (const scope of ['a', 'other-bot']) {
      f.store.saveActiveTurnPreview({ turnId: `dsh_${scope}_1`, scopeId: scope, threadId: '', messageId: 1 });
      f.store.saveQueuedTurnInput({ queueId: `q_${scope}`, scopeId: scope, chatId: '1', chatType: 'private', topicId: null,
        threadId: '', inputJson: '[]', sourceSummary: 'unfinished work', messageId: 1, status: 'processing', error: null,
        createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: null });
    }
    await f.orchestrator.start();
    assert.deepEqual(f.store.listActiveTurnPreviews().map(preview => preview.scopeId), ['a', 'other-bot']);
    assert.equal(f.store.taskJournal.listUnfinished('a')[0]?.state, 'awaiting_confirmation');
    assert.equal(f.store.taskJournal.listUnfinished('other-bot').length, 0);
    assert.equal(f.store.listQueuedTurnInputs('a')[0]?.status, 'processing');
    assert.equal(f.store.listQueuedTurnInputs('other-bot')[0]?.status, 'processing');
    await f.orchestrator.stop();
    assert.equal(f.orchestrator.getActiveTurnsCount(), 0);
  } finally { await f.dispose(); }
});

test('DSH interrupt and steer preserve queued work, and backend switching restores DSH settings', { timeout: 10000 }, async () => {
  const f = await setup();
  try {
    const state = await f.ui.adapter.sessionForScope('a');
    let tools = 0;
    state.client.on('update', notification => { if (notification.update.sessionUpdate === 'tool_call') tools++; });
    f.orchestrator.registerBackend({ id: 'codex', engineType: 'codex', name: 'Codex', adapter: f.ui.adapter, defaults: { reasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'], boost: true, tokenUsage: true } });
    await f.orchestrator.handleText(textEvent('wait'));
    await until(() => tools === 1);
    await f.orchestrator.handleText(textEvent('queued task'));
    assert.equal(f.store.countQueuedTurnInputs('a'), 1);
    await assert.rejects(f.orchestrator.switchBackend('a', 'codex', 'en'), /Interrupt/);
    await f.orchestrator.handleText(textEvent('/permissions full-access'));
    assert.match(f.messages.at(-1)!.text, /Interrupt the active turn/);
    await f.orchestrator.handleText(textEvent('/steer wait'));
    await until(() => tools === 2);
    assert.equal(f.store.countQueuedTurnInputs('a'), 1);
    assert.equal(f.orchestrator.getActiveTurnsCount(), 1);
    await f.orchestrator.handleInterrupt('a', 'en');
    assert.equal(f.orchestrator.getActiveTurnsCount(), 0);
    assert.equal(f.store.countQueuedTurnInputs('a'), 1);
    await f.orchestrator.handleText(textEvent('finish and drain'));
    await until(() => tools === 4 && f.orchestrator.getActiveTurnsCount() === 0);
    assert.equal(f.store.countQueuedTurnInputs('a'), 0);
    await f.ui.command('a', 'effort', 'thinking_16384', 'en', f.orchestrator);
    await f.orchestrator.switchBackend('a', 'codex', 'en');
    assert.equal(f.store.getChatSettings('a')?.reasoningEffort, 'medium');
    await f.orchestrator.switchBackend('a', 'dsh', 'en');
    assert.equal(f.store.getBinding('a')?.threadId, state.sessionId);
    assert.equal(f.store.getChatSettings('a')?.reasoningEffort, 'thinking_16384');
  } finally { await f.dispose(); }
});

test('DSH routes photos natively and retains JSON documents as attachments', { timeout: 10000 }, async () => {
  const f = await setup();
  try {
    const photo = path.join(f.root, 'image.png');
    const json = path.join(f.root, 'document.json');
    await fs.writeFile(photo, 'fixture-image');
    await fs.writeFile(json, '{"example":true}');
    const event = textEvent('inspect attachments');
    const metadata = { fileId: 'fixture', fileUniqueId: 'fixture', fileSize: null, width: null, height: null, durationSeconds: null, isAnimated: false, isVideo: false };
    event.attachments = [
      { ...metadata, kind: 'photo', fileName: 'image.png', mimeType: 'image/png', localPath: photo },
      { ...metadata, kind: 'document', fileName: 'document.json', mimeType: 'application/json', localPath: json },
    ];
    await f.orchestrator.handleText(event);
    await until(() => f.messages.some(message => message.text.includes('"images":1')));
    const final = f.messages.findLast(message => message.text.includes('"images":1'))!.text;
    assert.match(final, /document.json/);
    assert.equal((final.match(/Attachments:/g) ?? []).length, 1);
    assert.doesNotMatch(final, /PRIVATE REASONING/);
  } finally { await f.dispose(); }
});

test('DSH approval buttons round trip native option IDs, enforce scope and settle on cancellation', { timeout: 10000 }, async () => {
  const f = await setup();
  const request = { scopeId: 'a', cwd: f.root, threadId: null, model: 'default', effort: null, prompt: 'permission', locale: 'en' as const };
  const waitApproval = async () => {
    for (let i = 0; i < 200; i++) {
      const panel = f.messages.findLast(message => message.keyboard.flat().some(button => button.callback_data.startsWith('dsh:p:')));
      if (panel && f.ui.pendingApprovals > 0) return panel;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Approval was not delivered');
  };
  try {
    for (const [index, expected] of [[0, 'native-allow'], [1, 'native-reject']] as const) {
      const execution = f.ui.adapter.executeTurn(request);
      const panel = await waitApproval();
      const data = panel.keyboard[0]![index]!.callback_data;
      await f.callback('wrong-scope', data);
      assert.equal(f.ui.pendingApprovals, 1);
      assert.match(f.answers.at(-1)!.text, /Approval expired/);
      await f.callback('a', data);
      const result = await execution.waitForResult();
      assert.equal(result?.status, 'SUCCESS');
      assert.equal(JSON.parse(result!.response).outcome.optionId, expected);
      assert.equal(f.ui.pendingApprovals, 0);
      await f.callback('a', data);
      assert.match(f.answers.at(-1)!.text, /Approval expired/);
    }
    const interrupted = f.ui.adapter.executeTurn(request);
    await waitApproval();
    interrupted.cancel();
    assert.equal((await interrupted.waitForResult())?.status, 'INTERRUPTED');
    assert.equal(f.ui.pendingApprovals, 0);
  } finally { await f.dispose(); }
});
