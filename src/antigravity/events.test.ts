import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AntigravityEventNormalizer,
  isQuotaOrAuthError,
  type AgInitEvent,
  type AgResultEvent,
  type AgStepUpdateEvent,
} from './events.js';

test('AntigravityEventNormalizer parses init event', () => {
  const normalizer = new AntigravityEventNormalizer();
  const raw: AgInitEvent = {
    event: 'init',
    conversation_id: 'conv-123',
    init: {
      cwd: '/workspace',
      tools: ['run_command', 'view_file'],
      permission_mode: 'always-proceed',
    },
  };

  const events = normalizer.accept(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'init');
  if (events[0]?.kind === 'init') {
    assert.equal(events[0].conversationId, 'conv-123');
    assert.equal(events[0].cwd, '/workspace');
    assert.deepEqual(events[0].tools, ['run_command', 'view_file']);
  }
});

test('AntigravityEventNormalizer accumulates text_delta across stream chunks', () => {
  const normalizer = new AntigravityEventNormalizer();
  const chunk1: AgStepUpdateEvent = {
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Hello, ',
    },
  };
  const chunk2: AgStepUpdateEvent = {
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'world!',
    },
  };

  const res1 = normalizer.accept(chunk1);
  assert.equal(res1.length, 1);
  assert.equal(res1[0]?.kind, 'text');
  if (res1[0]?.kind === 'text') {
    assert.equal(res1[0].accumulatedText, 'Hello, ');
  }

  const res2 = normalizer.accept(chunk2);
  assert.equal(res2.length, 1);
  assert.equal(res2[0]?.kind, 'text');
  if (res2[0]?.kind === 'text') {
    assert.equal(res2[0].accumulatedText, 'Hello, world!');
  }
});

test('AntigravityEventNormalizer parses tool events', () => {
  const normalizer = new AntigravityEventNormalizer();
  const toolStart: AgStepUpdateEvent = {
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'ls -la' },
      },
    },
  };

  const res = normalizer.accept(toolStart);
  assert.equal(res.length, 1);
  assert.equal(res[0]?.kind, 'tool');
  if (res[0]?.kind === 'tool') {
    assert.equal(res[0].toolName, 'run_command');
    assert.equal(res[0].state, 'ACTIVE');
    assert.deepEqual(res[0].parameters, { CommandLine: 'ls -la' });
  }
});

test('AntigravityEventNormalizer handles result and quota error detection', () => {
  const normalizer = new AntigravityEventNormalizer();
  const errorResult: AgResultEvent = {
    event: 'result',
    result: {
      conversation_id: 'conv-123',
      status: 'ERROR',
      response: '',
      error: 'ResourceExhausted: Quota exceeded for model gemini-3.8-flash',
      duration_seconds: 1.2,
      num_turns: 1,
    },
  };

  const events = normalizer.accept(errorResult);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, 'result');
  assert.equal(events[1]?.kind, 'error');
  if (events[1]?.kind === 'error') {
    assert.equal(events[1].isQuotaError, true);
    assert.match(events[1].message, /ResourceExhausted/);
  }

  assert.equal(isQuotaOrAuthError('Rate limit reached (429)'), true);
  assert.equal(isQuotaOrAuthError('Some other syntax error'), false);
});
