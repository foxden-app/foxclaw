import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const projectRoot = process.cwd();

function stripProxychainsNoise(output: string): string {
  return output
    .split('\n')
    .filter(line => !/^\[proxychains\] DLL init: proxychains-ng /.test(line))
    .join('\n');
}

function runFoxclawCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return runFoxclawCliWithEnv({}, ...args);
}

function runFoxclawCliWithEnv(extraEnv: NodeJS.ProcessEnv, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-cli-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        FOXCLAW_ENV: path.join(tempDir, '.env'),
      },
    });
    return {
      status: result.status,
      stdout: stripProxychainsNoise(result.stdout),
      stderr: stripProxychainsNoise(result.stderr),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('CLI version and help commands do not enter serve mode', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string };

  const version = runFoxclawCli('--version');
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), pkg.version);
  assert.equal(version.stderr, '');

  const shortVersion = runFoxclawCli('-v');
  assert.equal(shortVersion.status, 0);
  assert.equal(shortVersion.stdout.trim(), pkg.version);

  const help = runFoxclawCli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /foxclaw status/);
  assert.match(help.stdout, /foxclaw update/);
  assert.equal(help.stderr, '');

  const subcommandHelp = runFoxclawCli('install-systemd', '--help');
  assert.equal(subcommandHelp.status, 0);
  assert.match(subcommandHelp.stdout, /Usage:/);
  assert.doesNotMatch(subcommandHelp.stdout + subcommandHelp.stderr, /Installed /);
});

test('CLI unknown commands show usage instead of starting the bridge', () => {
  const result = runFoxclawCli('--definitely-not-a-command');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: --definitely-not-a-command/);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stderr + result.stdout, /Lock already held/);
});

test('CLI status prints a compact summary by default and keeps --json', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-cli-status-'));
  try {
    const statusPath = path.join(tempDir, 'status.json');
    fs.writeFileSync(statusPath, `${JSON.stringify({
      running: true,
      connected: true,
      userAgent: 'codex-cli-test',
      codexAppServer: { pid: 123, port: 4567, running: true, managed: true },
      botUsername: 'foxclaw_bot',
      currentBindings: 2,
      pendingApprovals: 1,
      pendingUserInputs: 0,
      queuedTurns: 3,
      activeTurns: 1,
      lastError: null,
      updatedAt: new Date().toISOString(),
      bots: [
        { id: 'bot1', username: 'bot_one', connected: true, activeTurns: 1 },
        { id: 'bot2', username: 'bot_two', connected: true, activeTurns: 0 },
      ],
      authSync: {
        enabled: true,
        nodeId: 'node-a',
        transportLabel: '@bot_one',
        peers: ['@botB'],
        pendingImports: 4,
        lastSentAt: null,
        lastReceivedAt: new Date().toISOString(),
        lastImportedAt: null,
        lastImportCandidate: null,
        lastPullAt: null,
        lastPullCandidate: null,
        lastError: null,
        candidateFailures: [],
        activeLeaseId: null,
      },
      lastUpdate: {
        state: 'succeeded',
        scopeId: 'telegram:1::root',
        locale: 'zh',
        fromVersion: '0.5.40',
        toVersion: '0.5.41',
        error: null,
        updatedAt: new Date().toISOString(),
      },
    })}\n`);

    const summary = runFoxclawCliWithEnv({ STATUS_PATH: statusPath }, 'status');
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /FoxClaw status: running, connected/);
    assert.match(summary.stdout, /Work: active 1, queued 3, approvals 1, questions 0/);
    assert.match(summary.stdout, /Auth sync: peers 1, pending imports 4/);
    assert.match(summary.stdout, /Last update: 0\.5\.40 -> 0\.5\.41/);
    assert.doesNotMatch(summary.stdout.trim(), /^\{/);

    const raw = runFoxclawCliWithEnv({ STATUS_PATH: statusPath }, 'status', '--json');
    assert.equal(raw.status, 0);
    assert.equal(JSON.parse(raw.stdout).authSync.pendingImports, 4);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
