import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { callTelegramApi, callTelegramMultipartApi } from './api.js';

test('Telegram requests abort a trickling response at the total deadline, then recover', async (t) => {
  const oldBase = process.env.TELEGRAM_BOT_API_BASE_URL;
  const oldTimeout = process.env.TELEGRAM_BOT_API_TIMEOUT_MS;
  const server = http.createServer((request, response) => {
    if (request.url?.endsWith('/getMe')) {
      response.end(JSON.stringify({ ok: true, result: { id: 1 } }));
      return;
    }
    response.writeHead(200);
    response.write('{');
    const timer = setInterval(() => response.write(' '), 5);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    if (oldBase === undefined) delete process.env.TELEGRAM_BOT_API_BASE_URL;
    else process.env.TELEGRAM_BOT_API_BASE_URL = oldBase;
    if (oldTimeout === undefined) delete process.env.TELEGRAM_BOT_API_TIMEOUT_MS;
    else process.env.TELEGRAM_BOT_API_TIMEOUT_MS = oldTimeout;
  });
  const port = (server.address() as { port: number }).port;
  process.env.TELEGRAM_BOT_API_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TELEGRAM_BOT_API_TIMEOUT_MS = '60';
  await assert.rejects(callTelegramApi('test', 'getUpdates', {}), /abort|timed out/i);
  await assert.rejects(callTelegramMultipartApi('test', 'sendDocument', {}, []), /abort|timed out/i);
  assert.deepEqual(await callTelegramApi('test', 'getMe', {}), { ok: true, result: { id: 1 } });
});
