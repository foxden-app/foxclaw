import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AntigravityEngineAdapter } from './adapter.js';
import type { AntigravityAppClient, AntigravityTurnExecution } from './client.js';
import type { AntigravityBridgeEvent } from './events.js';

test('AntigravityEngineAdapter converts models and maps turn lifecycle events to Engine SPI', async () => {
  const mockClientEmitter = new EventEmitter();
  let executedOptions: Record<string, unknown> | null = null;

  const mockExecution: AntigravityTurnExecution = {
    conversationId: 'conv-123',
    cancel: () => {
      mockClientEmitter.emit('exit', 0, null);
    },
    waitForResult: async () => {
      return {
        kind: 'result',
        status: 'SUCCESS',
        response: 'Hello from Antigravity',
        conversationId: 'conv-123',
        durationSeconds: 1,
      };
    },
    on: (event: any, listener: any) => {
      mockClientEmitter.on(event, listener);
    },
  };

  const mockClient: Partial<AntigravityAppClient> = {
    listModels: async () => ['gemini-3.8-flash-high', 'gemini-3.1-pro-high', 'claude-sonnet-4-6'],
    executeTurn: (opts: any) => {
      executedOptions = opts;
      return mockExecution;
    },
  };

  const adapter = new AntigravityEngineAdapter(mockClient as AntigravityAppClient, 'gemini-3.8-flash-high');

  assert.equal(adapter.id, 'antigravity');
  assert.equal(adapter.name, 'Google Antigravity (AGY)');

  const models = await adapter.listModels();
  assert.equal(models.length, 3);
  assert.equal(models[0]?.id, 'gemini-3.8-flash-high');
  assert.equal(models[0]?.isDefault, true);
  assert.equal(models[1]?.id, 'gemini-3.1-pro-high');
  assert.equal(models[1]?.isDefault, false);

  const deltas: string[] = [];
  const tools: any[] = [];
  let resultReceived: any = null;

  const execution = adapter.executeTurn({
    scopeId: 'test-scope',
    prompt: 'Summarize file',
    threadId: 'conv-123',
    cwd: '/tmp',
    model: 'gemini-3.8-flash-high',
    locale: 'zh',
    stagedAttachments: [
      {
        fileName: 'photo.jpg',
        localPath: '/tmp/photo.jpg',
        relativePath: '.telegram-inbox/photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        nativeImage: true,
        kind: 'photo',
        fileId: 'f1',
        fileUniqueId: 'u1',
        width: 100,
        height: 100,
        durationSeconds: null,
        isAnimated: false,
        isVideo: false,
      },
    ],
  });

  execution.on('delta', (d) => deltas.push(d));
  execution.on('tool', (t) => tools.push(t));
  execution.on('result', (r) => {
    resultReceived = r;
  });

  // Verify prompt was wrapped with attachments
  assert.ok(executedOptions);
  assert.ok((executedOptions as any).prompt.includes('Telegram attachments'));
  assert.ok((executedOptions as any).prompt.includes('/tmp/photo.jpg'));

  // Emit mock events
  const deltaEvent: AntigravityBridgeEvent = {
    kind: 'text',
    conversationId: 'conv-123',
    stepIndex: 1,
    delta: 'Hello ',
    accumulatedText: 'Hello ',
  };
  mockClientEmitter.emit('event', deltaEvent);

  const toolEvent: AntigravityBridgeEvent = {
    kind: 'tool',
    conversationId: 'conv-123',
    stepIndex: 1,
    state: 'ACTIVE',
    toolName: 'view_file',
    parameters: { path: '/tmp/photo.jpg' },
  };
  mockClientEmitter.emit('event', toolEvent);

  const resultEvent: AntigravityBridgeEvent = {
    kind: 'result',
    status: 'SUCCESS',
    response: 'Finished',
    conversationId: 'conv-123',
    durationSeconds: 2,
  };
  mockClientEmitter.emit('event', resultEvent);

  assert.deepEqual(deltas, ['Hello ']);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'view_file');
  assert.equal(tools[0]?.status, 'running');
  assert.equal(resultReceived?.status, 'SUCCESS');
  assert.equal(resultReceived?.response, 'Finished');

  const waitRes = await execution.waitForResult();
  assert.equal(waitRes?.status, 'SUCCESS');
  assert.equal(waitRes?.response, 'Hello from Antigravity');
});

test('AntigravityEngineAdapter falls back to defaultModel and captures error message on failure', async () => {
  const mockClientEmitter = new EventEmitter();
  let executedOptions: Record<string, unknown> | null = null;

  const mockExecution: AntigravityTurnExecution = {
    conversationId: 'conv-456',
    cancel: () => {},
    waitForResult: async () => null,
    on: (event: any, listener: any) => {
      mockClientEmitter.on(event, listener);
    },
  };

  const mockClient: Partial<AntigravityAppClient> = {
    listModels: async () => ['gemini-3.8-flash-high'],
    executeTurn: (opts: any) => {
      executedOptions = opts;
      return mockExecution;
    },
  };

  const adapter = new AntigravityEngineAdapter(mockClient as AntigravityAppClient, 'gemini-3.8-flash-high');

  let resultReceived: any = null;
  const execution = adapter.executeTurn({
    scopeId: 'test-scope',
    prompt: 'test prompt',
    threadId: 'conv-456',
    cwd: '/tmp',
    model: 'default',
    locale: 'zh',
  });

  execution.on('result', (r) => {
    resultReceived = r;
  });

  // Verify that model: 'default' fell back to 'gemini-3.8-flash-high'
  assert.equal((executedOptions as any)?.model, 'gemini-3.8-flash-high');

  // Emit error result where response is empty but error has text
  const errorResult: AntigravityBridgeEvent = {
    kind: 'result',
    status: 'ERROR',
    response: '',
    error: 'invalid model selection (--model "default")',
    conversationId: 'conv-456',
    durationSeconds: 0,
  };
  mockClientEmitter.emit('event', errorResult);

  assert.equal(resultReceived?.status, 'ERROR');
  assert.equal(resultReceived?.response, 'invalid model selection (--model "default")');
});

