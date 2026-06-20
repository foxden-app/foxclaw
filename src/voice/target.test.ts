import assert from 'node:assert/strict';
import test from 'node:test';
import { inferTelegramBotId, resolveTelegramVoiceTarget } from './target.js';

test('infers a Telegram bot ID from a namespaced Codex home', () => {
  assert.equal(inferTelegramBotId('/tmp/telegram/bot123/home'), 'bot123');
});

test('derives the bot ID from the only configured token for a default runtime', () => {
  assert.deepEqual(resolveTelegramVoiceTarget(['8664971887:secret'], null), {
    botId: 'bot8664971887',
    botToken: '8664971887:secret',
  });
});

test('selects an explicitly requested bot without exposing other tokens', () => {
  assert.deepEqual(resolveTelegramVoiceTarget(['111:first', '222:second'], 'bot222'), {
    botId: 'bot222',
    botToken: '222:second',
  });
});
