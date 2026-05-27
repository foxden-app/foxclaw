import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCodexAppServerArgs } from './client.js';

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
