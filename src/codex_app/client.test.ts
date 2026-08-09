import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { buildCodexAppServerArgs, terminateManagedProcessGroup } from './client.js';

test('buildCodexAppServerArgs applies isolated auth storage override before listen address', () => {
  assert.deepEqual(
    buildCodexAppServerArgs(4242, ['cli_auth_credentials_store="file"']),
    ['app-server', '-c', 'cli_auth_credentials_store="file"', '--listen', 'ws://127.0.0.1:4242'],
  );
});

test('buildCodexAppServerArgs preserves the default app-server launch shape', () => {
  assert.deepEqual(
    buildCodexAppServerArgs(4242),
    ['app-server', '--listen', 'ws://127.0.0.1:4242'],
  );
});

test('terminateManagedProcessGroup force-kills a detached process tree that ignores SIGTERM', {
  skip: process.platform === 'win32',
}, async (t) => {
  const child = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process');",
    "process.on('SIGTERM', () => {});",
    "const nested = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
    'console.log(nested.pid);',
    'setInterval(() => {}, 1000);',
  ].join(' ')], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.ok(child.pid);
  t.after(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // The assertion path already terminated the process group.
    }
  });
  const nestedPid = await readFirstPid(child);

  const result = await terminateManagedProcessGroup(child.pid, 100, 3000);

  assert.equal(result, 'killed');
  await assertProcessExited(child.pid);
  await assertProcessExited(nestedPid);
});

async function readFirstPid(child: ReturnType<typeof spawn>): Promise<number> {
  const stdout = child.stdout;
  assert.ok(stdout);
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for nested process pid')), 3000);
    stdout.once('data', (chunk) => {
      clearTimeout(timer);
      const pid = Number.parseInt(String(chunk).trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        reject(new Error(`invalid nested process pid: ${String(chunk)}`));
        return;
      }
      resolve(pid);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function assertProcessExited(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`process ${pid} is still alive`);
}
