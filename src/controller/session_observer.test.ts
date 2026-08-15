import test from 'node:test';
import assert from 'node:assert/strict';
import { applySessionLog, bootstrapSessionLog, splitJsonlChunk } from './session_observer.js';

test('bootstrapSessionLog replays only the currently active turn', () => {
  const lines = [
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done', phase: 'final_answer' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-2' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'OK' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Watching progress.', phase: 'commentary' },
    }),
  ];

  const bootstrap = bootstrapSessionLog(lines);
  assert.equal(bootstrap.startedTurnId, 'turn-2');
  assert.equal(bootstrap.cursor.activeTurnId, 'turn-2');
  assert.equal(bootstrap.cursor.nextMessageIndex, 1);
  assert.deepEqual(bootstrap.events.map(event => event.kind), [
    'user_message',
    'agent_message_started',
    'agent_message_delta',
    'agent_message_completed',
  ]);
});

test('applySessionLog emits tool and completion events for appended lines', () => {
  const diff = applySessionLog([
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ cmd: 'sleep 10', workdir: '/tmp/repo' }),
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: 'call-1',
        turn_id: 'turn-2',
        command: ['/bin/bash', '-lc', 'sleep 10'],
        cwd: '/tmp/repo',
        parsed_cmd: [{ type: 'unknown', cmd: 'sleep 10' }],
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done', phase: 'final_answer' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-2' },
    }),
  ], {
    activeTurnId: 'turn-2',
    nextMessageIndex: 1,
  });

  assert.deepEqual(diff.events.map(event => event.kind), [
    'tool_started',
    'tool_completed',
    'agent_message_started',
    'agent_message_delta',
    'agent_message_completed',
    'turn_completed',
  ]);
  assert.equal(diff.cursor.activeTurnId, null);
  assert.equal(diff.cursor.nextMessageIndex, 0);
});

test('applySessionLog relays plan response items as commentary', () => {
  const diff = applySessionLog([
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'plan', text: '1. Inspect\n2. Report' },
    }),
  ], {
    activeTurnId: 'turn-2',
    nextMessageIndex: 0,
  });

  assert.deepEqual(diff.events.map(event => event.kind), [
    'agent_message_started',
    'agent_message_delta',
    'agent_message_completed',
  ]);
  assert.deepEqual(diff.events.map(event => 'outputKind' in event ? event.outputKind : null), [
    'commentary',
    'commentary',
    'commentary',
  ]);
});

test('applySessionLog relays Codex 0.147 completed agent items once', () => {
  const diff = applySessionLog([
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'turn-2',
        item: {
          type: 'AgentMessage',
          id: 'message-1',
          content: [{ type: 'Text', text: 'Current Codex output.' }],
          phase: 'final_answer',
        },
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'message-1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Current Codex output.' }],
        phase: 'final_answer',
      },
    }),
  ], {
    activeTurnId: 'turn-2',
    nextMessageIndex: 0,
  });

  assert.deepEqual(diff.events.map(event => event.kind), [
    'agent_message_started',
    'agent_message_delta',
    'agent_message_completed',
  ]);
  assert.deepEqual(diff.events.map(event => 'itemId' in event ? event.itemId : null), [
    'message-1',
    'message-1',
    'message-1',
  ]);
  assert.equal(diff.cursor.nextMessageIndex, 1);
  const completed = diff.events.find(event => event.kind === 'agent_message_completed');
  assert.equal(completed?.text, 'Current Codex output.');
  assert.equal(completed?.outputKind, 'final_answer');
});

test('applySessionLog relays Codex 0.147 user items once', () => {
  const diff = applySessionLog([
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'turn-2',
        item: {
          type: 'UserMessage',
          id: 'user-message-1',
          content: [{ type: 'Text', text: 'Continue from the CLI.' }],
        },
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Continue from the CLI.' }],
      },
    }),
  ], {
    activeTurnId: 'turn-2',
    nextMessageIndex: 0,
  });

  assert.deepEqual(diff.events, [{
    kind: 'user_message',
    turnId: 'turn-2',
    text: 'Continue from the CLI.',
  }]);
});

test('applySessionLog tracks modern tool calls across poll chunks', () => {
  const started = applySessionLog([
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call-1',
        name: 'exec',
        input: 'const result = await tools.exec_command(...);',
      },
    }),
  ], {
    activeTurnId: 'turn-2',
    nextMessageIndex: 0,
  });

  assert.equal(started.events[0]?.kind, 'tool_started');
  assert.deepEqual(started.cursor.pendingToolCalls, [{
    callId: 'call-1',
    kind: 'custom',
    name: 'exec',
  }]);

  const completed = applySessionLog([
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call-1',
        output: [],
      },
    }),
  ], started.cursor);

  assert.equal(completed.events[0]?.kind, 'tool_completed');
  assert.deepEqual(completed.cursor.pendingToolCalls, []);
  assert.deepEqual(
    completed.events.map(event => event.kind === 'tool_completed' ? event.exec.command : null),
    [['Tool exec']],
  );
});

test('bootstrapSessionLog preserves a pending modern tool call for tail completion', () => {
  const bootstrap = bootstrapSessionLog([
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-2' },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call-wait',
        name: 'wait',
        arguments: '{}',
      },
    }),
  ]);

  assert.deepEqual(bootstrap.cursor.pendingToolCalls, [{
    callId: 'call-wait',
    kind: 'function',
    name: 'wait',
  }]);
  const completed = applySessionLog([
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-wait',
        output: null,
      },
    }),
  ], bootstrap.cursor);
  assert.equal(completed.events[0]?.kind, 'tool_completed');
  assert.deepEqual(completed.cursor.pendingToolCalls, []);
});

test('applySessionLog ignores unmatched modern tool outputs', () => {
  const diff = applySessionLog([
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'unknown-call',
        output: null,
      },
    }),
  ], {
    activeTurnId: 'turn-2',
    nextMessageIndex: 0,
  });

  assert.deepEqual(diff.events, []);
});

test('applySessionLog completes current Codex aborted turns as interrupted', () => {
  const diff = applySessionLog([
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'turn_aborted',
        turn_id: 'turn-2',
        reason: 'interrupted',
      },
    }),
  ], {
    activeTurnId: 'turn-2',
    nextMessageIndex: 1,
  });

  assert.deepEqual(diff.events, [{
    kind: 'turn_completed',
    turnId: 'turn-2',
    state: 'interrupted',
  }]);
  assert.deepEqual(diff.cursor, {
    activeTurnId: null,
    nextMessageIndex: 0,
  });
});

test('splitJsonlChunk preserves incomplete trailing lines', () => {
  const split = splitJsonlChunk('', '{"a":1}\n{"b":2}');
  assert.deepEqual(split.lines, ['{"a":1}']);
  assert.equal(split.remainder, '{"b":2}');
});
