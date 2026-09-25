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
  assert.equal(models.length, 3);
  assert.equal(models[0]?.id, 'o3');
  assert.equal(models[0]?.name, 'o3 Reasoning');
  assert.equal(models[0]?.isDefault, true);
  assert.ok(models.some((m) => m.id === 'gpt-6-sol'));

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

  // Test cancellation
  execution.cancel();
  assert.equal(interruptedTurn, true);
});
