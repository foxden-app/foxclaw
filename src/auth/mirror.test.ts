import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthCandidateMirror } from './mirror.js';

const loggerStub = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

function auth(accountId: string, lastRefresh: string): string {
  return `${JSON.stringify({ tokens: { account_id: accountId }, last_refresh: lastRefresh })}\n`;
}

test('AuthCandidateMirror propagates a newer validated refresh between runtimes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-mirror-'));
  const canonical = path.join(root, 'canonical');
  const a = path.join(root, 'bot1');
  const b = path.join(root, 'bot2');
  const statusPath = path.join(root, 'runtime', 'auth-mirror.json');
  const notifications: string[] = [];
  let notifyStarted!: () => void;
  const notificationStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let releaseNotification!: () => void;
  const notificationReleased = new Promise<void>((resolve) => {
    releaseNotification = resolve;
  });
  try {
    await fs.mkdir(canonical, { recursive: true });
    await fs.writeFile(path.join(canonical, 'auth.json_work'), auth('acct-1', '2026-05-01T00:00:00.000Z'));
    await fs.symlink(path.join(canonical, 'auth.json_work'), path.join(canonical, 'auth.json'));
    const mirror = new AuthCandidateMirror(canonical, [
      { id: 'bot1', label: '@botA', authDir: a },
      {
        id: 'bot2',
        authDir: b,
        notify: async (message) => {
          notifications.push(message);
          notifyStarted();
          await notificationReleased;
        },
      },
    ], loggerStub as any, statusPath);
    await mirror.initialize();

    const refreshed = auth('acct-1', '2026-05-27T00:00:00.000Z');
    await fs.writeFile(path.join(a, 'auth.json_work'), refreshed);
    const sync = mirror.syncRuntimeCandidate('bot1', 'auth.json_work');
    await notificationStarted;
    assert.equal(mirror.isIdle(), false);
    assert.match(notifications[0]!, /@botA/);
    releaseNotification();
    assert.equal(await sync, true);
    assert.equal(mirror.isIdle(), true);
    assert.equal(await fs.readFile(path.join(canonical, 'auth.json_work'), 'utf8'), refreshed);
    assert.equal(await fs.readFile(path.join(b, 'auth.json_work'), 'utf8'), refreshed);
    assert.deepEqual(mirror.getStatus(), {
      candidateName: 'auth.json_work',
      sourceRuntimeId: 'bot1',
      sourceLabel: '@botA',
      syncedAt: mirror.getStatus()?.syncedAt,
    });
    const statusContents = await fs.readFile(statusPath, 'utf8');
    assert.match(statusContents, /"sourceLabel": "@botA"/);
    assert.doesNotMatch(statusContents, /acct-1/);

    const restarted = new AuthCandidateMirror(canonical, [], loggerStub as any, statusPath);
    await restarted.initialize();
    assert.equal(restarted.getStatus()?.sourceLabel, '@botA');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AuthCandidateMirror rejects a same-name candidate belonging to a different account', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-conflict-'));
  const canonical = path.join(root, 'canonical');
  const runtime = path.join(root, 'bot1');
  try {
    await fs.mkdir(canonical, { recursive: true });
    const original = auth('acct-1', '2026-05-01T00:00:00.000Z');
    await fs.writeFile(path.join(canonical, 'auth.json_work'), original);
    const mirror = new AuthCandidateMirror(canonical, [{ id: 'bot1', authDir: runtime }], loggerStub as any);
    await mirror.initialize();
    await fs.writeFile(path.join(runtime, 'auth.json_work'), auth('acct-2', '2026-05-27T00:00:00.000Z'));

    assert.equal(await mirror.syncRuntimeCandidate('bot1', 'auth.json_work'), false);
    assert.equal(await fs.readFile(path.join(canonical, 'auth.json_work'), 'utf8'), original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AuthCandidateMirror ignores invalid runtime-only candidates during initialization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-invalid-'));
  const canonical = path.join(root, 'canonical');
  const a = path.join(root, 'bot1');
  const b = path.join(root, 'bot2');
  try {
    await fs.mkdir(a, { recursive: true });
    await fs.writeFile(path.join(a, 'auth.json_broken'), '{"not":"credentials"}\n');
    const mirror = new AuthCandidateMirror(canonical, [
      { id: 'bot1', authDir: a },
      { id: 'bot2', authDir: b },
    ], loggerStub as any);
    await mirror.initialize();
    await assert.rejects(fs.stat(path.join(b, 'auth.json_broken')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
