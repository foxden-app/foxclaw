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

test('AuthCandidateMirror suppresses duplicate concurrent syncs for the same candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-mirror-duplicate-'));
  const canonical = path.join(root, 'canonical');
  const a = path.join(root, 'bot1');
  const b = path.join(root, 'bot2');
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
    ], loggerStub as any);
    await mirror.initialize();

    const refreshed = auth('acct-1', '2026-05-27T00:00:00.000Z');
    await fs.writeFile(path.join(a, 'auth.json_work'), refreshed);
    const first = mirror.syncRuntimeCandidate('bot1', 'auth.json_work');
    await notificationStarted;
    const second = await mirror.syncRuntimeCandidate('bot1', 'auth.json_work');
    releaseNotification();

    assert.equal(second, false);
    assert.equal(await first, true);
    assert.equal(notifications.length, 1);
    assert.equal(await fs.readFile(path.join(canonical, 'auth.json_work'), 'utf8'), refreshed);
  } finally {
    releaseNotification?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AuthCandidateMirror requires runtime validation before propagating a refreshed candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-validate-'));
  const canonical = path.join(root, 'canonical');
  const runtime = path.join(root, 'bot1');
  let validationContext: unknown = null;
  try {
    await fs.mkdir(canonical, { recursive: true });
    const original = auth('acct-1', '2026-05-01T00:00:00.000Z');
    await fs.writeFile(path.join(canonical, 'auth.json_work'), original);
    const mirror = new AuthCandidateMirror(canonical, [{
      id: 'bot1',
      authDir: runtime,
      validate: async (context) => {
        validationContext = context;
        return { ok: false, reason: 'backend rejected credentials' };
      },
    }], loggerStub as any);
    await mirror.initialize();
    await fs.writeFile(path.join(runtime, 'auth.json_work'), auth('acct-1', '2026-05-27T00:00:00.000Z'));

    assert.equal(await mirror.syncRuntimeCandidate('bot1', 'auth.json_work'), false);
    assert.deepEqual(validationContext, {
      candidateName: 'auth.json_work',
      accountId: 'acct-1',
      lastRefreshMs: Date.parse('2026-05-27T00:00:00.000Z'),
    });
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

test('AuthCandidateMirror recovers interrupted validation symlink on startup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-temp-symlink-'));
  const canonical = path.join(root, 'canonical');
  const statusPath = path.join(root, 'runtime', 'auth-mirror.json');
  const warnings: Array<{ event: string; data: Record<string, unknown> }> = [];
  const logger = {
    ...loggerStub,
    warn(event: string, data: Record<string, unknown>): void {
      warnings.push({ event, data });
    },
  };
  try {
    await fs.mkdir(canonical, { recursive: true });
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(path.join(canonical, 'auth.json_newer'), auth('acct-1', '2026-05-27T00:00:00.000Z'));
    await fs.writeFile(path.join(canonical, 'auth.json_status'), auth('acct-1', '2026-05-01T00:00:00.000Z'));
    await fs.writeFile(
      statusPath,
      `${JSON.stringify({
        candidateName: 'auth.json_status',
        sourceRuntimeId: 'bot1',
        sourceLabel: '@botA',
        syncedAt: '2026-06-01T00:00:00.000Z',
      })}\n`,
    );
    await fs.writeFile(path.join(canonical, '.auth-sync-validate-test.json'), auth('acct-temp', '2026-06-01T00:00:00.000Z'));
    await fs.symlink(path.join(canonical, '.auth-sync-validate-test.json'), path.join(canonical, 'auth.json'));

    const mirror = new AuthCandidateMirror(canonical, [], logger as any, statusPath);
    await mirror.initialize();

    assert.equal(
      await fs.realpath(path.join(canonical, 'auth.json')),
      await fs.realpath(path.join(canonical, 'auth.json_status')),
    );
    await assert.rejects(fs.stat(path.join(canonical, '.auth-sync-validate-test.json')));
    assert.equal(warnings.at(-1)?.event, 'codex.auth_temp_symlink_recovered');
    assert.equal(warnings.at(-1)?.data.newTarget, path.join(canonical, 'auth.json_status'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AuthCandidateMirror falls back to newest parseable candidate for validation symlink recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-temp-runtime-'));
  const canonical = path.join(root, 'canonical');
  const runtime = path.join(root, 'bot1');
  try {
    await fs.mkdir(runtime, { recursive: true });
    const oldCandidate = path.join(runtime, 'auth.json_old');
    const newCandidate = path.join(runtime, 'auth.json_new');
    await fs.writeFile(oldCandidate, auth('acct-1', '2026-05-01T00:00:00.000Z'));
    await fs.writeFile(newCandidate, auth('acct-1', '2026-05-27T00:00:00.000Z'));
    const oldTime = new Date('2026-05-01T00:00:00.000Z');
    const newTime = new Date('2026-05-27T00:00:00.000Z');
    await fs.utimes(oldCandidate, oldTime, oldTime);
    await fs.utimes(newCandidate, newTime, newTime);
    await fs.writeFile(path.join(runtime, '.auth-sync-validate-test.json'), auth('acct-temp', '2026-06-01T00:00:00.000Z'));
    await fs.symlink(path.join(runtime, '.auth-sync-validate-test.json'), path.join(runtime, 'auth.json'));

    const mirror = new AuthCandidateMirror(canonical, [{ id: 'bot1', authDir: runtime }], loggerStub as any);
    await mirror.initialize();

    assert.equal(await fs.realpath(path.join(runtime, 'auth.json')), await fs.realpath(newCandidate));
    await assert.rejects(fs.stat(path.join(runtime, '.auth-sync-validate-test.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AuthCandidateMirror recovers a newer same-account credential before a runtime switches auth', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-recover-'));
  const canonical = path.join(root, 'canonical');
  const a = path.join(root, 'bot1');
  const b = path.join(root, 'bot2');
  try {
    await fs.mkdir(canonical, { recursive: true });
    await fs.writeFile(path.join(canonical, 'auth.json_work'), auth('acct-1', '2026-05-01T00:00:00.000Z'));
    const mirror = new AuthCandidateMirror(canonical, [
      { id: 'bot1', authDir: a },
      { id: 'bot2', authDir: b },
    ], loggerStub as any);
    await mirror.initialize();
    const refreshed = auth('acct-1', '2026-05-27T00:00:00.000Z');
    await fs.writeFile(path.join(a, 'auth.json_personal'), refreshed);

    assert.deepEqual(await mirror.recoverRuntimeCandidate('bot2', 'auth.json_work'), {
      candidateName: 'auth.json_work',
      sourceRuntimeId: 'bot1',
      sourceCandidateName: 'auth.json_personal',
      lastRefreshMs: Date.parse('2026-05-27T00:00:00.000Z'),
    });
    assert.equal(await fs.readFile(path.join(b, 'auth.json_work'), 'utf8'), refreshed);
    assert.equal(
      await fs.readFile(path.join(canonical, 'auth.json_work'), 'utf8'),
      auth('acct-1', '2026-05-01T00:00:00.000Z'),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AuthCandidateMirror does not recover a newer credential from a different account', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-recover-conflict-'));
  const canonical = path.join(root, 'canonical');
  const a = path.join(root, 'bot1');
  const b = path.join(root, 'bot2');
  try {
    await fs.mkdir(canonical, { recursive: true });
    const original = auth('acct-1', '2026-05-01T00:00:00.000Z');
    await fs.writeFile(path.join(canonical, 'auth.json_work'), original);
    const mirror = new AuthCandidateMirror(canonical, [
      { id: 'bot1', authDir: a },
      { id: 'bot2', authDir: b },
    ], loggerStub as any);
    await mirror.initialize();
    await fs.writeFile(path.join(a, 'auth.json_work'), auth('acct-2', '2026-05-27T00:00:00.000Z'));

    assert.equal(await mirror.recoverRuntimeCandidate('bot2', 'auth.json_work'), null);
    assert.equal(await fs.readFile(path.join(b, 'auth.json_work'), 'utf8'), original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
