import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTelegramBotId, TelegramGateway, type TelegramTextEvent } from './gateway.js';

const storeStub = {
  getTelegramOffset(): number {
    return 0;
  },
  setTelegramOffset(): void {},
  rememberTelegramPrivateScope(): void {},
};

const loggerStub = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

test('parseTelegramBotId resolves standard Telegram token prefixes', () => {
  assert.equal(parseTelegramBotId('1234567890:secret'), 1234567890);
  assert.equal(parseTelegramBotId('token'), null);
  assert.equal(parseTelegramBotId('0:secret'), null);
});

test('TelegramGateway starts offline and keeps a stable token-derived identity', async () => {
  const gateway = new TelegramGateway('1234567890:secret', '42', null, 1000, storeStub as any, loggerStub as any, true);
  let attempts = 0;
  (gateway as any).resolveBotIdentity = async (): Promise<void> => {
    attempts += 1;
    throw new Error('network unavailable');
  };

  assert.equal(await gateway.initializeIdentity(), 'bot1234567890');
  await gateway.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  gateway.stop();

  assert.equal(gateway.identity, 'bot1234567890');
  assert.equal((gateway as any).botKey, 'telegram:bot1234567890');
  assert.equal(attempts, 1);
});

test('TelegramGateway reports when remote initialization recovers', async () => {
  const gateway = new TelegramGateway('1234567890:secret', '42', null, 1000, storeStub as any, loggerStub as any, true);
  (gateway as any).resolveBotIdentity = async (): Promise<void> => {
    (gateway as any).botUsername = 'example_bot';
  };
  (gateway as any).registerCommands = async (): Promise<void> => {};
  const ready = new Promise<void>((resolve) => {
    gateway.once('remoteReady', () => {
      gateway.stop();
      resolve();
    });
  });

  await gateway.start();
  await ready;

  assert.equal(gateway.username, 'example_bot');
});

test('TelegramGateway resolves a verified username and tolerates offline name lookup', async () => {
  const gateway = new TelegramGateway('1234567890:secret', '42', null, 1000, storeStub as any, loggerStub as any);
  (gateway as any).resolveBotIdentity = async () => { (gateway as any).botUsername = 'Example_Bot'; };
  assert.equal(await gateway.resolveUsername(), 'Example_Bot');
  assert.equal(gateway.identity, 'bot1234567890');
  (gateway as any).resolveBotIdentity = async () => { throw new Error('offline'); };
  assert.equal(await gateway.resolveUsername(), null);
  assert.equal(gateway.identity, 'bot1234567890');
});

test('TelegramGateway emits media messages with caption and attachments', async () => {
  const gateway = new TelegramGateway('token', '42', null, 1000, storeStub as any, loggerStub as any);
  const events: TelegramTextEvent[] = [];
  gateway.on('text', (event: TelegramTextEvent) => {
    events.push(event);
  });

  await (gateway as any).handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: 99, type: 'private' },
      from: { id: 42, language_code: 'zh-CN' },
      caption: '看看这张图',
      photo: [
        { file_id: 'small', file_unique_id: 'unique-small', width: 90, height: 90, file_size: 1_000 },
        { file_id: 'large', file_unique_id: 'unique-large', width: 1280, height: 720, file_size: 2_000 },
      ],
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.text, '看看这张图');
  assert.equal(events[0]?.attachments.length, 1);
  assert.equal(events[0]?.scopeId, 'telegram:99::root');
  assert.equal(events[0]?.topicId, null);
  assert.equal(events[0]?.replyToBot, false);
  assert.deepEqual(events[0]?.attachments[0], {
    kind: 'photo',
    fileId: 'large',
    fileUniqueId: 'unique-large',
    fileName: null,
    mimeType: 'image/jpeg',
    fileSize: 2_000,
    width: 1280,
    height: 720,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
  });
  assert.equal(events[0]?.languageCode, 'zh-CN');
});

test('TelegramGateway emits document-only messages with empty text', async () => {
  const gateway = new TelegramGateway('token', '42', null, 1000, storeStub as any, loggerStub as any);
  const events: TelegramTextEvent[] = [];
  gateway.on('text', (event: TelegramTextEvent) => {
    events.push(event);
  });

  await (gateway as any).handleUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      chat: { id: 99, type: 'private' },
      from: { id: 42 },
      document: {
        file_id: 'doc-file',
        file_unique_id: 'doc-unique',
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
        file_size: 3_000,
      },
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.text, '');
  assert.equal(events[0]?.attachments.length, 1);
  assert.equal(events[0]?.attachments[0]?.kind, 'document');
  assert.equal(events[0]?.attachments[0]?.fileName, 'report.pdf');
});

test('TelegramGateway emits topic messages for the configured group chat', async () => {
  const gateway = new TelegramGateway('token', '42', '-100123', 1000, storeStub as any, loggerStub as any);
  const events: TelegramTextEvent[] = [];
  gateway.on('text', (event: TelegramTextEvent) => {
    events.push(event);
  });
  (gateway as any).botUserId = 777;

  await (gateway as any).handleUpdate({
    update_id: 3,
    message: {
      message_id: 12,
      message_thread_id: 8,
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 42 },
      text: '@bot1 看下状态',
      entities: [{ type: 'mention', offset: 0, length: 5 }],
      reply_to_message: {
        message_id: 7,
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 777 },
        text: 'previous reply',
      },
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.scopeId, 'telegram:-100123::8');
  assert.equal(events[0]?.chatType, 'supergroup');
  assert.equal(events[0]?.topicId, 8);
  assert.equal(events[0]?.replyToBot, true);
  assert.deepEqual(events[0]?.entities, [{ type: 'mention', offset: 0, length: 5 }]);
});

