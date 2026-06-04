import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { CrossNodeAuthSync, type AuthSyncConfig, type AuthSyncImportCallbacks } from './cross_node_sync.js';
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
      callbacks({ records: [candidate] }),
    );
    await serviceB.initialize();
    await serviceA.initialize();

    assert.equal(await serviceA.publishCandidate('auth.json_work'), true);
    assert.deepEqual(imported, {
      candidateName: 'auth.json_work',
      raw: candidate.raw,
      source: 'node-a',
    });
    assert.equal(serviceB.getStatus().lastImportCandidate, 'auth.json_work');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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
    await fs.rm(root, { recursive: true, force: true });
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
    await fs.rm(root, { recursive: true, force: true });
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
    await fs.rm(root, { recursive: true, force: true });
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
    await serviceA.releaseRefreshLease(granted.leaseId);

    peerIdle = false;
    const denied = await serviceA.acquireRefreshLease('test');
    assert.equal(denied.ok, false);
    assert.match(denied.reason ?? '', /not idle/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function callbacks(options: {
  records?: AuthMirrorCandidateRecord[];
  isIdle?: () => boolean;
  validate?: AuthSyncImportCallbacks['validateCandidate'];
  importCandidate?: AuthSyncImportCallbacks['importCandidate'];
}): AuthSyncImportCallbacks {
  const records = options.records ?? [];
  return {
    readLocalCandidate: async (candidateName) => records.find(record => record.candidateName === candidateName) ?? null,
    listLocalCandidates: async () => records,
    validateCandidate: options.validate ?? (async () => ({ ok: true })),
    importCandidate: options.importCandidate ?? (async () => ({ ok: true, imported: true })),
    isIdle: options.isIdle ?? (() => true),
  };
}
