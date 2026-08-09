import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Logger } from '../logger.js';
import { OpencodeAppClient } from './client.js';

const hasOpencode = spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0;

test('OpenCode client starts an authenticated server and reattaches from protected state', {
  skip: hasOpencode ? false : 'opencode CLI is not installed',
  timeout: 30_000,
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-opencode-'));
  const statePath = path.join(tempDir, 'server.json');
  const logPath = path.join(tempDir, 'server.log');
  const logger = new Logger('error', path.join(tempDir, 'foxclaw.log'));
  const first = new OpencodeAppClient('opencode', null, statePath, logPath, logger);
  let second: OpencodeAppClient | null = null;
  try {
    await first.start();
    const firstStatus = first.getServerStatus();
    assert.equal(firstStatus.connected, true);
    assert.equal(firstStatus.running, true);
    assert.match(firstStatus.url ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);

    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir);
    const created = await first.getClient().session.create({ directory: projectDir, title: 'FoxClaw transport test' });
    assert.equal(created.error, undefined);
    assert.ok(created.data?.id);
    const listed = await first.getClient().experimental.session.list({ search: 'FoxClaw transport test' });
    assert.ok(listed.data?.some((session) => session.id === created.data?.id));

    second = new OpencodeAppClient('opencode', null, statePath, logPath, logger);
    await second.start();
    assert.equal(second.getServerStatus().pid, firstStatus.pid);
    assert.equal(second.getServerStatus().connected, true);
    await second.stop();
    second = null;

    process.kill(-firstStatus.pid!, 'SIGTERM');
    await waitFor(() => {
      const status = first.getServerStatus();
      return status.connected && status.running && status.pid !== firstStatus.pid;
    }, 12_000);
    assert.notEqual(first.getServerStatus().pid, firstStatus.pid);
  } finally {
    await second?.stop().catch(() => {});
    await first.stop({ terminateServer: true });
  }
});

test('OpenCode client reports a missing CLI as a startup error', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-opencode-missing-'));
  const logger = new Logger('error', path.join(tempDir, 'foxclaw.log'));
  const client = new OpencodeAppClient(
    path.join(tempDir, 'not-an-opencode-binary'),
    null,
    path.join(tempDir, 'server.json'),
    path.join(tempDir, 'server.log'),
    logger,
  );
  try {
    await assert.rejects(client.start(), /Failed to start opencode serve/);
    assert.equal(client.getServerStatus().running, false);
  } finally {
    await client.stop({ terminateServer: true });
  }
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}
