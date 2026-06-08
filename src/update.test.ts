import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelfUpdateLaunchCommand,
  createSelfUpdateRuntime,
  extractReleaseNotes,
  readSelfUpdateStatus,
  resolveCodexUpdateInstaller,
  resolveSelfUpdateInstaller,
  selfUpdateStatusPath,
  writeSelfUpdateStatus,
} from './update.js';

test('extractReleaseNotes reads localized bullets from packaged changelog text', () => {
  const changelog = [
    '# Changelog',
    '',
    '## 0.6.0 - 2026-06-08',
    '',
    '### 中文',
    '- 持久队列',
    '- 附件暂存',
    '',
    '### English',
    '- Persistent queue',
    '- Staged attachments',
    '',
    '## 0.5.9 - 2026-06-07',
    '- Older entry',
  ].join('\n');

  assert.deepEqual(extractReleaseNotes(changelog, '0.6.0', 'zh'), ['持久队列', '附件暂存']);
  assert.deepEqual(extractReleaseNotes(changelog, '0.6.0', 'en'), ['Persistent queue', 'Staged attachments']);
  assert.equal(extractReleaseNotes(changelog, '0.1.0', 'zh'), null);
});

test('resolveSelfUpdateInstaller preserves pnpm-managed global installations', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.13/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/home/user/.nvm/versions/node/v24/bin/node',
    (target) => target === '/home/user/.local/share/pnpm/pnpm',
  );

  assert.equal(installer.manager, 'pnpm');
  assert.equal(installer.command, '/home/user/.local/share/pnpm/pnpm');
  assert.deepEqual(installer.installArgs, ['add', '--global', '@foxden-app/foxclaw@latest']);
});

test('resolveSelfUpdateInstaller finds pnpm beside the Node executable when PNPM_HOME has no binary', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.14/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/home/user/.nvm/versions/node/v24/bin/node',
    (target) => target === '/home/user/.nvm/versions/node/v24/bin/pnpm',
    { PATH: '/usr/bin:/bin' },
  );

  assert.equal(installer.manager, 'pnpm');
  assert.equal(installer.command, '/home/user/.nvm/versions/node/v24/bin/pnpm');
});

test('resolveSelfUpdateInstaller finds pnpm in PNPM_HOME bin layout', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.14/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/opt/node/bin/node',
    (target) => target === '/home/user/.local/share/pnpm/bin/pnpm',
    { PATH: '/usr/bin:/bin' },
  );

  assert.equal(installer.command, '/home/user/.local/share/pnpm/bin/pnpm');
});

test('resolveSelfUpdateInstaller finds pnpm in PATH for a pnpm-managed install', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.14/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/opt/node/bin/node',
    (target) => target === '/home/user/bin/pnpm',
    { PATH: '/home/user/bin:/usr/bin' },
  );

  assert.equal(installer.command, '/home/user/bin/pnpm');
});

test('resolveSelfUpdateInstaller falls back to npm exec when pnpm is not installed', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.14/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/home/user/.nvm/versions/node/v24/bin/node',
    (target) => target === '/home/user/.nvm/versions/node/v24/bin/npm',
    { PATH: '/usr/bin:/bin' },
  );

  assert.equal(installer.manager, 'pnpm');
  assert.equal(installer.command, '/home/user/.nvm/versions/node/v24/bin/npm');
  assert.deepEqual(installer.installArgs, [
    'exec',
    '--yes',
    '--package=pnpm@latest',
    '--',
    'pnpm',
    'add',
    '--global',
    '@foxden-app/foxclaw@latest',
  ]);
});

test('resolveSelfUpdateInstaller uses the npm beside Node for npm installations', () => {
  const installer = resolveSelfUpdateInstaller(
    '/home/user/.nvm/versions/node/v24/lib/node_modules/@foxden-app/foxclaw/dist/main.js',
    '/home/user/.nvm/versions/node/v24/bin/node',
    (target) => target === '/home/user/.nvm/versions/node/v24/bin/npm',
  );

  assert.equal(installer.manager, 'npm');
  assert.equal(installer.command, '/home/user/.nvm/versions/node/v24/bin/npm');
});

test('buildSelfUpdateLaunchCommand uses a transient user systemd service on Linux', () => {
  const launch = buildSelfUpdateLaunchCommand({
    entryPoint: '/opt/foxclaw/dist/main.js',
    nodePath: '/opt/node/bin/node',
    statusFile: '/home/user/.foxclaw/runtime/self-update.json',
    logPath: '/home/user/.foxclaw/logs/update.log',
    codexCliBin: '/home/user/bin/codex',
    env: {
      HOME: '/home/user',
      PATH: '/usr/bin:/bin',
      TG_BOT_TOKEN: 'secret-token',
    },
    platform: 'linux',
    systemdRunPath: '/usr/bin/systemd-run',
    unitName: 'foxclaw-update-test',
  });

  assert.equal(launch.command, '/usr/bin/systemd-run');
  assert.equal(launch.viaSystemdRun, true);
  assert.deepEqual(launch.args.slice(0, 5), [
    '--user',
    '--collect',
    '--unit=foxclaw-update-test',
    '--property=StandardOutput=append:/home/user/.foxclaw/logs/update.log',
    '--property=StandardError=append:/home/user/.foxclaw/logs/update.log',
  ]);
  assert.ok(launch.args.includes('--setenv=CODEX_CLI_BIN=/home/user/bin/codex'));
  assert.ok(launch.args.includes('--setenv=TG_BOT_TOKEN=secret-token'));
  assert.deepEqual(launch.args.slice(-5), [
    '/opt/node/bin/node',
    '/opt/foxclaw/dist/main.js',
    'update',
    '--notification-file',
    '/home/user/.foxclaw/runtime/self-update.json',
  ]);
});

