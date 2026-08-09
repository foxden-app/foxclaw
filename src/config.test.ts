import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexApiProviderOverrides,
  parseCodexApiProviders,
  selectDefaultRuntimeBotToken,
  validateOpencodeBotToken,
} from './config.js';

test('selectDefaultRuntimeBotToken marks a token already present in TG_BOT_TOKENS', () => {
  assert.equal(selectDefaultRuntimeBotToken(['iso-a', 'shared', 'iso-b'], 'shared'), 'shared');
});

test('selectDefaultRuntimeBotToken ignores legacy token outside TG_BOT_TOKENS', () => {
  assert.equal(selectDefaultRuntimeBotToken(['iso-a', 'iso-b'], 'legacy'), null);
});

test('selectDefaultRuntimeBotToken keeps pure legacy single-bot mode unchanged', () => {
  assert.equal(selectDefaultRuntimeBotToken([], 'legacy'), null);
});

test('validateOpencodeBotToken requires an independent Telegram bot', () => {
  assert.doesNotThrow(() => validateOpencodeBotToken('opencode', ['codex-a', 'codex-b']));
  assert.doesNotThrow(() => validateOpencodeBotToken(null, ['codex-a']));
  assert.throws(
    () => validateOpencodeBotToken('codex-b', ['codex-a', 'codex-b']),
    /must use a different bot/,
  );
});

test('parseCodexApiProviders accepts compact OpenAI-compatible provider specs', () => {
  const providers = parseCodexApiProviders('shop|https://example.test/v1/chat/completions|SHOP_API_KEY|gpt-5.5|Shop Proxy');
  assert.deepEqual(providers, [{
    id: 'shop',
    name: 'Shop Proxy',
    baseUrl: 'https://example.test/v1',
    apiKeyEnv: 'SHOP_API_KEY',
    model: 'gpt-5.5',
    wireApi: 'responses',
    sourceEndpoint: 'https://example.test/v1/chat/completions',
    chatCompletionsOnly: true,
  }]);
});

test('parseCodexApiProviders accepts JSON provider specs', () => {
  const providers = parseCodexApiProviders(JSON.stringify([{
    id: 'OpenAI Proxy',
    baseUrl: 'https://proxy.example/v1',
    apiKeyEnv: 'PROXY_API_KEY',
  }]));
  assert.equal(providers[0]?.id, 'openai-proxy');
  assert.equal(providers[0]?.baseUrl, 'https://proxy.example/v1');
  assert.equal(providers[0]?.chatCompletionsOnly, false);
});

test('buildCodexApiProviderOverrides emits safe Codex config overrides', () => {
  const providers = parseCodexApiProviders('shop|https://example.test/v1|SHOP_API_KEY|gpt-5.5|Shop Proxy');
  assert.deepEqual(buildCodexApiProviderOverrides(providers, 'shop'), [
    'model_providers.shop={ name = "Shop Proxy", base_url = "https://example.test/v1", env_key = "SHOP_API_KEY", wire_api = "responses" }',
    'model_provider="shop"',
    'model="gpt-5.5"',
  ]);
});

test('buildCodexApiProviderOverrides rejects an unknown default provider', () => {
  const providers = parseCodexApiProviders('shop|https://example.test/v1|SHOP_API_KEY');
  assert.throws(
    () => buildCodexApiProviderOverrides(providers, 'missing'),
    /CODEX_API_DEFAULT_PROVIDER/,
  );
});
