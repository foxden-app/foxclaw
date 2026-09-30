import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexApiProviderOverrides,
  loadConfig,
  parseCodexApiProviders,
  selectDefaultRuntimeBotToken,
  validateCodexBotTokens,
  validateOpencodeBotToken,
  validateAntigravityBotToken,
  validateAntigravityBotTokens,
} from './config.js';

test('selectDefaultRuntimeBotToken marks a token already present in tokens list', () => {
  assert.equal(selectDefaultRuntimeBotToken(['iso-a', 'shared', 'iso-b'], 'shared'), 'shared');
});

test('selectDefaultRuntimeBotToken ignores token outside configured tokens', () => {
  assert.equal(selectDefaultRuntimeBotToken(['iso-a', 'iso-b'], 'legacy'), null);
});

test('selectDefaultRuntimeBotToken returns null for empty configured tokens', () => {
  assert.equal(selectDefaultRuntimeBotToken([], 'legacy'), null);
});

test('validateCodexBotTokens catches duplicates', () => {
  assert.doesNotThrow(() => validateCodexBotTokens(['codex-a', 'codex-b']));
  assert.throws(
    () => validateCodexBotTokens(['codex-a', 'codex-a']),
    /CODEX_BOT_TOKENS contains duplicate Telegram bot token/,
  );
});

test('validateOpencodeBotToken requires an independent Telegram bot', () => {
  assert.doesNotThrow(() => validateOpencodeBotToken('opencode', ['codex-a', 'codex-b']));
  assert.doesNotThrow(() => validateOpencodeBotToken(null, ['codex-a']));
  assert.throws(
    () => validateOpencodeBotToken('codex-b', ['codex-a', 'codex-b']),
    /must use a different bot/,
  );
});

test('validateAntigravityBotToken requires an independent Telegram bot from Codex and OpenCode', () => {
  assert.doesNotThrow(() => validateAntigravityBotToken('antigravity', ['codex-a', 'codex-b'], 'opencode'));
  assert.doesNotThrow(() => validateAntigravityBotToken(null, ['codex-a'], null));
  assert.throws(
    () => validateAntigravityBotToken('codex-a', ['codex-a', 'codex-b'], 'opencode'),
    /must use a different bot from CODEX_BOT_TOKENS/,
  );
  assert.throws(
    () => validateAntigravityBotToken('opencode', ['codex-a', 'codex-b'], 'opencode'),
    /must use a different bot from OPENCODE_BOT_TOKEN/,
  );
});

test('validateAntigravityBotTokens supports multiple bots and catches duplicates or collisions', () => {
  assert.doesNotThrow(() => validateAntigravityBotTokens(['agy-1', 'agy-2'], ['codex-a', 'codex-b'], 'opencode'));
  assert.doesNotThrow(() => validateAntigravityBotTokens([], ['codex-a'], null));
  assert.throws(
    () => validateAntigravityBotTokens(['agy-1', 'agy-1'], ['codex-a'], null),
    /contains duplicate Telegram bot token/,
  );
  assert.throws(
    () => validateAntigravityBotTokens(['agy-1', 'codex-a'], ['codex-a', 'codex-b'], null),
    /must use a different bot from CODEX_BOT_TOKENS/,
  );
  assert.throws(
    () => validateAntigravityBotTokens(['agy-1', 'opencode'], ['codex-a'], 'opencode'),
    /must use a different bot from OPENCODE_BOT_TOKEN/,
  );
});

test('loadConfig explicitly rejects legacy TG_BOT_TOKEN and TG_BOT_TOKENS', () => {
  const origTg = process.env.TG_BOT_TOKEN;
  const origTgs = process.env.TG_BOT_TOKENS;
  const origCodex = process.env.CODEX_BOT_TOKENS;
  try {
    delete process.env.CODEX_BOT_TOKENS;
    process.env.TG_BOT_TOKEN = '123:abc';
    assert.throws(
      () => loadConfig(),
      /Configuration error: TG_BOT_TOKEN and TG_BOT_TOKENS have been removed/,
    );

    delete process.env.TG_BOT_TOKEN;
    process.env.TG_BOT_TOKENS = '123:abc,456:def';
    assert.throws(
      () => loadConfig(),
      /Configuration error: TG_BOT_TOKEN and TG_BOT_TOKENS have been removed/,
    );
  } finally {
    if (origTg !== undefined) process.env.TG_BOT_TOKEN = origTg; else delete process.env.TG_BOT_TOKEN;
    if (origTgs !== undefined) process.env.TG_BOT_TOKENS = origTgs; else delete process.env.TG_BOT_TOKENS;
    if (origCodex !== undefined) process.env.CODEX_BOT_TOKENS = origCodex; else delete process.env.CODEX_BOT_TOKENS;
  }
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
