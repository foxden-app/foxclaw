import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSelfUpdateVersion,
  performSelfUpdate,
  resolveFoxclawEntryPointFromInstallation,
  buildSelfUpdateLaunchCommand,
  clearPendingClusterUpdateBroadcast,
  createSelfUpdateRuntime,
  extractReleaseNotes,
  inferPnpmFallbackPackageFromEntryPoint,
  readPendingClusterUpdateBroadcast,
  resolveFoxclawEntryPointFromGlobalRoot,
  resolveFoxclawEntryPointFromPnpmHome,
  readSelfUpdateStatus,
  resolveCodexUpdateInstaller,
  resolveSelfUpdateInstaller,
  selfUpdateStatusPath,
  writePendingClusterUpdateBroadcast,
  writeSelfUpdateStatus,
} from './update.js';

test('resolveFoxclawEntryPointFromGlobalRoot supports pnpm 10 and pnpm 11 global roots', () => {
  const pnpm10Root = '/home/user/.local/share/pnpm/global/5/node_modules';
  const pnpm11Root = '/home/user/.local/share/pnpm/global/v11';
  const pnpm10Entry = `${pnpm10Root}/@foxden-app/foxclaw/dist/main.js`;
  const pnpm11Entry = `${pnpm11Root}/node_modules/@foxden-app/foxclaw/dist/main.js`;
  const files = new Set([pnpm10Entry, pnpm11Entry]);

  assert.equal(resolveFoxclawEntryPointFromGlobalRoot(pnpm10Root, target => files.has(target)), pnpm10Entry);
  assert.equal(resolveFoxclawEntryPointFromGlobalRoot(pnpm11Root, target => files.has(target)), pnpm11Entry);
  assert.equal(resolveFoxclawEntryPointFromGlobalRoot('/missing', target => files.has(target)), null);
});

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

test('resolveSelfUpdateInstaller pins pnpm 10 for a legacy global installation', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.13/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/home/user/.nvm/versions/node/v24/bin/node',
    (target) => target === '/home/user/.nvm/versions/node/v24/bin/npm',
  );

  assert.equal(installer.manager, 'pnpm');
  assert.equal(installer.command, '/home/user/.nvm/versions/node/v24/bin/npm');
  assert.deepEqual(installer.installArgs.slice(0, 3), ['exec', '--yes', '--package=pnpm@10']);
});

test('resolveSelfUpdateInstaller does not trust an unversioned pnpm beside Node', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.14/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/home/user/.nvm/versions/node/v24/bin/node',
    (target) => target === '/home/user/.nvm/versions/node/v24/bin/pnpm'
      || target === '/home/user/.nvm/versions/node/v24/bin/npm',
    { PATH: '/usr/bin:/bin' },
  );

  assert.equal(installer.manager, 'pnpm');
  assert.equal(installer.command, '/home/user/.nvm/versions/node/v24/bin/npm');
});

test('resolveSelfUpdateInstaller does not cross layouts through PNPM_HOME bin', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.14/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/opt/node/bin/node',
    (target) => target === '/home/user/.local/share/pnpm/bin/pnpm'
      || target === '/opt/node/bin/npm',
    { PATH: '/usr/bin:/bin' },
  );

  assert.equal(installer.command, '/opt/node/bin/npm');
});

test('resolveSelfUpdateInstaller does not trust an unversioned pnpm in PATH', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.14/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/opt/node/bin/node',
    (target) => target === '/home/user/bin/pnpm' || target === '/opt/node/bin/npm',
    { PATH: '/home/user/bin:/usr/bin' },
  );

  assert.equal(installer.command, '/opt/node/bin/npm');
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
    '--package=pnpm@10',
    '--',
    'pnpm',
    '--config.minimum-release-age=0',
    'add',
    '--global',
    '@foxden-app/foxclaw@latest',
  ]);
});

