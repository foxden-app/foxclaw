import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DshClient } from './client.js';
import { Logger } from '../logger.js';
import { fakeDsh } from './test_support.js';

test('DSH startup errors settle and teardown does not wait for a nonexistent process', async () => {
  const fixture = await fakeDsh();
  const client = new DshClient({ ...fixture.options, cliBin: path.join(fixture.root, 'does-not-exist') }, 'missing', new Logger('error', path.join(fixture.root, 'test.log')));
  try { await assert.rejects(client.start(), /Cannot start DSH/); await client.stop(); }
  finally { await client.stop(); await fixture.cleanup(); }
});

test('DSH handshake timeout reaps the child and allows retry', async () => {
  const fixture = await fakeDsh();
  const stalled = path.join(fixture.root, 'stalled.mjs');
  await fs.writeFile(stalled, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));');
  const client = new DshClient({ ...fixture.options, cliBin: stalled, startupTimeoutMs: 50 }, 'timeout', new Logger('error', path.join(fixture.root, 'test.log')));
  try {
    await assert.rejects(client.start(), /timed out/);
    await assert.rejects(client.start(), /timed out/);
    assert.equal(client.connected, false);
  } finally { await client.stop(); await fixture.cleanup(); }
});
