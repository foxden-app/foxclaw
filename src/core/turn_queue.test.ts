import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnQueueManager } from './turn_queue.js';

test('TurnQueueManager manages queue order, peek, dequeue, and clear', () => {
  const manager = new TurnQueueManager<{ meta: string }>();

  assert.equal(manager.getMode('scope-1'), 'queue');
  manager.setMode('scope-1', 'steer');
  assert.equal(manager.getMode('scope-1'), 'steer');

  assert.equal(manager.getQueueLength('scope-1'), 0);
  assert.equal(manager.peek('scope-1'), undefined);
  assert.equal(manager.dequeue('scope-1'), undefined);

  const item1 = manager.enqueue('scope-1', {
    scopeId: 'scope-1',
    prompt: 'task 1',
    payload: { meta: 'first' },
  });

  const item2 = manager.enqueue('scope-1', {
    scopeId: 'scope-1',
    prompt: 'task 2',
    payload: { meta: 'second' },
  });

  assert.equal(manager.getQueueLength('scope-1'), 2);
  assert.equal(manager.peek('scope-1')?.id, item1.id);
  assert.equal(manager.peek('scope-1')?.prompt, 'task 1');

  const dequeued1 = manager.dequeue('scope-1');
  assert.equal(dequeued1?.id, item1.id);
  assert.equal(dequeued1?.payload.meta, 'first');
  assert.equal(manager.getQueueLength('scope-1'), 1);

  const dequeued2 = manager.dequeue('scope-1');
  assert.equal(dequeued2?.id, item2.id);
  assert.equal(manager.getQueueLength('scope-1'), 0);

  // Clear queue
  manager.enqueue('scope-2', { scopeId: 'scope-2', prompt: 'a', payload: { meta: 'a' } });
  manager.enqueue('scope-2', { scopeId: 'scope-2', prompt: 'b', payload: { meta: 'b' } });
  assert.equal(manager.clearQueue('scope-2'), 2);
  assert.equal(manager.getQueueLength('scope-2'), 0);
});
