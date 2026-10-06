import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexEngineAdapter } from './adapter.js';
import type { CodexAppClient } from './client.js';

test('CodexEngineAdapter implements IEngineAdapter, lists models and executes turn streaming', async () => {
  const clientEmitter = new EventEmitter();
  let startedThreadParams: any = null;
  let startedTurnParams: any = null;
  let interruptedTurn = false;

  const mockClient: any = {
    listModels: async () => [
      { id: 'o3', displayName: 'o3 Reasoning', description: 'Deep reasoning', isDefault: true },
      { id: 'gpt-4o', displayName: 'GPT-4o', description: 'Fast multimodal' },
    ],
    startThread: async (params: any) => {
      startedThreadParams = params;
      return {
        thread: {
          threadId: 'th-codex-1',
          name: 'Test Thread',
          preview: '',
          cwd: params.cwd,
          modelProvider: 'openai',
          status: 'idle',
          archived: false,
          updatedAt: Date.now(),
        },
      };
    },
    startTurn: async (params: any) => {
      startedTurnParams = params;
      return { id: 'turn-c-1', status: 'in_progress' };
    },
    interruptTurn: async () => {
      interruptedTurn = true;
    },
    on: (event: string, listener: any) => clientEmitter.on(event, listener),
    off: (event: string, listener: any) => clientEmitter.off(event, listener),
  };

  const adapter = new CodexEngineAdapter(mockClient as CodexAppClient, {
    defaultModel: 'o3',
    defaultApprovalPolicy: 'on-request',
    defaultSandboxMode: 'workspace-write',
  });

  assert.equal(adapter.id, 'codex');
  assert.equal(adapter.name, 'OpenAI Codex (App Server)');

  const models = await adapter.listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, 'o3');
  assert.equal(models[0]?.name, 'o3 Reasoning');
  assert.equal(models[0]?.isDefault, true);
  assert.ok(models.every((m) => m.id === 'o3' || m.id === 'gpt-4o')); // Only the server's advertised models.

  const deltas: string[] = [];
  const tools: any[] = [];
  let resultReceived: any = null;

  const execution = adapter.executeTurn({
    scopeId: 'scope-c1',
    prompt: 'Implement feature',
    threadId: null,
    cwd: '/workspace/project',
    model: 'o3',
    effort: 'high',
    locale: 'zh',
  });

  execution.on('delta', (d) => deltas.push(d));
  execution.on('tool', (t) => tools.push(t));
  execution.on('result', (r) => {
    resultReceived = r;
  });

  // Wait a tick for run() to invoke startThread & startTurn
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(startedThreadParams);
  assert.equal(startedThreadParams.cwd, '/workspace/project');
  assert.ok(startedTurnParams);
  assert.equal(startedTurnParams.threadId, 'th-codex-1');
  assert.equal(startedTurnParams.effort, 'high');

  // Simulate RPC notification for delta
  clientEmitter.emit('notification', {
    method: 'item/agentMessage/delta',
    params: {
      turnId: 'turn-c-1',
      itemId: 'msg-1',
      delta: 'Hello Codex world!',
    },
  });

  // Simulate tool command
  clientEmitter.emit('notification', {
    method: 'codex/event/exec_command_begin',
    params: {
      msg: {
        call_id: 'call-1',
        turn_id: 'turn-c-1',
        command: ['git', 'status'],
        cwd: '/workspace/project',
        parsed_cmd: [],
      },
    },
  });

  clientEmitter.emit('notification', {
    method: 'codex/event/exec_command_end',
    params: {
      msg: {
        call_id: 'call-1',
        turn_id: 'turn-c-1',
        command: ['git', 'status'],
        cwd: '/workspace/project',
        parsed_cmd: [],
      },
    },
  });

  // Simulate turn completed
  clientEmitter.emit('notification', {
    method: 'turn/completed',
    params: {
      turn: { id: 'turn-c-1' },
    },
  });

  const finalResult = await execution.waitForResult();
  assert.ok(finalResult);
  assert.equal(finalResult!.status, 'SUCCESS');
  assert.equal(finalResult!.response, 'Hello Codex world!');
  assert.equal(finalResult!.conversationId, 'th-codex-1');
  assert.deepEqual(deltas, ['Hello Codex world!']);
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.name, 'git status');
  assert.equal(tools[0]?.status, 'running');
  assert.equal(tools[1]?.status, 'completed');
  assert.ok(resultReceived);

  // Test cancellation
  await execution.cancel();
  assert.equal(interruptedTurn, false); // A completed turn must not interrupt a later turn in the same thread.
});

