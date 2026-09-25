import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpencodeEngineAdapter } from './adapter.js';
import type { OpencodeAppClient } from './client.js';

test('OpencodeEngineAdapter listModels parses connected provider models', async () => {
  const fakeClient = new EventEmitter() as any;
  fakeClient.isConnected = () => true;
  fakeClient.getClient = () => ({
    provider: {
      list: async () => ({
        data: {
          connected: ['anthropic', 'openai'],
          all: [
            {
              id: 'anthropic',
              name: 'Anthropic',
              models: {
                'claude-3-5-sonnet': { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Smart model' },
              },
            },
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', description: 'Fast model' },
              },
            },
          ],
          default: {
            anthropic: 'claude-3-5-sonnet',
            openai: 'gpt-4o',
          },
        },
      }),
    },
  });

  const adapter = new OpencodeEngineAdapter(fakeClient as unknown as OpencodeAppClient);
  const models = await adapter.listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, 'anthropic/claude-3-5-sonnet');
  assert.equal(models[0]?.name, 'Anthropic - Claude 3.5 Sonnet');
  assert.equal(models[0]?.isDefault, true);
  assert.equal(models[1]?.id, 'openai/gpt-4o');
});

test('OpencodeEngineAdapter executeTurn runs turn, streams deltas and tools, and completes on idle', async () => {
  const fakeClient = new EventEmitter() as any;
  fakeClient.isConnected = () => true;

  let promptAsyncCalled = false;
  let abortCalled = false;
  let watchedSessionId = '';

  fakeClient.getClient = () => ({
    session: {
      create: async () => ({
        data: { id: 'sess_123', directory: '/test' },
      }),
      promptAsync: async (params: any) => {
        promptAsyncCalled = true;
        assert.equal(params.sessionID, 'sess_123');
        assert.equal(params.parts[0]?.text, 'Do something');
        return { data: {} };
      },
      abort: async () => {
        abortCalled = true;
        return { data: {} };
      },
    },
  });

  fakeClient.watchSessionUntilIdle = (id: string) => {
    watchedSessionId = id;
  };

  const adapter = new OpencodeEngineAdapter(fakeClient as unknown as OpencodeAppClient);

  const execution = adapter.executeTurn({
    scopeId: 'scope_1',
    prompt: 'Do something',
    threadId: null,
    cwd: '/test',
    model: 'anthropic/claude-3-5-sonnet',
    locale: 'zh',
  });

  const deltas: string[] = [];
  const tools: string[] = [];

  execution.on('delta', (d) => deltas.push(d));
  execution.on('tool', (t) => tools.push(t.name));

  await new Promise((r) => setTimeout(r, 20));
  assert.ok(promptAsyncCalled);
  assert.equal(watchedSessionId, 'sess_123');

  // Emit text event with null delta (should not append "null")
  fakeClient.emit('event', {
    kind: 'text',
    sessionId: 'sess_123',
    delta: null,
  });

  // Emit text event
  fakeClient.emit('event', {
    kind: 'text',
    sessionId: 'sess_123',
    delta: 'Hello ',
  });
  fakeClient.emit('event', {
    kind: 'text',
    sessionId: 'sess_123',
    delta: 'World!',
  });

  // Emit tool event
  fakeClient.emit('event', {
    kind: 'tool',
    sessionId: 'sess_123',
    tool: 'bash',
    status: 'running',
  });

  // Emit idle event
  fakeClient.emit('event', {
    kind: 'idle',
    sessionId: 'sess_123',
  });

  const result = await execution.waitForResult();
  assert.ok(result);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.response, 'Hello World!');
  assert.equal(result.conversationId, 'sess_123');
  assert.deepEqual(deltas, ['Hello ', 'World!']);
  assert.deepEqual(tools, ['bash']);

  execution.cancel();
  assert.ok(abortCalled);
});

test('OpencodeEngineAdapter handles error event and emits error', async () => {
  const fakeClient = new EventEmitter() as any;
  fakeClient.isConnected = () => true;

  fakeClient.getClient = () => ({
    session: {
      create: async () => ({
        data: { id: 'sess_err', directory: '/test' },
      }),
      promptAsync: async () => ({ data: {} }),
      abort: async () => ({ data: {} }),
    },
  });
  fakeClient.watchSessionUntilIdle = () => {};

  const adapter = new OpencodeEngineAdapter(fakeClient as unknown as OpencodeAppClient);
  const execution = adapter.executeTurn({
    scopeId: 'scope_err',
    prompt: 'Fail me',
    threadId: null,
    cwd: '/test',
    model: 'default',
    locale: 'zh',
  });

  let errorEmitted: Error | null = null;
  execution.on('error', (err) => {
    errorEmitted = err;
  });

  await new Promise((r) => setTimeout(r, 20));

  fakeClient.emit('event', {
    kind: 'error',
    sessionId: 'sess_err',
    message: 'Process crashed',
  });

  const res = await execution.waitForResult();
  assert.ok(res);
  assert.equal(res.status, 'ERROR');
  assert.equal(res.response, 'Process crashed');
  assert.ok(errorEmitted);
  assert.equal((errorEmitted as Error).message, 'Process crashed');
});
