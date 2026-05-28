import test from 'node:test';
import assert from 'node:assert/strict';

import { selectDefaultRuntimeBotToken } from './config.js';

test('selectDefaultRuntimeBotToken marks a token already present in TG_BOT_TOKENS', () => {
  assert.equal(selectDefaultRuntimeBotToken(['iso-a', 'shared', 'iso-b'], 'shared'), 'shared');
});

test('selectDefaultRuntimeBotToken ignores legacy token outside TG_BOT_TOKENS', () => {
  assert.equal(selectDefaultRuntimeBotToken(['iso-a', 'iso-b'], 'legacy'), null);
});

test('selectDefaultRuntimeBotToken keeps pure legacy single-bot mode unchanged', () => {
  assert.equal(selectDefaultRuntimeBotToken([], 'legacy'), null);
});
