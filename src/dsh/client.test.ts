import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DshClient } from './client.js';
import { Logger } from '../logger.js';
import { fakeDsh } from './test_support.js';

test('DSH launch isolates service dotenv while retaining inherited proxy and session workspace', async () => {
  const fixture = await fakeDsh();
  const serviceDir = path.join(fixture.root, 'service');
  const wrapper = path.join(fixture.root, 'checked.mjs');
  await fs.mkdir(serviceDir);
  await fs.writeFile(path.join(serviceDir, '.env'), 'ALL_PROXY=http://service-only.invalid:1080\n');
  await fs.writeFile(wrapper, `import fs from 'node:fs';
    import assert from 'node:assert/strict';
    assert.equal(fs.existsSync('.env'), false, 'service dotenv must not be loaded');
    assert.equal(process.env.ALL_PROXY, 'http://inherited.invalid:1080');
    await import(${JSON.stringify(pathToFileURL(fixture.options.cliBin).href)});`);
  const script = `import { DshClient } from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
    import { Logger } from ${JSON.stringify(new URL('../logger.ts', import.meta.url).href)};
    const client = new DshClient(${JSON.stringify({ ...fixture.options, cliBin: wrapper })}, 'isolated', new Logger('error', ${JSON.stringify(path.join(fixture.root, 'test.log'))}));
    try { await client.session(${JSON.stringify(serviceDir)}); } finally { await client.stop(); }`;
  try {
    const tsx = createRequire(import.meta.url).resolve('tsx/esm');
    await promisify(execFile)(process.execPath, ['--import', pathToFileURL(tsx).href, '--input-type=module', '-e', script], {
      cwd: serviceDir, env: { ...process.env, ALL_PROXY: 'http://inherited.invalid:1080' }, timeout: 10000,
    });
    const sessions = JSON.parse(await fs.readFile(path.join(fixture.root, 'sessions.json'), 'utf8')) as Record<string, { cwd: string }>;
    assert.equal(Object.values(sessions)[0]?.cwd, serviceDir);
  } finally { await fixture.cleanup(); }
});

test('DSH startup errors settle and teardown does not wait for a nonexistent process', async () => {
  const fixture = await fakeDsh();
  const client = new DshClient({ ...fixture.options, cliBin: path.join(fixture.root, 'does-not-exist') }, 'missing', new Logger('error', path.join(fixture.root, 'test.log')));
  try { await assert.rejects(client.start(), /Cannot start DSH/); await client.stop(); }
  finally { await client.stop(); await fixture.cleanup(); }
});

test('DSH handshake timeout reaps the child and allows retry', async () => {
  const fixture = await fakeDsh();
  const stalled = path.join(fixture.root, 'stalled.mjs');
  await fs.writeFile(stalled, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));');
  const client = new DshClient({ ...fixture.options, cliBin: stalled, startupTimeoutMs: 50 }, 'timeout', new Logger('error', path.join(fixture.root, 'test.log')));
  try {
    await assert.rejects(client.start(), /timed out/);
    await assert.rejects(client.start(), /timed out/);
    assert.equal(client.connected, false);
  } finally { await client.stop(); await fixture.cleanup(); }
});
