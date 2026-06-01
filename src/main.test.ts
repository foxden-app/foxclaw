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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-cli-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
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
});

test('CLI unknown commands show usage instead of starting the bridge', () => {
  const result = runFoxclawCli('--definitely-not-a-command');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: --definitely-not-a-command/);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stderr + result.stdout, /Lock already held/);
});
