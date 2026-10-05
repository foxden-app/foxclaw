import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeDsh } from './test_support.js';
import { UnifiedBridgeCore } from '../antigravity/controller.js';
import { BridgeStore } from '../store/database.js';
import { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { TelegramGateway } from '../telegram/gateway.js';
import type { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';

test('DSH on a unified bot retains the service self-update command', async () => {
  const fixture = await fakeDsh();
  const authDir = path.join(fixture.root, 'auth');
  await fs.mkdir(authDir);
  const store = new BridgeStore(path.join(fixture.root, 'bridge.db'));
  const messages: string[] = [];
  const launches: Array<{ scope: string; locale: string }> = [];
  const config = { dsh: fixture.options, defaultCwd: fixture.root, antigravityAuthDir: authDir, antigravityCliBin: 'agy', antigravityDefaultModel: 'default' } as AppConfig;
  const core = new UnifiedBridgeCore(config, store, new Logger('error', path.join(fixture.root, 'test.log')),
    { stop: () => {}, username: 'FixtureBot' } as TelegramGateway, undefined, undefined,
    { sendRichMarkdown: async (_scope: string, text: string) => { messages.push(text); return 1; } } as TelegramMessagingPort,
    { defaultBackendId: 'dsh', selfUpdater: {
      readStatus: async () => null, clearStatus: async () => {},
      launch: async (scope, locale) => { launches.push({ scope, locale }); },
    } });
  try {
    await (core as any).orchestrator.handleText({ scopeId: 'scope', chatId: '1', topicId: null, chatType: 'private', userId: '1', messageId: 1,
      text: '/update', attachments: [], entities: [], replyToBot: false });
    assert.deepEqual(launches, [{ scope: 'scope', locale: 'zh' }]);
    assert.ok(messages.some(message => message.includes('自升级')));
    assert.ok(messages.every(message => !message.includes('ACP')));
  } finally { await core.stop(); store.close(); await fixture.cleanup(); }
});