test('Codex adapter carries the selected access policy into thread and turn RPCs', async () => {
  for (const [preset, sandboxMode, approvalPolicy] of [
    ['read-only', 'read-only', 'on-request'], ['full-access', 'danger-full-access', 'never'], ['default', 'workspace-write', 'on-request'],
  ] as const) {
    const notifications = new EventEmitter(); const calls: any[] = [];
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const client = { startThread: async (params: any) => { calls.push(params); return { thread: { threadId: 'native-thread' } }; },
      startTurn: async (params: any) => { calls.push(params); started(); return { id: 'native-turn' }; },
      interruptTurn: async () => {}, on: (name: string, listener: any) => notifications.on(name, listener), off: (name: string, listener: any) => notifications.off(name, listener),
    } as unknown as CodexAppClient;
    const execution = new CodexEngineAdapter(client).executeTurn({ scopeId: 'scope', prompt: 'work', threadId: null, cwd: '/tmp', model: 'default', locale: 'en', accessPreset: preset });
    await ready;
    assert.equal(calls.length, 2);
    for (const params of calls) { assert.equal(params.sandboxMode, sandboxMode); assert.equal(params.approvalPolicy, approvalPolicy); }
    await execution.cancel();
    assert.equal((await execution.waitForResult())?.status, 'INTERRUPTED');
    assert.equal(notifications.listenerCount('notification'), 0);
  }
});

test('Codex cancellation during thread preparation settles waiters without starting a turn', async () => {
  const notifications = new EventEmitter(); let release!: (value: any) => void;
  const session = new Promise<any>(resolve => { release = resolve; }); let starts = 0;
  const client = { startThread: () => session, startTurn: async () => { starts++; return { id: 'turn' }; },
    interruptTurn: async () => {}, on: (name: string, listener: any) => notifications.on(name, listener), off: (name: string, listener: any) => notifications.off(name, listener),
  } as unknown as CodexAppClient;
  const execution = new CodexEngineAdapter(client).executeTurn({ scopeId: 'scope', prompt: 'work', threadId: null, cwd: '/tmp', model: 'default', locale: 'en' });
  const result = execution.waitForResult(); const cancelled = execution.cancel();
  release({ thread: { threadId: 'prepared-thread' } }); await cancelled;
  assert.equal(starts, 0);
  assert.equal((await result)?.status, 'INTERRUPTED');
  assert.equal(notifications.listenerCount('notification'), 0);
});

test('Codex cancellation waits for a pending start RPC and interrupts the resulting native turn', async () => {
  const notifications = new EventEmitter(); let release!: (value: any) => void; let entered!: () => void;
  const pending = new Promise<any>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
  const interrupted: string[] = [];
  const client = { resumeThread: async () => {}, startTurn: () => { entered(); return pending; },
    interruptTurn: async (_thread: string, turn: string) => { interrupted.push(turn); },
    on: (name: string, listener: any) => notifications.on(name, listener), off: (name: string, listener: any) => notifications.off(name, listener),
  } as unknown as CodexAppClient;
  const execution = new CodexEngineAdapter(client).executeTurn({ scopeId: 'scope', prompt: 'work', threadId: 'thread', cwd: '/tmp', model: 'default', locale: 'en' });
  await ready; const cancelled = execution.cancel(); assert.deepEqual(interrupted, []);
  notifications.emit('notification', { method: 'turn/completed', params: { turn: { id: 'old-turn' } } });
  release({ id: 'late-started-turn' }); await cancelled;
  assert.deepEqual(interrupted, ['late-started-turn']);
  assert.equal((await execution.waitForResult())?.status, 'INTERRUPTED');
  assert.equal(notifications.listenerCount('notification'), 0);
});

