import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CrossNodeAuthSync,
  type AuthSyncConfig,
  type AuthSyncImportCallbacks,
  type AuthSyncNotification,
} from './cross_node_sync.js';
import type { AuthMirrorCandidateRecord } from './mirror.js';

const loggerStub = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const SHARED_KEY = '0123456789abcdef0123456789abcdef';

function rawAuth(accountId: string, lastRefresh: string, expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${JSON.stringify({
    tokens: {
      account_id: accountId,
      access_token: `${header}.${payload}.sig`,
    },
    last_refresh: lastRefresh,
  })}\n`;
}

function record(candidateName: string, accountId: string, lastRefresh: string): AuthMirrorCandidateRecord {
  return {
    candidateName,
    accountId,
    lastRefreshMs: Date.parse(lastRefresh),
    raw: rawAuth(accountId, lastRefresh),
    sourceRuntimeId: 'runtime',
    sourceLabel: '@local',
  };
}

function config(root: string, nodeId: string, peers: string[]): AuthSyncConfig {
  return {
    enabled: true,
    transport: 'telegram-private',
    key: SHARED_KEY,
    peers,
    nodeId,
    clusterId: 'test',
    statePath: path.join(root, `${nodeId}.json`),
    tempDir: path.join(root, 'tmp'),
  };
}

test('CrossNodeAuthSync pushes encrypted newer auth to an allowed peer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-'));
  try {
    const candidate = record('auth.json_work', 'acct-1', '2026-06-01T00:00:00.000Z');
    let imported: { candidateName: string; raw: string; source: string } | null = null;
    const notificationsA: AuthSyncNotification[] = [];
    const notificationsB: AuthSyncNotification[] = [];
    const services: { b?: CrossNodeAuthSync } = {};
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      { send: async () => undefined },
      callbacks({
        validate: async () => ({ ok: true }),
        importCandidate: async (candidateName, raw, source) => {
          imported = { candidateName, raw, source: source.nodeId };
          return { ok: true, imported: true };
        },
        notify: async (event) => {
          notificationsB.push(event);
        },
      }),
    );
    services.b = serviceB;
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.b!.handleIncomingEnvelope(envelope, { userId: '100', username: 'botA' });
        },
      },
      callbacks({
        records: [candidate],
        notify: async (event) => {
          notificationsA.push(event);
        },
      }),
    );
    await serviceB.initialize();
    await serviceA.initialize();

    assert.equal(await serviceA.publishCandidate('auth.json_work'), true);
    await waitFor(() => notificationsB.some(event => event.kind === 'remote_import_imported'));
    assert.equal(serviceA.getStatus().recentEvents.some(event =>
      event.kind === 'push.bundle'
      && event.stage === 'sent'
      && event.peer === '@botb'
      && event.candidateName === 'auth.json_work'
    ), true);
    assert.equal(serviceB.getStatus().recentEvents.some(event =>
      event.kind === 'push.bundle'
      && event.stage === 'imported'
      && event.peer === '@bota'
      && event.candidateName === 'auth.json_work'
    ), true);
    assert.deepEqual(imported, {
      candidateName: 'auth.json_work',
      raw: candidate.raw,
      source: 'node-a',
    });
    assert.equal(serviceB.getStatus().lastImportCandidate, 'auth.json_work');
    assert.deepEqual(notificationsA.map(event => event.kind), [
      'candidate_publish_started',
      'candidate_publish_completed',
    ]);
    assert.deepEqual(notificationsB.map(event => event.kind), [
      'remote_bundle_received',
      'remote_import_imported',
    ]);
  } finally {
    await removeTempTree(root);
  }
});

test('CrossNodeAuthSync ignores envelopes from peers outside the allowlist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-peer-'));
  try {
    const candidate = record('auth.json_work', 'acct-1', '2026-06-01T00:00:00.000Z');
    let captured = '';
    let imported = false;
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      { send: async (_peer, envelope) => { captured = envelope; } },
      callbacks({ records: [candidate] }),
    );
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      { send: async () => undefined },
      callbacks({
        validate: async () => ({ ok: true }),
        importCandidate: async () => {
          imported = true;
          return { ok: true, imported: true };
        },
      }),
    );
    await serviceA.initialize();
    await serviceB.initialize();
    await serviceA.publishCandidate('auth.json_work');

    assert.equal(await serviceB.handleIncomingEnvelope(captured, { userId: '999', username: 'evil' }), false);
    assert.equal(imported, false);
  } finally {
    await removeTempTree(root);
  }
});

test('CrossNodeAuthSync testPeers waits for peer pong replies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-test-'));
  try {
    const services: { a?: CrossNodeAuthSync; b?: CrossNodeAuthSync } = {};
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.b!.handleIncomingEnvelope(envelope, { userId: '100', username: 'botA' });
        },
      },
      callbacks({}),
    );
    services.a = serviceA;
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.a!.handleIncomingEnvelope(envelope, { userId: '200', username: 'botB' });
        },
      },
      callbacks({}),
    );
    services.b = serviceB;
    await serviceA.initialize();
    await serviceB.initialize();

    assert.deepEqual(await serviceA.testPeers(), {
      sent: 1,
      replied: 1,
      missing: [],
    });
  } finally {
    await removeTempTree(root);
  }
});

test('CrossNodeAuthSync queues remote imports while the local node is busy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-busy-'));
  try {
    const candidate = record('auth.json_work', 'acct-1', '2026-06-01T00:00:00.000Z');
    let idle = false;
    let imported = false;
    const services: { b?: CrossNodeAuthSync } = {};
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.b!.handleIncomingEnvelope(envelope, { userId: '100', username: 'botA' });
        },
      },
      callbacks({ records: [candidate] }),
    );
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      { send: async () => undefined },
      callbacks({
        isIdle: () => idle,
        validate: async () => ({ ok: true }),
        importCandidate: async () => {
          imported = true;
          return { ok: true, imported: true };
        },
      }),
    );
    services.b = serviceB;
    await serviceA.initialize();
    await serviceB.initialize();

    await serviceA.publishCandidate('auth.json_work');
    assert.equal(imported, false);
    assert.equal(serviceB.getStatus().pendingImports, 1);
    idle = true;
    await (serviceB as any).processPendingImports();
    assert.equal(imported, true);
  } finally {
    await removeTempTree(root);
  }
});

test('CrossNodeAuthSync notifies when remote auth validation fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-validation-'));
  try {
    const candidate = record('auth.json_work', 'acct-1', '2026-06-01T00:00:00.000Z');
    const notificationsB: AuthSyncNotification[] = [];
    const services: { b?: CrossNodeAuthSync } = {};
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.b!.handleIncomingEnvelope(envelope, { userId: '100', username: 'botA' });
        },
      },
      callbacks({ records: [candidate] }),
    );
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      { send: async () => undefined },
      callbacks({
        validate: async () => ({ ok: false, reason: 'codex account authentication required to read rate limits' }),
        notify: async (event) => {
          notificationsB.push(event);
        },
      }),
    );
    services.b = serviceB;
    await serviceA.initialize();
    await serviceB.initialize();

    await serviceA.publishCandidate('auth.json_work');
    await waitFor(() => notificationsB.some(event => event.kind === 'remote_import_failed'));

    const failure = notificationsB.find((event): event is Extract<AuthSyncNotification, { kind: 'remote_import_failed' }> =>
      event.kind === 'remote_import_failed');
    assert.equal(failure?.candidateName, 'auth.json_work');
    assert.match(failure?.reason ?? '', /authentication required/);
    assert.equal(serviceB.getStatus().lastError, null);
    assert.equal(serviceB.getStatus().candidateFailures.length, 1);
    assert.equal(serviceB.getStatus().candidateFailures[0]?.candidateName, 'auth.json_work');
    assert.match(serviceB.getStatus().candidateFailures[0]?.reason ?? '', /authentication required/);
  } finally {
    await removeTempTree(root);
  }
});

test('CrossNodeAuthSync treats already-newer local candidate as a normal skip', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-not-newer-'));
  try {
    const candidate = record('auth.json_work', 'acct-1', '2026-06-01T00:00:00.000Z');
    const notificationsB: AuthSyncNotification[] = [];
    const services: { b?: CrossNodeAuthSync } = {};
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.b!.handleIncomingEnvelope(envelope, { userId: '100', username: 'botA' });
        },
      },
      callbacks({ records: [candidate] }),
    );
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      { send: async () => undefined },
      callbacks({
        importCandidate: async () => ({ ok: true, imported: false, reason: 'local candidate is already newer or equal' }),
        notify: async (event) => {
          notificationsB.push(event);
        },
      }),
    );
    services.b = serviceB;
    await serviceA.initialize();
    await serviceB.initialize();

    await serviceA.publishCandidate('auth.json_work');
    await waitFor(() => notificationsB.some(event => event.kind === 'remote_import_skipped'));

    assert.equal(serviceB.getStatus().lastError, null);
    assert.deepEqual(serviceB.getStatus().candidateFailures, []);
    const skipped = notificationsB.find((event): event is Extract<AuthSyncNotification, { kind: 'remote_import_skipped' }> =>
      event.kind === 'remote_import_skipped');
    assert.equal(skipped?.reason, 'local candidate is already newer or equal');
  } finally {
    await removeTempTree(root);
  }
});

test('CrossNodeAuthSync serializes concurrent remote import validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-serial-'));
  try {
    const records = [
      record('auth.json_one', 'acct-1', '2026-06-01T00:00:00.000Z'),
      record('auth.json_two', 'acct-2', '2026-06-01T00:00:01.000Z'),
      record('auth.json_three', 'acct-3', '2026-06-01T00:00:02.000Z'),
    ];
    let activeValidations = 0;
    let maxActiveValidations = 0;
    let importedCount = 0;
    const services: { b?: CrossNodeAuthSync } = {};
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.b!.handleIncomingEnvelope(envelope, { userId: '100', username: 'botA' });
        },
      },
      callbacks({ records }),
    );
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      { send: async () => undefined },
      callbacks({
        validate: async () => {
          activeValidations += 1;
          maxActiveValidations = Math.max(maxActiveValidations, activeValidations);
          await new Promise(resolve => setTimeout(resolve, 20));
          activeValidations -= 1;
          return { ok: true };
        },
        importCandidate: async () => {
          importedCount += 1;
          return { ok: true, imported: true };
        },
      }),
    );
    services.b = serviceB;
    await serviceA.initialize();
    await serviceB.initialize();

    await serviceA.pushAll();
    await waitFor(() => importedCount === records.length);

    assert.equal(maxActiveValidations, 1);
  } finally {
    await removeTempTree(root);
  }
});

test('CrossNodeAuthSync pull recovery imports the first newer peer bundle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-pull-'));
  try {
    const newer = record('auth.json_work', 'acct-1', '2026-06-01T00:00:00.000Z');
    const services: { a?: CrossNodeAuthSync; b?: CrossNodeAuthSync } = {};
    let imported = false;
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.b!.handleIncomingEnvelope(envelope, { userId: '100', username: 'botA' });
        },
      },
      callbacks({ records: [newer] }),
    );
    services.a = serviceA;
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.a!.handleIncomingEnvelope(envelope, { userId: '200', username: 'botB' });
        },
      },
      callbacks({
        validate: async () => ({ ok: true }),
        importCandidate: async () => {
          imported = true;
          return { ok: true, imported: true };
        },
      }),
    );
    services.b = serviceB;
    await serviceA.initialize();
    await serviceB.initialize();

    assert.equal(await serviceB.requestRecovery('auth.json_work', {
      accountId: 'acct-1',
      lastRefreshMs: Date.parse('2026-05-01T00:00:00.000Z'),
    }), true);
    assert.equal(imported, true);
  } finally {
    await removeTempTree(root);
  }
});

test('CrossNodeAuthSync recovery notifies when all peers lack a usable candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-pull-empty-'));
  try {
    const notificationsB: AuthSyncNotification[] = [];
    const services: { a?: CrossNodeAuthSync; b?: CrossNodeAuthSync } = {};
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.b!.handleIncomingEnvelope(envelope, { userId: '100', username: 'botA' });
        },
      },
      callbacks({ records: [] }),
    );
    services.a = serviceA;
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.a!.handleIncomingEnvelope(envelope, { userId: '200', username: 'botB' });
        },
      },
      callbacks({
        notify: async (event) => {
          notificationsB.push(event);
        },
      }),
    );
    services.b = serviceB;
    await serviceA.initialize();
    await serviceB.initialize();

    assert.equal(await serviceB.requestRecovery('auth.json_work', {
      accountId: 'acct-1',
      lastRefreshMs: Date.parse('2026-05-01T00:00:00.000Z'),
    }), false);

    assert.deepEqual(notificationsB.map(event => event.kind), [
      'recovery_started',
      'recovery_peer_empty',
      'recovery_failed',
    ]);
    const failure = notificationsB.at(-1);
    assert.equal(failure?.kind, 'recovery_failed');
    assert.match(failure && 'reason' in failure ? failure.reason : '', /all peers replied/);
  } finally {
    await removeTempTree(root);
  }
});

test('CrossNodeAuthSync refresh lease requires peer grant', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-auth-sync-lease-'));
  try {
    let peerIdle = true;
    const services: { a?: CrossNodeAuthSync; b?: CrossNodeAuthSync } = {};
    const serviceA = new CrossNodeAuthSync(
      config(root, 'node-a', ['@botB']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.b!.handleIncomingEnvelope(envelope, { userId: '100', username: 'botA' });
        },
      },
      callbacks({ records: [] }),
    );
    services.a = serviceA;
    const serviceB = new CrossNodeAuthSync(
      config(root, 'node-b', ['@botA']),
      loggerStub as any,
      {
        send: async (_peer, envelope) => {
          await services.a!.handleIncomingEnvelope(envelope, { userId: '200', username: 'botB' });
        },
      },
      callbacks({ isIdle: () => peerIdle }),
    );
    services.b = serviceB;
    await serviceA.initialize();
    await serviceB.initialize();

    const granted = await serviceA.acquireRefreshLease('test');
    assert.equal(granted.ok, true);
    assert.equal(serviceA.isIdle(), false);
    assert.equal(serviceB.isIdle(), false);
    const duplicate = await serviceA.acquireRefreshLease('test-again');
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.reason ?? '', /another refresh lease is active/);
    await serviceA.releaseRefreshLease(granted.leaseId);
    assert.equal(serviceA.isIdle(), true);
    assert.equal(serviceB.isIdle(), true);

    peerIdle = false;
    const denied = await serviceA.acquireRefreshLease('test');
    assert.equal(denied.ok, false);
    assert.match(denied.reason ?? '', /not idle/);
  } finally {
    await removeTempTree(root);
  }
});

function callbacks(options: {
  records?: AuthMirrorCandidateRecord[];
  isIdle?: () => boolean;
  validate?: AuthSyncImportCallbacks['validateCandidate'];
  importCandidate?: AuthSyncImportCallbacks['importCandidate'];
  notify?: AuthSyncImportCallbacks['notify'];
}): AuthSyncImportCallbacks {
  const records = options.records ?? [];
  const result: AuthSyncImportCallbacks = {
    readLocalCandidate: async (candidateName) => records.find(record => record.candidateName === candidateName) ?? null,
    listLocalCandidates: async () => records,
    validateCandidate: options.validate ?? (async () => ({ ok: true })),
    importCandidate: options.importCandidate ?? (async () => ({ ok: true, imported: true })),
    isIdle: options.isIdle ?? (() => true),
  };
  if (options.notify) {
    result.notify = options.notify;
  }
  return result;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}

async function removeTempTree(root: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY') {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  await fs.rm(root, { recursive: true, force: true });
}
