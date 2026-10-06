import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BridgeStore } from './database.js';
import type { ChannelInbound } from '../core/channel_events.js';

test('inbox survives reopening before classification, and completion erases input while deduplicating redelivery', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-inbox-'));
  const filename = path.join(root, 'bridge.db');
  let store = new BridgeStore(filename);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const inbound: ChannelInbound = { kind: 'text', event: { scopeId: 'future:scope', chatId: '1', topicId: null, chatType: 'private', userId: '42', messageId: 7, text: 'original input', attachments: [], entities: [], replyToBot: false } };
  assert.equal(store.channelInbox.accept('future:receipt', inbound), true);
  store.close(); store = new BridgeStore(filename);
  assert.deepEqual(store.channelInbox.pending(), [{ id: 'future:receipt', inbound }]);
  store.channelInbox.complete('future:receipt');
  store.close(); store = new BridgeStore(filename);
  assert.deepEqual(store.channelInbox.pending(), []);
  assert.equal(store.channelInbox.accept('future:receipt', inbound), false);
});
