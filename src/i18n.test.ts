import test from 'node:test';
import assert from 'node:assert/strict';
import { getOpencodeTelegramCommands, getTelegramCommands, normalizeLocale, t } from './i18n.js';

test('normalizeLocale maps telegram language codes', () => {
  assert.equal(normalizeLocale('zh-CN'), 'zh');
  assert.equal(normalizeLocale('zh-hans'), 'zh');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale(undefined), 'en');
});

test('getTelegramCommands returns localized descriptions', () => {
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'models')?.description, 'Model settings');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'models')?.description, '模型设置');
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'watch')?.description, 'Watch the bound thread');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'watch')?.description, '观察当前线程');
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'mode')?.description, 'Agent or one-shot Plan');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'plan')?.description, '下一轮使用 Plan');
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'update')?.description, 'Update and restart FoxClaw');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'update')?.description, '升级并重启 FoxClaw');
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'rich')?.description, 'Telegram RichMessage demo');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'rich')?.description, 'Telegram RichMessage 演示');
});

test('OpenCode Telegram menu preserves every Codex command entry point', () => {
  const codex = getTelegramCommands('zh').map((entry) => entry.command);
  const opencode = getOpencodeTelegramCommands('zh').map((entry) => entry.command);
  assert.deepEqual(opencode.slice(0, codex.length), codex);
  assert.equal(getOpencodeTelegramCommands('zh').find((entry) => entry.command === 'models')?.description, '模型列表');
  assert.equal(getOpencodeTelegramCommands('zh').find((entry) => entry.command === 'update')?.description, '请改用 Codex Bot');
});

test('t interpolates localized templates', () => {
  assert.equal(t('en', 'bound_to_thread', { threadId: 'abc' }), 'Bound to thread abc');
  assert.equal(t('zh', 'bound_to_thread', { threadId: 'abc' }), '已绑定到线程 abc');
});
