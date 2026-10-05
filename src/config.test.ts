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
  parseDshPatches,
  loadEnv,
} from './config.js';

test('selectDefaultRuntimeBotToken marks a token already present in tokens list', () => {
  assert.equal(selectDefaultRuntimeBotToken(['iso-a', 'shared', 'iso-b'], 'shared'), 'shared');
});

function withDshEnv(overrides: Record<string, string>, run: () => void): void {
  loadEnv();
  const names = ['TG_BOT_TOKEN', 'TG_BOT_TOKENS', 'CODEX_BOT_TOKEN', 'CODEX_BOT_TOKENS', 'ANTIGRAVITY_BOT_TOKEN', 'ANTIGRAVITY_BOT_TOKENS', 'OPENCODE_BOT_TOKEN', 'DSH_BOT_TOKEN', 'DSH_ENABLED', 'DSH_SOURCE_DIR', 'DSH_CLI_BIN', 'DSH_HOME', 'DSH_PROFILE', 'DSH_PATCHES', 'DSH_STARTUP_TIMEOUT_MS', 'TG_ALLOWED_USER_ID', 'WX_ENABLED'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { DSH_BOT_TOKEN: 'dsh-test', TG_ALLOWED_USER_ID: '1', WX_ENABLED: 'false' }, overrides);
    run();
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

test('DSH can run independently or be enabled on an existing bot', () => {
  withDshEnv({ DSH_SOURCE_DIR: '/source/dsh', DSH_HOME: '/home/dsh', DSH_PATCHES: '["/patch.yml"]' }, () => {
    const config = loadConfig();
    assert.deepEqual(config.codexBotTokens, []);
    assert.deepEqual(config.antigravityBotTokens, []);
    assert.equal(config.tgBotToken, 'dsh-test');
    assert.deepEqual(config.tgBotTokens, ['dsh-test']);
    assert.equal(config.dsh?.sourceDir, '/source/dsh');
    assert.equal(config.dsh?.home, '/home/dsh');
    assert.deepEqual(config.dsh?.patches, ['/patch.yml']);
    assert.equal(config.dsh?.profile, 'acp');
  });
  withDshEnv({ DSH_BOT_TOKEN: '', CODEX_BOT_TOKENS: 'codex-test', DSH_ENABLED: 'true' }, () => {
    assert.ok(loadConfig().dsh);
  });
  withDshEnv({ DSH_BOT_TOKEN: '', CODEX_BOT_TOKENS: 'codex-test', DSH_ENABLED: 'false', DSH_SOURCE_DIR: '/source' }, () => {
    assert.equal(loadConfig().dsh, undefined);
  });
});

test('DSH rejects bot collisions, disabled standalone runtime and invalid startup timeouts', () => {
  for (const name of ['CODEX_BOT_TOKENS', 'ANTIGRAVITY_BOT_TOKENS', 'OPENCODE_BOT_TOKEN']) {
    withDshEnv({ [name]: 'dsh-test' }, () => assert.throws(() => loadConfig(), /DSH_BOT_TOKEN must use a different bot/));
  }
  withDshEnv({ DSH_ENABLED: 'false' }, () => assert.throws(() => loadConfig(), /DSH_ENABLED/));
  for (const timeout of ['0', '-1', 'bad', '1.5']) {
    withDshEnv({ DSH_STARTUP_TIMEOUT_MS: timeout }, () => assert.throws(() => loadConfig(), /DSH_STARTUP_TIMEOUT_MS/));
  }
});

test('DSH patches require explicit JSON paths', () => {
  assert.deepEqual(parseDshPatches(undefined), []);
  assert.deepEqual(parseDshPatches('["/one.yml", "/two.yml"]'), ['/one.yml', '/two.yml']);
  for (const value of ['one.yml', '{}', '[1]', '[""]']) assert.throws(() => parseDshPatches(value), /DSH_PATCHES/);
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
