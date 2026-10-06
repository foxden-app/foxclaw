import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramMessagingPort } from './telegram_messaging_port.js';
import type { TelegramGateway } from '../../telegram/gateway.js';

test('Telegram commentary is a normal rich message while working, then folds with complete long text', async () => {
  const calls: Array<{ method: string; html: string; id?: number }> = [];
  const gateway = {
    sendRichMessage: async (_chat: string, rich: { html?: string; markdown?: string }) => { calls.push({ method: 'send', html: rich.html ?? rich.markdown ?? '' }); return 42; },
    editRichMessage: async (_chat: string, id: number, rich: { html: string }) => { calls.push({ method: 'edit', html: rich.html, id }); },
  } as unknown as TelegramGateway;
  const port = new TelegramMessagingPort(gateway);
  const text = '**Progress** <script>untrusted</script>\n\n' + 'long detail '.repeat(600) + 'complete tail';
  const id = await port.sendTaskCommentary('telegram:bot1:123::root', text);
  await port.foldTaskCommentary('telegram:bot1:123::root', id, text);
  assert.doesNotMatch(calls[0]!.html, /blockquote expandable/);
  assert.match(calls[1]!.html, /^<details><summary>过程小结<\/summary>/);
  assert.doesNotMatch(calls[1]!.html, /<details open/);
  assert.match(calls[1]!.html, /complete tail/);
  assert.match(calls[1]!.html, /&lt;script&gt;/);
  assert.equal(calls[1]!.id, 42);
});

test('short commentary also uses a closed disclosure with a visible summary', async () => {
  let html = '';
  const gateway = {
    editRichMessage: async (_chat: string, _id: number, rich: { html: string }) => { html = rich.html; },
  } as unknown as TelegramGateway;
  await new TelegramMessagingPort(gateway).foldTaskCommentary('telegram:bot1:123::root', 42, '检查完成。');
  assert.equal(html, '<details><summary>过程小结</summary><p>检查完成。</p></details>');
});

test('unsupported rich disclosures fall back to escaped HTML quotes', async () => {
  let html = '';
  const gateway = {
    editRichMessage: async () => { throw new Error('Unsupported rich messages'); },
    editHtmlMessage: async (_chat: string, _id: number, text: string) => { html = text; },
  } as unknown as TelegramGateway;
  await new TelegramMessagingPort(gateway).foldTaskCommentary('telegram:bot1:123::root', 42, '<unsafe>');
  assert.equal(html, '<blockquote expandable>&lt;unsafe&gt;</blockquote>');
});