test('TelegramGateway still emits private chat messages when a group chat is configured', async () => {
  const gateway = new TelegramGateway('token', '42', '-100123', 1000, storeStub as any, loggerStub as any);
  const events: TelegramTextEvent[] = [];
  gateway.on('text', (event: TelegramTextEvent) => {
    events.push(event);
  });

  await (gateway as any).handleUpdate({
    update_id: 4,
    message: {
      message_id: 13,
      chat: { id: 99, type: 'private' },
      from: { id: 42 },
      text: '/help',
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.scopeId, 'telegram:99::root');
  assert.equal(events[0]?.chatType, 'private');
  assert.equal(events[0]?.topicId, null);
});

test('TelegramGateway namespaces scopes by bot identity in multi-bot mode', async () => {
  const gateway = new TelegramGateway('token', '42', null, 1000, storeStub as any, loggerStub as any, true);
  (gateway as any).botUserId = 777;
  const events: TelegramTextEvent[] = [];
  gateway.on('text', (event: TelegramTextEvent) => events.push(event));

  await (gateway as any).handleUpdate({
    update_id: 5,
    message: {
      message_id: 14,
      chat: { id: 99, type: 'private' },
      from: { id: 42 },
      text: '/status',
    },
  });

  assert.equal(events[0]?.scopeId, 'telegram:bot777:99::root');
});


test('stopping Telegram polling aborts an outstanding request before store shutdown', async (t) => {
  const previousBase = process.env.TELEGRAM_BOT_API_BASE_URL;
  let enter!: () => void;
  const polling = new Promise<void>(resolve => { enter = resolve; });
  let pending: http.ServerResponse | null = null;
  const server = http.createServer((request, response) => {
    if (request.url?.endsWith('/getUpdates')) { pending = response; enter(); return; }
    response.end(JSON.stringify({ ok: true, result: request.url?.endsWith('/getMe') ? { id: 123, username: 'fixture' } : true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TELEGRAM_BOT_API_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => { server.closeAllConnections(); server.close(); if (previousBase === undefined) delete process.env.TELEGRAM_BOT_API_BASE_URL; else process.env.TELEGRAM_BOT_API_BASE_URL = previousBase; });
  let writes = 0;
  const gateway = new TelegramGateway('123:fixture', '42', null, 1000, { ...storeStub, setTelegramOffset: () => { writes++; } } as any, loggerStub as any);
  t.after(() => gateway.stop());
  await gateway.start();
  await polling;
  await gateway.stop();
  (pending as http.ServerResponse | null)?.end(JSON.stringify({ ok: true, result: [{ update_id: 1 }] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
});


test('native stop updates require a matching private chat, topic and registered generation', async () => {
  const gateway = new TelegramGateway('123:fixture', '42', null, 1000, storeStub as any, loggerStub as any, true);
  const stops: any[] = [];
  gateway.setInboundConsumer(async (_id, inbound) => { stops.push(inbound); });
  gateway.registerGeneration(17, 'telegram:bot123:42::root', 'task', '42', null);
  const update = (id: number, chatId = 42, type = 'private', topicId?: number) => ({ update_id: 1, stopped_message_generation: { chat: { id: chatId, type }, draft_id: id, ...(topicId ? { message_thread_id: topicId } : {}) } });
  await (gateway as any).handleUpdate(update(18));
  await (gateway as any).handleUpdate(update(17, 43));
  await (gateway as any).handleUpdate(update(17, 42, 'group'));
  await (gateway as any).handleUpdate(update(17, 42, 'private', 5));
  assert.equal(stops.length, 0);
  await (gateway as any).handleUpdate(update(17));
  assert.deepEqual(stops[0], { kind: 'stop', event: { scopeId: 'telegram:bot123:42::root', taskId: 'task' } });
  gateway.releaseGeneration(17);
  await (gateway as any).handleUpdate(update(17));
  assert.equal(stops.length, 1);
});


test('stoppable rich draft serializes native flags and polling acknowledges only after durable intake', async t => {
  const previousBase = process.env.TELEGRAM_BOT_API_BASE_URL;
  const requests: Array<{ method: string; body: any }> = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const method = request.url!.split('/').at(-1)!;
      requests.push({ method, body: JSON.parse(raw) });
      response.end(JSON.stringify({ ok: true, result: method === 'getUpdates'
        ? [{ update_id: 9, message: { message_id: 7, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'recover me' } }]
        : true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TELEGRAM_BOT_API_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => { server.closeAllConnections(); server.close(); if (previousBase === undefined) delete process.env.TELEGRAM_BOT_API_BASE_URL; else process.env.TELEGRAM_BOT_API_BASE_URL = previousBase; });
  const offsets: number[] = [];
  const gateway = new TelegramGateway('123:secret', '42', null, 1000, { ...storeStub, setTelegramOffset: (_key: string, offset: number) => { offsets.push(offset); } } as any, loggerStub as any);
  await gateway.sendRichMessageDraft('42', 101, { text: 'working' } as any, 5, true);
  assert.equal(requests[0]!.body.can_stop, true);
  assert.equal(requests[0]!.body.keep_on_stop, true);
  assert.equal(requests[0]!.body.message_thread_id, 5);
  (gateway as any).resolveBotIdentity = async () => {};
  (gateway as any).registerCommands = async () => {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  gateway.setInboundConsumer(async () => { entered(); await gate; (gateway as any).running = false; });
  await gateway.start(); await started;
  assert.deepEqual(offsets, [], 'Transport must not acknowledge while intake is incomplete');
  release(); await (gateway as any).polling;
  assert.deepEqual(offsets, [9]);
  assert.ok(requests.find(r => r.method === 'getUpdates')!.body.allowed_updates.includes('stopped_message_generation'));
  await gateway.stop();
});
