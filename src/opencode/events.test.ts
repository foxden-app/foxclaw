import assert from 'node:assert/strict';
import test from 'node:test';
import type { Event } from '@opencode-ai/sdk/v2';
import { OpencodeEventNormalizer } from './events.js';

test('OpenCode event normalizer emits assistant text deltas without echoing user text', () => {
  const normalizer = new OpencodeEventNormalizer();
  assert.deepEqual(normalizer.accept(messageEvent('user-1', 'user')), []);
  assert.deepEqual(normalizer.accept(deltaEvent('user-1', 'hello from user')), []);

  assert.deepEqual(normalizer.accept(messageEvent('assistant-1', 'assistant')), []);
  assert.deepEqual(normalizer.accept(deltaEvent('assistant-1', 'hello')), [{
    kind: 'text',
    sessionId: 'session-1',
    messageId: 'assistant-1',
    partId: 'part-1',
    text: 'hello',
    delta: 'hello',
  }]);
  assert.deepEqual(normalizer.accept(deltaEvent('assistant-1', ' world')), [{
    kind: 'text',
    sessionId: 'session-1',
    messageId: 'assistant-1',
    partId: 'part-1',
    text: 'hello world',
    delta: ' world',
  }]);
});

test('OpenCode event normalizer deduplicates full part updates after deltas', () => {
  const normalizer = new OpencodeEventNormalizer();
  normalizer.accept(messageEvent('assistant-1', 'assistant'));
  normalizer.accept(deltaEvent('assistant-1', 'complete'));
  assert.deepEqual(normalizer.accept({
    id: 'event-part',
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: 'complete',
      },
    },
  } as Event), []);

  normalizer.accept({
    id: 'event-idle',
    type: 'session.idle',
    properties: { sessionID: 'session-1' },
  } as Event);
  assert.deepEqual(normalizer.accept(deltaEvent('assistant-1', ' stale')), []);
});

test('OpenCode event normalizer maps current permission, question, and tool events', () => {
  const normalizer = new OpencodeEventNormalizer();
  const permission = normalizer.accept({
    id: 'event-permission',
    type: 'permission.asked',
    properties: {
      id: 'perm-1', sessionID: 'session-1', permission: 'bash', patterns: ['git status'], metadata: {}, always: ['git *'],
    },
  } as Event);
  assert.equal(permission[0]?.kind, 'permission');

  const question = normalizer.accept({
    id: 'event-question',
    type: 'question.asked',
    properties: {
      id: 'question-1', sessionID: 'session-1', questions: [{ header: 'Choice', question: 'Pick one', options: [], custom: true }],
    },
  } as Event);
  assert.equal(question[0]?.kind, 'question');

  const tool = normalizer.accept({
    id: 'event-tool',
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'tool-part', sessionID: 'session-1', messageID: 'assistant-1', type: 'tool', callID: 'call-1', tool: 'bash',
        state: { status: 'completed', input: {}, output: 'ok', title: 'git status', metadata: {}, time: { start: 1, end: 2 } },
      },
    },
  } as Event);
  assert.deepEqual(tool, [{
    kind: 'tool', sessionId: 'session-1', messageId: 'assistant-1', partId: 'tool-part', callId: 'call-1',
    tool: 'bash', status: 'completed', title: 'git status', error: null,
  }]);
});

function messageEvent(id: string, role: 'user' | 'assistant'): Event {
  const info = role === 'user'
    ? { id, sessionID: 'session-1', role, time: { created: 1 }, agent: 'build', model: { providerID: 'test', modelID: 'test' } }
    : {
        id, sessionID: 'session-1', role, time: { created: 1 }, parentID: 'user-1', modelID: 'test', providerID: 'test',
        mode: 'build', agent: 'build', path: { cwd: '/tmp', root: '/tmp' }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };
  return { id: `event-${id}`, type: 'message.updated', properties: { info } } as Event;
}

function deltaEvent(messageID: string, delta: string): Event {
  return {
    id: `event-${messageID}-${delta.length}`,
    type: 'message.part.delta',
    properties: { sessionID: 'session-1', messageID, partID: 'part-1', field: 'text', delta },
  } as Event;
}
