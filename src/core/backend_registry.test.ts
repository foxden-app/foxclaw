import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendRegistry } from './backend_registry.js';
import { ScopeOperations } from './scope_operations.js';
import type { BackendUiHost } from './backend_ui.js';
import type { BackendDescriptor } from './engine_spi.js';

const host = {} as BackendUiHost;
function backend(id = 'custom'): BackendDescriptor {
  return { id, name: 'Custom', engineType: id, adapter: { id, name: 'Custom', listModels: async () => [], executeTurn: () => { throw new Error('unused'); } } };
}

test('registry refreshes metadata without replacing execution identity or reconstructing its UI', async () => {
  const registry = new BackendRegistry(host); const entry = backend();
  let created = 0; let stopped = 0;
  entry.createUi = received => { assert.equal(received, host); created++; return {
    ownsCallback: data => data.startsWith('custom:'), getPendingApprovals: () => 2, stop: async () => { stopped++; },
  }; };
  registry.register(entry);
  registry.register({ id: entry.id, name: 'Updated', engineType: entry.id, adapter: entry.adapter, account: 'active' });
  assert.equal(created, 1);
  assert.equal(registry.get(entry.id)?.name, 'Updated');
  assert.equal(registry.get(entry.id)?.account, 'active');
  assert.equal(registry.getPendingApprovals(), 2);
  assert.equal(registry.callbackOwner('custom:approve'), registry.ui(entry.id));
  assert.equal(registry.callbackOwner('other:approve'), undefined);
  assert.throws(() => registry.register(backend()), /different runtime/);
  await Promise.all([registry.stop(), registry.stop()]);
  assert.equal(stopped, 1);
  assert.throws(() => registry.register(entry), /stopped/);
});

test('registry does not leave a partially registered backend when UI creation fails', () => {
  const registry = new BackendRegistry(host);
  assert.throws(() => registry.register({ ...backend(), createUi: () => { throw new Error('UI failed'); } }), /UI failed/);
  assert.equal(registry.get('custom'), undefined);
});

test('registry attempts all backend cleanup even if one fails', async () => {
  const registry = new BackendRegistry(host); let cleaned = false;
  registry.register({ ...backend('broken'), createUi: () => ({ stop: async () => { throw new Error('failed'); } }) });
  registry.register({ ...backend('healthy'), createUi: () => ({ stop: async () => { cleaned = true; } }) });
  await assert.rejects(registry.stop(), /failed/);
  assert.equal(cleaned, true);
});

test('scope operations preserve order after a failure while independent scopes proceed', async () => {
  const operations = new ScopeOperations(); const seen: string[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const first = operations.run('a', async () => { await gate; seen.push('first'); throw new Error('expected'); });
  const failure = assert.rejects(first, /expected/);
  const second = operations.run('a', async () => { seen.push('second'); });
  await operations.run('b', async () => { seen.push('independent'); });
  assert.deepEqual(seen, ['independent']); assert.equal(operations.isIdle(), false);
  release(); await Promise.all([failure, second]); await operations.idle();
  assert.deepEqual(seen, ['independent', 'first', 'second']); assert.equal(operations.isIdle(), true);
});
