import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { externalWriterControl } from './force_takeover.js';

test('Linux force takeover uses real flock/pidfd and refuses unsafe owners', { skip: process.platform !== 'linux' }, async () => {
  const { stderr } = await promisify(execFile)('python3', ['-B', fileURLToPath(new URL('../../scripts/force-takeover.test.py', import.meta.url))], { timeout: 20_000 });
  assert.match(stderr, /Ran 8 tests/);
  assert.match(stderr, /OK/);
});

test('force takeover inspection fails explicitly for invalid thread IDs', { skip: process.platform !== 'linux' }, async () => {
  await assert.rejects(externalWriterControl.inspect('/tmp', '../invalid'), /Invalid thread ID/);
});