test('Codex buffers early notifications until the native turn id is known and ignores unrelated turns', async () => {
  const notifications = new EventEmitter(); let release!: (value: any) => void; let entered!: () => void;
  const pending = new Promise<any>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
  const client = { resumeThread: async () => {}, startTurn: () => { entered(); return pending; }, interruptTurn: async () => {},
    on: (name: string, listener: any) => notifications.on(name, listener), off: (name: string, listener: any) => notifications.off(name, listener),
  } as unknown as CodexAppClient;
  const execution = new CodexEngineAdapter(client).executeTurn({ scopeId: 'scope', prompt: 'work', threadId: 'thread', cwd: '/tmp', model: 'default', locale: 'en' });
  const deltas: string[] = []; execution.on('delta', delta => deltas.push(delta));
  await ready;
  notifications.emit('notification', { method: 'turn/completed', params: { threadId: 'other-thread', turn: { id: 'other-turn' } } });
  notifications.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'actual-turn', itemId: 'item', delta: 'early text' } });
  notifications.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'actual-turn' } } });
  notifications.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'actual-turn', itemId: 'item', delta: 'late text' } });
  release({ id: 'actual-turn' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(execution.turnId, 'actual-turn'); assert.deepEqual(deltas, ['early text']);
  notifications.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'actual-turn' } } });
  assert.equal((await execution.waitForResult())?.response, 'early text');
  assert.equal(notifications.listenerCount('notification'), 0);
});

test('Codex relays completed commentary separately and keeps only final items in the result', async () => {
  const notifications = new EventEmitter();
  const client = {
    startThread: async () => ({ thread: { threadId: 'thread' } }), startTurn: async () => ({ id: 'turn' }),
    on: (name: string, listener: any) => notifications.on(name, listener), off: (name: string, listener: any) => notifications.off(name, listener),
  } as unknown as CodexAppClient;
  const execution = new CodexEngineAdapter(client).executeTurn({ scopeId: 'a', prompt: 'fix', threadId: null, cwd: '/tmp', model: 'default', locale: 'en' });
  const commentary: any[] = [];
  execution.on('commentary', value => commentary.push(value));
  await new Promise(resolve => setImmediate(resolve));
  const item = (method: string, id: string, phase: string, text?: string) => notifications.emit('notification', {
    method, params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', id, phase, text } },
  });
  item('item/started', 'progress', 'commentary');
  notifications.emit('notification', { method: 'item/agentMessage/delta', params: { turnId: 'turn', itemId: 'progress', delta: 'Checking' } });
  item('item/completed', 'progress', 'commentary', 'Checking the configuration.');
  item('item/completed', 'progress', 'commentary', 'Checking the configuration.');
  item('item/completed', 'final', 'final_answer', 'Fixed the configuration.');
  notifications.emit('notification', { method: 'turn/completed', params: { turn: { id: 'turn' } } });
  assert.deepEqual(commentary, [{ messageId: 'progress', text: 'Checking the configuration.' }]);
  assert.equal((await execution.waitForResult())?.response, 'Fixed the configuration.');
  assert.equal(notifications.listenerCount('disconnected'), 0);
});

test('Codex disconnect settles waiters with an unconfirmed outcome and removes native listeners', async () => {
  const notifications = new EventEmitter();
  const client = {
    startThread: async () => ({ thread: { threadId: 'thread' } }), startTurn: async () => ({ id: 'turn' }),
    on: (name: string, listener: any) => notifications.on(name, listener), off: (name: string, listener: any) => notifications.off(name, listener),
  } as unknown as CodexAppClient;
  const execution = new CodexEngineAdapter(client).executeTurn({ scopeId: 'a', prompt: 'fix', threadId: null, cwd: '/tmp', model: 'default', locale: 'en' });
  await new Promise(resolve => setImmediate(resolve));
  notifications.emit('disconnected', { source: 'websocket-close' });
  const result = await execution.waitForResult();
  assert.equal(result?.outcomeUnknown, true);
  assert.equal(result?.status, 'ERROR');
  assert.equal(notifications.listenerCount('notification'), 0);
  assert.equal(notifications.listenerCount('disconnected'), 0);
});

test('Codex RPC outcome-unknown timeouts never become replayable execution errors', async () => {
  const notifications = new EventEmitter();
  const client = {
    startThread: async () => ({ thread: { threadId: 'thread' } }),
    startTurn: async () => { throw new Error('Codex RPC turn/start timed out; result is unknown'); },
    on: (name: string, listener: any) => notifications.on(name, listener), off: (name: string, listener: any) => notifications.off(name, listener),
  } as unknown as CodexAppClient;
  const execution = new CodexEngineAdapter(client).executeTurn({ scopeId: 'a', prompt: 'fix', threadId: null, cwd: '/tmp', model: 'default', locale: 'en' });
  let executionErrors = 0;
  execution.on('error', () => { executionErrors++; });
  const result = await execution.waitForResult();
  assert.equal(result?.outcomeUnknown, true);
  assert.equal(executionErrors, 0);
  assert.equal(notifications.listenerCount('notification'), 0);
});
