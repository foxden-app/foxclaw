import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpencodeAppClient, type OpencodeToolProgressEvent } from './client.js';
import { Logger } from '../logger.js';

function makeStatePaths(): { statePath: string; logPath: string; logger: Logger } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-opencode-'));
  return {
    statePath: path.join(dir, 'opencode-server.json'),
    logPath: path.join(dir, 'opencode-serve.log'),
    logger: new Logger('error', path.join(dir, 'foxclaw.log')),
  };
}

test('OpencodeAppClient starts serve and emits connected', async () => {
  const paths = makeStatePaths();
  const app = new OpencodeAppClient("opencode", null, paths.statePath, paths.logPath, paths.logger);
  const connected = new Promise<void>((resolve) => app.on('connected', resolve));
  await app.start();
  await connected;
  const status = app.getServerStatus();
  assert.equal(status.running, true);
  assert.equal(status.connected, true);
  assert.ok(status.port !== null);
  assert.ok(status.url?.startsWith('http://127.0.0.1:'));
  await app.stop({ terminateServer: true });
});

test('OpencodeAppClient persists state and attaches to a running server', async () => {
  const paths = makeStatePaths();
  const app = new OpencodeAppClient("opencode", null, paths.statePath, paths.logPath, paths.logger);
  const firstConnected = new Promise<void>((resolve) => app.on('connected', resolve));
  await app.start();
  await firstConnected;
  const firstPid = app.getServerStatus().pid;
  assert.ok(firstPid !== null);

  const second = new OpencodeAppClient("opencode", null, paths.statePath, paths.logPath, paths.logger);
  const secondConnected = new Promise<void>((resolve) => second.on('connected', resolve));
  await second.start();
  await secondConnected;
  assert.equal(second.getServerStatus().pid, firstPid);
  await second.stop();
  await app.stop({ terminateServer: true });
});

test('OpencodeAppClient emits session events through the SSE stream', async () => {
  const paths = makeStatePaths();
  const app = new OpencodeAppClient("opencode", null, paths.statePath, paths.logPath, paths.logger);
  const connected = new Promise<void>((resolve) => app.on('connected', resolve));
  await app.start();
  await connected;

  const client = app.getClient();
  const created = await client.session.create({ body: { title: 'foxclaw test' } });
  assert.ok(created.data?.id, 'session should be created');

  const toolProgresses: OpencodeToolProgressEvent[] = [];
  app.on('toolProgress', (event: OpencodeToolProgressEvent) => toolProgresses.push(event));

  const result = await client.session.prompt({
    path: { id: created.data.id },
    body: { parts: [{ type: 'text', text: 'Reply with exactly: PONG' }] },
  });
  assert.ok(result.data, 'prompt should return data');
  const textParts = (result.data?.parts ?? []).filter((part) => part.type === 'text');
  assert.ok(textParts.length > 0, 'should contain a text part');
  assert.ok(textParts.some((part) => part.type === 'text' && part.text.includes('PONG')));

  await app.stop({ terminateServer: true });
});