test('resolveSelfUpdateInstaller preserves the pnpm 11 global layout in its npm exec fallback', () => {
  const entryPoint = '/home/user/.local/share/pnpm/global/v11/node_modules/.pnpm/@foxden-app+foxclaw@0.5.70/node_modules/@foxden-app/foxclaw/dist/main.js';
  const installer = resolveSelfUpdateInstaller(
    entryPoint,
    '/home/user/.nvm/versions/node/v24/bin/node',
    (target) => target === '/home/user/.nvm/versions/node/v24/bin/npm',
    { PATH: '/usr/bin:/bin' },
  );

  assert.deepEqual(installer.installArgs.slice(0, 3), ['exec', '--yes', '--package=pnpm@11']);
  assert.deepEqual(installer.rootArgs.slice(0, 3), ['exec', '--yes', '--package=pnpm@11']);
});

test('inferPnpmFallbackPackageFromEntryPoint keeps known layouts on their pnpm major', () => {
  assert.equal(inferPnpmFallbackPackageFromEntryPoint('/home/user/.local/share/pnpm/global/5/.pnpm/pkg/index.js'), 'pnpm@10');
  assert.equal(inferPnpmFallbackPackageFromEntryPoint('/home/user/.local/share/pnpm/global/v11/node_modules/.pnpm/pkg/index.js'), 'pnpm@11');
  assert.equal(inferPnpmFallbackPackageFromEntryPoint('/opt/foxclaw/dist/main.js'), 'pnpm@latest');
});

