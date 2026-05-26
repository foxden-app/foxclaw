import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readSelfUpdateStatus,
  resolveSelfUpdateInstaller,
  selfUpdateStatusPath,
  writeSelfUpdateStatus,
} from './update.js';

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
      error: null,
      updatedAt: '2026-05-26T08:00:00.000Z',
    });

    assert.deepEqual(readSelfUpdateStatus(statusFile), {
      state: 'pending',
      scopeId: 'telegram:99::root',
      locale: 'zh',
      fromVersion: '0.3.13',
      toVersion: null,
      error: null,
      updatedAt: '2026-05-26T08:00:00.000Z',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
