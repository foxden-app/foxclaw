import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DshCredentials } from './credentials.js';
import { apply } from './credentials_plugin.js';
import { Logger } from '../logger.js';
import { fakeDsh } from './test_support.js';

test('credential shutdown cancels and joins native control without retaining its input files', async () => {
  const fixture = await fakeDsh();
  const credentials = new DshCredentials(fixture.options, new Logger('error', path.join(fixture.root, 'credentials.log')));
  try {
    const check = credentials.describe();
    const rejection = assert.rejects(check, /credential operation failed/);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(credentials.pendingOperations, 1);
    await credentials.stop();
    await rejection;
    assert.equal(credentials.pendingOperations, 0);
    await assert.rejects(credentials.describe(), /stopped/);
  } finally { await credentials.stop(); await fixture.cleanup(); }
});

test('native credential failures delete the handoff and never return raw key diagnostics', async () => {
  const fixture = await fakeDsh();
  const requestPath = path.join(fixture.root, 'request.json');
  const resultPath = path.join(fixture.root, 'result.json');
  const key = 'sk-sensitive-native-error';
  try {
    await fs.writeFile(requestPath, JSON.stringify({ operation: 'set', value: key }), { mode: 0o600 });
    await apply({ credentials: { set: async () => { throw new Error(`Provider rejected ${key}`); }, describe: async () => ({ configured: false, writable: false }) } }, { requestPath, resultPath });
    await assert.rejects(fs.access(requestPath));
    const result = await fs.readFile(resultPath, 'utf8');
    assert.doesNotMatch(result, /sk-sensitive-native-error/);
    assert.equal(JSON.parse(result).ok, false);
    if (process.platform !== 'win32') assert.equal((await fs.stat(resultPath)).mode & 0o777, 0o600);
  } finally { await fixture.cleanup(); }
});
