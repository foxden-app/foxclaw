import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSupervisor } from './runtime_supervisor.js';

test('runtime cleanup reverses dependencies, owns partial starts and continues after failure', async () => {
  const supervisor = new RuntimeSupervisor(); const events: string[] = [];
  supervisor.register('database', { stop: () => { events.push('database'); } });
  const native = { stop: () => { events.push('native'); } };
  supervisor.register('native', native); supervisor.register('same-shared-native', native);
  supervisor.register('broken', { start: async () => { throw new Error('partial startup'); }, stop: () => { events.push('broken'); throw new Error('cleanup failed'); } });
  supervisor.register('channel', { stop: () => { events.push('channel'); } });
  await assert.rejects(supervisor.start('broken'), /partial startup/);
  const first = supervisor.stop(); const second = supervisor.stop(); assert.equal(first, second);
  const failures = await first;
  assert.deepEqual(events, ['channel', 'broken', 'native', 'database']);
  assert.equal(failures.length, 1); assert.equal(failures[0]!.name, 'broken');
  assert.throws(() => supervisor.register('late', native), /stopping/);
});

test('stop during startup waits for that startup and releases the resource exactly once', async () => {
  const supervisor = new RuntimeSupervisor(); const events: string[] = [];
  let release!: () => void;
  supervisor.register('runtime', { start: async () => { events.push('start'); await new Promise<void>(r => { release = r; }); events.push('ready'); }, stop: () => { events.push('stop'); } });
  const start = supervisor.start('runtime'); await Promise.resolve();
  const stop = supervisor.stop(); assert.deepEqual(events, ['start']);
  release(); await Promise.all([start, stop]); assert.deepEqual(events, ['start', 'ready', 'stop']);
  await assert.rejects(supervisor.start('runtime'), /stopping/);
});
