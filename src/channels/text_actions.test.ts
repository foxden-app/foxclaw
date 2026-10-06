import test from 'node:test';
import assert from 'node:assert/strict';
import { TextActions } from './text_actions.js';
import type { ChannelTextEvent } from '../core/channel_events.js';

const event = (scopeId: string, text: string): ChannelTextEvent => ({ scopeId, chatId: scopeId, topicId: null, chatType: 'private', userId: 'user', messageId: 1, text, entities: [], attachments: [], replyToBot: false });
const choice = (rendered: string) => rendered.slice(rendered.indexOf('/choose'));

test('text menu choices belong to their scope, expire on replacement and can only be used once', () => {
  const actions = new TextActions();
  const command = choice(actions.render('a', 7, [[{ text: 'Approve', callback_data: 'approval:abc:accept' }]]));
  assert.equal(actions.resolve(event('b', command)), null);
  const callback = actions.resolve(event('a', command))!;
  assert.equal(callback.data, 'approval:abc:accept');
  assert.equal(callback.messageId, 7);
  assert.equal(actions.resolve(event('a', command)), null);
  const replaced = choice(actions.render('a', 8, [[{ text: 'Retry', callback_data: 'retry' }]]));
  actions.clearMessage('a', 8);
  assert.equal(actions.resolve(event('a', replaced)), null);
});

test('text menu choices respect expiration and bounded retention even for a large keyboard', () => {
  const expired = new TextActions(-1);
  assert.equal(expired.resolve(event('a', choice(expired.render('a', 1, [[{ text: 'Old', callback_data: 'old' }]])))), null);
  const actions = new TextActions(300_000, 2);
  const lines = actions.render('a', 1, [[1, 2, 3].map(i => ({ text: String(i), callback_data: String(i) }))]).split('\n');
  assert.equal(actions.resolve(event('a', choice(lines[0]!))), null);
  assert.equal(actions.resolve(event('a', choice(lines[1]!)))?.data, '2');
  assert.equal(actions.resolve(event('a', choice(lines[2]!)))?.data, '3');
});
