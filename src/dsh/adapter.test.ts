import test from 'node:test';
import assert from 'node:assert/strict';
import { DshEngineAdapter } from './adapter.js';
import { fakeDsh } from './test_support.js';
import type { EngineTurnRequest, EngineToolEvent } from '../core/engine_spi.js';

test('DSH routes models and native reasoning, keeps final text, and isolates persistent sessions', async () => {
  const fixture = await fakeDsh();
  const bindings = new Map<string, string>();
  const adapter = new DshEngineAdapter({ createClient: fixture.createClient,
    preferences: scopeId => ({ cwd: fixture.root, threadId: bindings.get(scopeId) ?? null, model: null, effort: null, access: 'default' }),
    bind: (scopeId, sessionId) => { bindings.set(scopeId, sessionId); },
  });
  const request: EngineTurnRequest = { scopeId: 'a', cwd: fixture.root, threadId: null, model: 'default', effort: null, prompt: 'hello', locale: 'zh' };
  try {
    assert.equal((await adapter.listModels('a'))[0]?.id, 'fixture/alpha');
    assert.deepEqual((await adapter.listEfforts('a')).map(choice => choice.value), ['high', 'thinking_16384']);
    const tools: EngineToolEvent[] = [];
    const deltas: string[] = [];
    const execution = adapter.executeTurn({ ...request, effort: 'thinking_16384' });
    execution.on('tool', tool => tools.push(tool));
    execution.on('delta', delta => deltas.push(delta));
    const result = await execution.waitForResult();
    assert.equal(result?.status, 'SUCCESS');
    assert.equal(JSON.parse(result!.response).effort, 'thinking_16384');
    assert.ok(!result!.response.includes('Working...'));
    assert.ok(!deltas.join('').includes('PRIVATE REASONING'));
    assert.deepEqual(tools.map(tool => tool.status), ['running', 'completed']);
    await adapter.listModels('b');
    assert.notEqual(bindings.get('a'), bindings.get('b'));
    const interrupted = adapter.executeTurn({ ...request, prompt: 'wait', threadId: bindings.get('a')! });
    const toolStarted = new Promise<void>(resolve => interrupted.on('tool', () => resolve()));
    await toolStarted;
    interrupted.cancel();
    assert.equal((await interrupted.waitForResult())?.status, 'INTERRUPTED');
    assert.equal((await adapter.executeTurn(request).waitForResult())?.status, 'SUCCESS');
    await assert.rejects(adapter.selectEffort('a', 'unsupported'), /unavailable/);
    await assert.rejects(adapter.selectModel('a', 'unknown/model'), /unavailable/);
    const state = await adapter.sessionForScope('a');
    await state.client.stop();
    const restored = await adapter.sessionForScope('a');
    assert.equal(restored.sessionId, bindings.get('a'));
    assert.equal((await adapter.executeTurn({ ...request, prompt: 'disconnect' }).waitForResult())?.status, 'ERROR');
  } finally { await adapter.stop(); await fixture.cleanup(); }
});

test('DSH cancellation during startup never enqueues the prompt', async () => {
  const fixture = await fakeDsh();
  const adapter = new DshEngineAdapter({ createClient: fixture.createClient,
    preferences: () => ({ cwd: fixture.root, threadId: null, model: null, effort: null, access: 'read-only' }), bind: () => {},
  });
  try {
    const execution = adapter.executeTurn({ scopeId: 'start', cwd: fixture.root, threadId: null, model: 'default', prompt: 'wait', locale: 'en' });
    execution.cancel();
    assert.equal((await execution.waitForResult())?.status, 'INTERRUPTED');
  } finally { await adapter.stop(); await fixture.cleanup(); }
});
