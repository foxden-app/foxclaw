import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTelegramCommentaryArchive } from './commentary_archive.js';
import type { TaskCommentaryArchive } from '../core/commentary_archive.js';

const archive: TaskCommentaryArchive = {
  startedAt: 1000, endedAt: 63000, locale: 'zh',
  usage: { totalTokens: 1200, inputTokens: 1000, outputTokens: 200, cachedTokens: 800 },
  entries: [{ text: '**First** summary', startedAt: 1000, endedAt: 10000 }, { text: '<unsafe> Second summary', startedAt: 10000, endedAt: 63000 }],
};

test('a single closed archive contains token counts in the requested order and all timed summaries', () => {
  const rendered = buildTelegramCommentaryArchive(archive);
  assert.match(rendered.html, /^<details><summary>总时间: 1m2s {2}Token（总\/入\/出\/缓存）: 1,200\/1,000\/200\/800<\/summary>/);
  assert.equal((rendered.html.match(/<details>/g) ?? []).length, 1);
  assert.doesNotMatch(rendered.html, /<details open|<unsafe>/);
  assert.match(rendered.html, /<b>First<\/b>/);
  assert.match(rendered.html, /&lt;unsafe&gt; Second summary/);
  assert.match(rendered.html, /\d\d:\d\d:\d\d–\d\d:\d\d:\d\d/);
  assert.equal(rendered.document, undefined);
});

test('unavailable token counts remain unknown rather than becoming zero', () => {
  const rendered = buildTelegramCommentaryArchive({ ...archive, usage: undefined });
  assert.match(rendered.html, /—\/—\/—\/—/);
});

test('oversized content is previewed inside one archive and preserved completely in its HTML document', () => {
  const text = 'long body '.repeat(4000) + 'unique complete tail <script>unsafe</script>';
  const rendered = buildTelegramCommentaryArchive({ ...archive, entries: [{ text }] });
  assert.ok(rendered.html.length < 30000);
  assert.match(rendered.html, /tg-document src="tg:\/\/document\?id=commentary_archive"/);
  assert.match(rendered.html, /查看全部小结/);
  const document = rendered.document!.contents.toString();
  assert.match(document, /unique complete tail &lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(document, /<script>/);
  assert.ok(document.length > text.length);
});

test('many small Markdown blocks trigger the full archive even below the text limit', () => {
  const entries = Array.from({ length: 240 }, () => ({ text: 'Small summary' }));
  const rendered = buildTelegramCommentaryArchive({ ...archive, entries });
  assert.ok(rendered.document);
  assert.match(rendered.html, /共 240 条小结/);
  assert.equal((rendered.document.contents.toString().match(/Small summary/g) ?? []).length, 240);
});
