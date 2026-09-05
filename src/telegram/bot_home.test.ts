import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTelegramBotHome } from './bot_home.js';
import { inferTelegramBotId, resolveTelegramVoiceTarget } from '../voice/target.js';

function tempRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-bot-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('new bot homes use the exact username and preserve media routing by numeric identity', (t) => {
  const root = tempRoot(t);
  const home = prepareTelegramBotHome(root, 'bot123', 'WuguiAI_Bot');
  assert.equal(home, path.join(root, '@WuguiAI_Bot', 'home'));
  assert.equal(fs.realpathSync(path.join(root, 'bot123', 'home')), home);
  assert.equal(inferTelegramBotId(home), 'bot123');
  assert.equal(resolveTelegramVoiceTarget(['123:one', '456:two'], inferTelegramBotId(home)).botId, 'bot123');
  assert.equal(prepareTelegramBotHome(root, 'bot123', null), home);
  assert.equal(prepareTelegramBotHome(root, 'bot123', 'WuguiAI_Bot'), home);
});

test('legacy migration preserves session files, permissions and absolute auth symlinks', (t) => {
  const root = tempRoot(t);
  const oldHome = path.join(root, 'bot123', 'home');
  fs.mkdirSync(oldHome, { recursive: true });
  fs.writeFileSync(path.join(oldHome, 'session.jsonl'), 'existing history\n');
  fs.writeFileSync(path.join(oldHome, 'auth.test'), 'test credential', { mode: 0o600 });
  fs.symlinkSync(path.join(oldHome, 'auth.test'), path.join(oldHome, 'auth.json'));
  const home = prepareTelegramBotHome(root, 'bot123', 'Example_Bot');
  assert.equal(fs.readFileSync(path.join(home, 'session.jsonl'), 'utf8'), 'existing history\n');
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), 'test credential');
  assert.equal(fs.readFileSync(path.join(oldHome, 'session.jsonl'), 'utf8'), 'existing history\n');
  assert.equal(fs.statSync(path.join(home, 'auth.test')).mode & 0o777, 0o600);
});

test('a changed username moves the same home and retains both historical paths', (t) => {
  const root = tempRoot(t);
  const first = prepareTelegramBotHome(root, 'bot123', 'First_Bot');
  fs.writeFileSync(path.join(first, 'session.jsonl'), 'history');
  const next = prepareTelegramBotHome(root, 'bot123', 'Next_Bot');
  assert.equal(fs.realpathSync(first), next);
  assert.equal(fs.readFileSync(path.join(next, 'session.jsonl'), 'utf8'), 'history');
  assert.equal(prepareTelegramBotHome(root, 'bot123', null), next);
});

test('offline first startup uses a stable ID and migrates after username becomes available', (t) => {
  const root = tempRoot(t);
  const offline = prepareTelegramBotHome(root, 'bot123', null);
  assert.equal(offline, path.join(root, 'bot123', 'home'));
  fs.writeFileSync(path.join(offline, 'session.jsonl'), 'offline history');
  const online = prepareTelegramBotHome(root, 'bot123', 'Online_Bot');
  assert.equal(fs.readFileSync(path.join(online, 'session.jsonl'), 'utf8'), 'offline history');
});

test('shared terminal home gets a named entrance without moving or copying its data', (t) => {
  const root = tempRoot(t);
  const shared = path.join(root, 'terminal');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'session.jsonl'), 'terminal history');
  const base = path.join(root, 'telegram');
  const home = prepareTelegramBotHome(base, 'bot123', 'Shared_Bot', shared);
  assert.equal(fs.realpathSync(home), shared);
  assert.equal(fs.readFileSync(path.join(home, 'session.jsonl'), 'utf8'), 'terminal history');
  assert.equal(inferTelegramBotId(home), 'bot123');
  assert.equal(prepareTelegramBotHome(base, 'bot123', null, shared), home);
  assert.throws(() => prepareTelegramBotHome(base, 'bot123', 'Shared_Bot'), /unexpectedly shares/);
});

test('name collisions and invalid paths fail without overwriting either bot', (t) => {
  const root = tempRoot(t);
  const first = prepareTelegramBotHome(root, 'bot123', 'Same_Bot');
  fs.writeFileSync(path.join(first, 'session.jsonl'), 'first');
  assert.throws(() => prepareTelegramBotHome(root, 'bot456', 'Same_Bot'), /another identity/);
  fs.mkdirSync(path.join(root, '@Occupied_Bot'));
  assert.throws(() => prepareTelegramBotHome(root, 'bot123', 'Occupied_Bot'), /another identity/);
  assert.throws(() => prepareTelegramBotHome(root, 'bot123', '../escape'), /Invalid Telegram username/);
  assert.equal(fs.readFileSync(path.join(first, 'session.jsonl'), 'utf8'), 'first');
});