test('buildSelfUpdateLaunchCommand falls back to detached node launch without systemd-run', () => {
  const launch = buildSelfUpdateLaunchCommand({
    entryPoint: '/opt/foxclaw/dist/main.js',
    nodePath: '/opt/node/bin/node',
    statusFile: '/tmp/self-update.json',
    logPath: '/tmp/update.log',
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    systemdRunPath: null,
  });

  assert.equal(launch.command, '/opt/node/bin/node');
  assert.equal(launch.viaSystemdRun, false);
  assert.deepEqual(launch.args, ['/opt/foxclaw/dist/main.js', 'update', '--notification-file', '/tmp/self-update.json']);
});

test('createSelfUpdateRuntime expires stale pending status', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-update-stale-'));
  try {
    const statusPath = path.join(tempDir, 'status.json');
    const statusFile = selfUpdateStatusPath(statusPath);
    writeSelfUpdateStatus(statusFile, {
      state: 'pending',
      scopeId: 'telegram:99::root',
      locale: 'zh',
      fromVersion: '0.5.2',
      toVersion: null,
      error: null,
      updatedAt: '2026-06-04T08:17:33.000Z',
    });
    const runtime = createSelfUpdateRuntime({
      entryPoint: '/opt/foxclaw/dist/main.js',
      nodePath: '/opt/node/bin/node',
      version: '0.5.3',
      statusPath,
      logPath: path.join(tempDir, 'update.log'),
      pendingTimeoutMs: 1_000,
      now: () => new Date('2026-06-04T08:17:35.000Z'),
    });

    const status = await runtime.readStatus();

    assert.equal(status?.state, 'failed');
    assert.match(status?.error ?? '', /self-update timed out/);
    assert.equal(readSelfUpdateStatus(statusFile)?.state, 'failed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveCodexUpdateInstaller upgrades a pnpm-managed Codex package', () => {
  const commandPath = '/home/user/.local/share/pnpm/codex';
  const realPath = '/home/user/.local/share/pnpm/global/5/.pnpm/@openai+codex@1.2.3/node_modules/@openai/codex/bin/codex.js';
  const installer = resolveCodexUpdateInstaller(
    commandPath,
    '/opt/node/bin/node',
    (target) => target === '/home/user/.local/share/pnpm/pnpm',
    { PATH: '/usr/bin' },
    () => realPath,
  );

  assert.equal(installer?.manager, 'pnpm');
  assert.deepEqual(installer?.installArgs, ['add', '--global', '@openai/codex@latest']);
});

test('resolveCodexUpdateInstaller leaves unrecognized Codex installations alone', () => {
  assert.equal(resolveCodexUpdateInstaller(
    '/workspace/bin/codex',
    '/opt/node/bin/node',
    () => false,
    { PATH: '/usr/bin' },
    () => '/workspace/packages/codex/bin/codex.js',
  ), null);
});

test('resolveCodexUpdateInstaller follows pnpm command launchers and FoxClaw wrappers', () => {
  const wrapper = '/home/user/.local/foxclaw/bin/codex-wrapper';
  const shim = '/home/user/.local/share/pnpm/codex';
  const packageEntry = '/home/user/.local/share/pnpm/global/5/.pnpm/@openai+codex@1.2.3/node_modules/@openai/codex/bin/codex.js';
  const files: Record<string, string> = {
    [wrapper]: `#!/bin/sh\nexec "${shim}" "$@"\n`,
    [shim]: `#!/bin/sh\nexec node "${packageEntry}" "$@"\n`,
  };
  const installer = resolveCodexUpdateInstaller(
    wrapper,
    '/opt/node/bin/node',
    (target) => target === '/home/user/.local/share/pnpm/pnpm',
    { PATH: '/usr/bin' },
    (target) => target,
    (target) => files[target] ?? '',
  );

  assert.equal(installer?.manager, 'pnpm');
  assert.deepEqual(installer?.installArgs, ['add', '--global', '@openai/codex@latest']);
});

test('self-update statuses are stored alongside runtime status', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-update-'));
  try {
    const statusFile = selfUpdateStatusPath(path.join(tempDir, 'status.json'));
    writeSelfUpdateStatus(statusFile, {
      state: 'pending',
      scopeId: 'telegram:99::root',
      locale: 'zh',
      fromVersion: '0.3.13',
      toVersion: null,
      releaseNotes: ['one change'],
      releaseNotesVersion: '0.3.13',
      codexFromVersion: '0.135.0',
      codexToVersion: '0.136.0',
      error: null,
      updatedAt: '2026-05-26T08:00:00.000Z',
    });

    assert.deepEqual(readSelfUpdateStatus(statusFile), {
      state: 'pending',
      scopeId: 'telegram:99::root',
      locale: 'zh',
      fromVersion: '0.3.13',
      toVersion: null,
      releaseNotes: ['one change'],
      releaseNotesVersion: '0.3.13',
      codexFromVersion: '0.135.0',
      codexToVersion: '0.136.0',
      error: null,
      updatedAt: '2026-05-26T08:00:00.000Z',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