test('resolveFoxclawEntryPointFromPnpmHome reads a pnpm 11 isolated package shim', () => {
  const pnpmHome = '/home/user/.local/share/pnpm';
  const rootShim = `${pnpmHome}/foxclaw`;
  const binShim = `${pnpmHome}/bin/foxclaw`;
  const pnpm10Entry = `${pnpmHome}/global/5/.pnpm/foxclaw/node_modules/@foxden-app/foxclaw/dist/main.js`;
  const pnpm11Entry = `${pnpmHome}/global/v11/instance/node_modules/@foxden-app/foxclaw/dist/main.js`;
  const files = new Set([rootShim, binShim, pnpm10Entry, pnpm11Entry]);
  const contents: Record<string, string> = {
    [rootShim]: `#!/bin/sh\n# cmd-shim-target=${pnpm10Entry}\n`,
    [binShim]: `#!/bin/sh\n# cmd-shim-target=${pnpm11Entry}\n`,
  };

  assert.equal(resolveFoxclawEntryPointFromPnpmHome(
    pnpmHome,
    true,
    target => files.has(target),
    target => contents[target] ?? '',
  ), pnpm11Entry);
  assert.equal(resolveFoxclawEntryPointFromPnpmHome(
    pnpmHome,
    false,
    target => files.has(target),
    target => contents[target] ?? '',
  ), pnpm10Entry);
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
    agyCliBin: '/home/user/.local/bin/agy',
    env: {
      HOME: '/home/user',
      PATH: '/usr/bin:/bin',
      CODEX_BOT_TOKENS: 'secret-token',
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
  assert.ok(launch.args.includes('--setenv=AGY_CLI_BIN=/home/user/.local/bin/agy'));
  assert.ok(launch.args.includes('--setenv=CODEX_BOT_TOKENS=secret-token'));
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
  assert.equal(installer?.installArgs.at(-1), '@openai/codex@latest');
  assert.ok(installer?.installArgs.includes('--package=pnpm@10'));
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
  assert.equal(installer?.installArgs.at(-1), '@openai/codex@latest');
  assert.ok(installer?.installArgs.includes('--package=pnpm@10'));
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

test('pending cluster update broadcasts are stored atomically', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-update-broadcast-'));
  try {
    const filePath = path.join(tempDir, 'pending.json');
    writePendingClusterUpdateBroadcast(filePath, {
      targetVersion: '0.5.42',
      fromVersion: '0.5.41',
      updatedAt: '2026-06-18T03:00:00.000Z',
    });

    assert.deepEqual(readPendingClusterUpdateBroadcast(filePath), {
      targetVersion: '0.5.42',
      fromVersion: '0.5.41',
      updatedAt: '2026-06-18T03:00:00.000Z',
    });

    clearPendingClusterUpdateBroadcast(filePath);
    assert.equal(readPendingClusterUpdateBroadcast(filePath), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('installation root wins over a stale pnpm 11 shim when pnpm 10 uses a relative launcher', () => {
  const home = '/home/user/.local/share/pnpm';
  const root = `${home}/global/5/node_modules`;
  const current = `${root}/@foxden-app/foxclaw/dist/main.js`;
  const stale = `${home}/global/v11/old/node_modules/@foxden-app/foxclaw/dist/main.js`;
  const files = new Set([current, stale, `${home}/foxclaw`, `${home}/bin/foxclaw`]);
  const shims: Record<string, string> = {
    [`${home}/foxclaw`]: '#!/bin/sh\nexec node "$basedir/global/5/node_modules/@foxden-app/foxclaw/dist/main.js" "$@"\n',
    [`${home}/bin/foxclaw`]: `#!/bin/sh\n# cmd-shim-target=${stale}\n`,
  };
  const exists = (target: string) => files.has(target);
  const read = (target: string) => shims[target] ?? '';

  // Reproduce the previous shim-first selection, including pnpm 10's real relative launcher.
  assert.equal(resolveFoxclawEntryPointFromPnpmHome(home, false, exists, read), stale);
  assert.equal(resolveFoxclawEntryPointFromInstallation(root, home, exists, read), current);
  files.delete(current);
  assert.equal(resolveFoxclawEntryPointFromInstallation(root, home, exists, read), null);
});

test('pnpm 11 isolated shim fallback stays inside the installer-owned global root', () => {
  const home = '/home/user/.local/share/pnpm';
  const root = `${home}/global/v11`;
  const current = `${root}/instance/node_modules/@foxden-app/foxclaw/dist/main.js`;
  const stale = `${home}/global/5/.pnpm/old/node_modules/@foxden-app/foxclaw/dist/main.js`;
  const files = new Set([current, stale, `${home}/foxclaw`, `${home}/bin/foxclaw`]);
  const shims: Record<string, string> = {
    [`${home}/foxclaw`]: `#!/bin/sh\n# cmd-shim-target=${stale}\n`,
    [`${home}/bin/foxclaw`]: `#!/bin/sh\n# cmd-shim-target=${current}\n`,
  };
  const exists = (target: string) => files.has(target);
  const read = (target: string) => shims[target] ?? '';
  assert.equal(resolveFoxclawEntryPointFromInstallation(root, home, exists, read), current);
  files.delete(current);
  assert.equal(resolveFoxclawEntryPointFromInstallation(root, home, exists, read), null);
});

test('self-update version checks use semantic ordering and require the exact requested version', () => {
  assert.doesNotThrow(() => assertSelfUpdateVersion('0.9.0', '0.10.0'));
  assert.doesNotThrow(() => assertSelfUpdateVersion('0.13.0', '0.13.0', '0.13.0'));
  assert.doesNotThrow(() => assertSelfUpdateVersion('0.13.1-rc.1', '0.13.1'));
  assert.throws(() => assertSelfUpdateVersion('0.13.0', '0.11.1'), /downgrade/);
  assert.throws(() => assertSelfUpdateVersion('0.13.1', '0.13.1-rc.1'), /downgrade/);
  assert.throws(() => assertSelfUpdateVersion('unknown', '0.13.1'), /Cannot verify/);
  assert.throws(() => assertSelfUpdateVersion('0.13.0', 'unknown'), /Cannot verify/);
  assert.throws(() => assertSelfUpdateVersion('0.13.0', '0.14.0', '0.13.1'), /does not match/);
});

function updateFixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-update-safety-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const notificationFile = path.join(directory, 'self-update.json');
  const clusterBroadcastFile = path.join(directory, 'broadcast.json');
  writeSelfUpdateStatus(notificationFile, {
    state: 'pending', scopeId: 'telegram:99::root', locale: 'zh', fromVersion: '0.13.0',
    toVersion: null, error: null, updatedAt: new Date().toISOString(),
  });
  const calls: { command: string; args: string[] }[] = [];
  const cliUpdates: string[] = [];
  const entry = path.join(directory, 'installed', 'dist', 'main.js');
  const overrides = {
    latestVersion: () => '0.13.1',
    run: (command: string, args: string[]) => { calls.push({ command, args }); },
    entryPoint: () => entry,
    readVersion: () => '0.13.1',
    updateCodex: () => { cliUpdates.push('codex'); return { message: 'Codex checked', fromVersion: '1.0.0', toVersion: '1.0.0' }; },
    updateAgy: () => { cliUpdates.push('agy'); return { message: 'AGY checked', fromVersion: '1.0.0', toVersion: '1.0.0' }; },
  };
  const options = {
    entryPoint: path.join(directory, 'lib', 'node_modules', '@foxden-app', 'foxclaw', 'dist', 'main.js'),
    nodePath: process.execPath, version: '0.13.0', notificationFile, clusterBroadcastFile,
    env: { PATH: path.dirname(process.execPath) },
  };
  return { directory, options, overrides, calls, cliUpdates, entry };
}

test('a registry downgrade fails before changing packages, CLIs or the running service', t => {
  const fixture = updateFixture(t);
  const outcome = performSelfUpdate(fixture.options, { ...fixture.overrides, latestVersion: () => '0.11.1' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /downgrade/);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.cliUpdates, []);
  assert.equal(readSelfUpdateStatus(fixture.options.notificationFile)?.state, 'failed');
  assert.equal(readPendingClusterUpdateBroadcast(fixture.options.clusterBroadcastFile), null);
});

for (const installed of ['0.11.1', '0.14.0', 'unknown']) {
  test(`an installed version of ${installed} cannot restart or report update success`, t => {
    const fixture = updateFixture(t);
    const outcome = performSelfUpdate(fixture.options, { ...fixture.overrides, readVersion: () => installed });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.toVersion, installed);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.cliUpdates, []);
    const status = readSelfUpdateStatus(fixture.options.notificationFile);
    assert.equal(status?.state, 'failed');
    assert.ok(status?.error);
    assert.equal(readPendingClusterUpdateBroadcast(fixture.options.clusterBroadcastFile), null);
  });
}

test('self-update installs a pinned target and reports success only after restarting that entry', t => {
  const fixture = updateFixture(t);
  const outcome = performSelfUpdate(fixture.options, fixture.overrides);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.toVersion, '0.13.1');
  assert.ok(fixture.calls[0]!.args.includes('@foxden-app/foxclaw@0.13.1'));
  assert.ok(fixture.calls[0]!.args.includes('--registry=https://registry.npmjs.org'));
  assert.ok(!fixture.calls[0]!.args.includes('@foxden-app/foxclaw@latest'));
  assert.deepEqual(fixture.calls[1], { command: process.execPath, args: [fixture.entry, 'start'] });
  assert.deepEqual(fixture.cliUpdates, ['codex', 'agy']);
  const status = readSelfUpdateStatus(fixture.options.notificationFile);
  assert.equal(status?.state, 'succeeded');
  assert.equal(status?.agyUpdate, 'AGY checked');
  assert.equal(status?.agyFromVersion, '1.0.0');
  assert.equal(status?.agyToVersion, '1.0.0');
  assert.equal(readPendingClusterUpdateBroadcast(fixture.options.clusterBroadcastFile)?.targetVersion, '0.13.1');
});

test('a service restart failure records failure without publishing a success broadcast', t => {
  const fixture = updateFixture(t);
  const outcome = performSelfUpdate(fixture.options, { ...fixture.overrides, run: (command, args) => {
    fixture.overrides.run(command, args);
    if (args.includes('start')) throw new Error('restart failed');
  } });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /restart failed/);
  assert.equal(readSelfUpdateStatus(fixture.options.notificationFile)?.state, 'failed');
  assert.equal(readPendingClusterUpdateBroadcast(fixture.options.clusterBroadcastFile), null);
});

test('real subprocess update resolves pnpm 10 root despite a stale pnpm 11 launcher', { skip: process.platform === 'win32' }, t => {
  const fixture = updateFixture(t);
  const home = path.join(fixture.directory, 'pnpm');
  const globalRoot = path.join(home, 'global', '5', 'node_modules');
  const entry = path.join(globalRoot, '@foxden-app', 'foxclaw', 'dist', 'main.js');
  const stale = path.join(home, 'global', 'v11', 'old', 'node_modules', '@foxden-app', 'foxclaw', 'dist', 'main.js');
  const bin = path.join(fixture.directory, 'bin');
  const history = path.join(fixture.directory, 'commands.jsonl');
  const started = path.join(fixture.directory, 'started.json');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, 'throw new Error("stale pnpm 11 entry must never run");');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'foxclaw'), '#!/bin/sh\nexec node "$basedir/global/5/node_modules/@foxden-app/foxclaw/dist/main.js" "$@"\n');
  fs.writeFileSync(path.join(home, 'bin', 'foxclaw'), `#!/bin/sh\n# cmd-shim-target=${stale}\n`);
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const restartScript = 'import fs from "node:fs"; fs.writeFileSync(process.env.FIXTURE_STARTED, JSON.stringify(process.argv));';
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_HISTORY, JSON.stringify(args) + '\\n');
if (args[0] === 'view') { console.log(JSON.stringify('0.13.1')); }
else if (args[0] === 'exec' && args.includes('add')) {
  if (!args.includes('@foxden-app/foxclaw@0.13.1')) process.exit(9);
  const entry = process.env.FIXTURE_ENTRY;
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.resolve(path.dirname(entry), '../package.json'), JSON.stringify({ version: '0.13.1', type: 'module' }));
  fs.writeFileSync(entry, ${JSON.stringify(restartScript)});
}
else if (args[0] === 'exec' && args.includes('root')) { console.log(process.env.FIXTURE_ROOT); }
else { process.exit(8); }
`, { mode: 0o755 });
  const outcome = performSelfUpdate({
    ...fixture.options,
    entryPoint: path.join(home, 'global', '5', '.pnpm', 'old', 'node_modules', '@foxden-app', 'foxclaw', 'dist', 'main.js'),
    nodePath: path.join(bin, 'node'),
    env: { PATH: `${bin}:${process.env.PATH}`, FIXTURE_HISTORY: history, FIXTURE_ROOT: globalRoot,
      FIXTURE_ENTRY: entry, FIXTURE_STARTED: started },
  }, { updateCodex: fixture.overrides.updateCodex, updateAgy: fixture.overrides.updateAgy });
  assert.equal(outcome.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(started, 'utf8')).slice(1), [entry, 'start']);
  const commands: string[][] = fs.readFileSync(history, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(commands.length, 3);
  assert.equal(commands[0]![0], 'view');
  assert.ok(commands[0]!.includes('--prefer-online'));
  assert.ok(commands[0]!.includes('--registry=https://registry.npmjs.org'));
  assert.ok(commands[1]!.includes('--package=pnpm@10'));
  assert.ok(commands[1]!.includes('@foxden-app/foxclaw@0.13.1'));
  assert.ok(commands[2]!.includes('root'));
  assert.equal(readSelfUpdateStatus(fixture.options.notificationFile)?.toVersion, '0.13.1');
});


test('an unchanged FoxClaw version still allows the configured CLI updates', t => {
  const fixture = updateFixture(t);
  const outcome = performSelfUpdate(fixture.options, {
    ...fixture.overrides, latestVersion: () => '0.13.0', readVersion: () => '0.13.0',
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(fixture.cliUpdates, ['codex', 'agy']);
  assert.equal(fixture.calls.length, 2);
});

test('registry lookup failure leaves packages and service untouched', t => {
  const fixture = updateFixture(t);
  const outcome = performSelfUpdate(fixture.options, {
    ...fixture.overrides, latestVersion: () => { throw new Error('registry unavailable'); },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /registry unavailable/);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.cliUpdates, []);
  assert.equal(readSelfUpdateStatus(fixture.options.notificationFile)?.state, 'failed');
  assert.equal(readPendingClusterUpdateBroadcast(fixture.options.clusterBroadcastFile), null);
});
