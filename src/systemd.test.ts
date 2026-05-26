import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshFoxclawExecStartDropIns,
  refreshFoxclawExecStartText,
  removeFoxclawExecStartDropIns,
  removeFoxclawExecStartText,
} from './systemd.js';

test('refreshFoxclawExecStartText updates proxychains drop-in ExecStart', () => {
  const before = [
    '[Service]',
    'ExecStart=',
    'ExecStart=/usr/bin/proxychains4 -f /home/wuya/.proxychains-rt.conf /home/wuya/.nvm/versions/node/v24.12.0/bin/node /home/wuya/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.8/node_modules/@foxden-app/foxclaw/dist/main.js serve',
    '',
  ].join('\n');

  const result = refreshFoxclawExecStartText(before, '/home/wuya/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.11/node_modules/@foxden-app/foxclaw/dist/main.js');

  assert.equal(result.replacements, 1);
  assert.doesNotMatch(result.text, /@foxden-app\+foxclaw@0\.3\.8/);
  assert.match(result.text, /proxychains4 -f \/home\/wuya\/\.proxychains-rt\.conf/);
  assert.match(result.text, /@foxden-app\+foxclaw@0\.3\.11/);
});

test('refreshFoxclawExecStartText leaves unrelated ExecStart alone', () => {
  const before = [
    '[Service]',
    'ExecStart=',
    'ExecStart=/usr/bin/env bash -lc "echo ok"',
    '',
  ].join('\n');

  const result = refreshFoxclawExecStartText(before, '/new/foxclaw/dist/main.js');

  assert.equal(result.replacements, 0);
  assert.equal(result.text, before);
});

test('refreshFoxclawExecStartDropIns updates matching drop-in files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-systemd-'));
  try {
    const dropInDir = path.join(tempDir, 'foxclaw.service.d');
    fs.mkdirSync(dropInDir, { recursive: true });
    const dropInPath = path.join(dropInDir, '10-proxy.conf');
    fs.writeFileSync(
      dropInPath,
      [
        '[Service]',
        'ExecStart=',
        'ExecStart=/usr/bin/node /home/wuya/.local/share/pnpm/global/5/node_modules/@foxden-app/foxclaw/dist/main.js serve',
        '',
      ].join('\n'),
      'utf8',
    );

    const updates = refreshFoxclawExecStartDropIns(tempDir, 'foxclaw.service', '/new/foxclaw/dist/main.js');

    assert.deepEqual(updates, [{ path: dropInPath, replacements: 1 }]);
    assert.match(fs.readFileSync(dropInPath, 'utf8'), /ExecStart=\/usr\/bin\/node \/new\/foxclaw\/dist\/main\.js serve/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('removeFoxclawExecStartText removes only FoxClaw ExecStart overrides', () => {
  const before = [
    '[Service]',
    'Environment=EXAMPLE=1',
    'ExecStart=',
    'ExecStart=/usr/bin/proxychains4 -f /home/wuya/.proxychains-rt.conf /home/wuya/.nvm/versions/node/v24.12.0/bin/node /home/wuya/.local/share/pnpm/global/5/.pnpm/@foxden-app+foxclaw@0.3.8/node_modules/@foxden-app/foxclaw/dist/main.js serve',
    '',
  ].join('\n');

  const result = removeFoxclawExecStartText(before);

  assert.equal(result.replacements, 2);
  assert.match(result.text, /Environment=EXAMPLE=1/);
  assert.doesNotMatch(result.text, /ExecStart=/);
});

test('removeFoxclawExecStartText leaves non-FoxClaw drop-ins alone', () => {
  const before = [
    '[Service]',
    'ExecStart=',
    'ExecStart=/usr/bin/env bash -lc "echo ok"',
    '',
  ].join('\n');

  const result = removeFoxclawExecStartText(before);

  assert.equal(result.replacements, 0);
  assert.equal(result.text, before);
});

test('removeFoxclawExecStartDropIns deletes empty FoxClaw override drop-ins', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-systemd-'));
  try {
    const dropInDir = path.join(tempDir, 'foxclaw.service.d');
    fs.mkdirSync(dropInDir, { recursive: true });
    const dropInPath = path.join(dropInDir, '10-proxy.conf');
    fs.writeFileSync(
      dropInPath,
      [
        '[Service]',
        'ExecStart=',
        'ExecStart=/usr/bin/node /home/wuya/.local/share/pnpm/global/5/node_modules/@foxden-app/foxclaw/dist/main.js serve',
        '',
      ].join('\n'),
      'utf8',
    );

    const updates = removeFoxclawExecStartDropIns(tempDir, 'foxclaw.service');

    assert.deepEqual(updates, [{ path: dropInPath, replacements: 2 }]);
    assert.equal(fs.existsSync(dropInPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
