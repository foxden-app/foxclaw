import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeTelegramHtml,
  telegramBold,
  telegramCode,
  telegramDetails,
  telegramExpandableBlockquote,
  telegramPre,
  telegramPreCode,
  telegramSpoiler,
} from './html.js';

test('escapeTelegramHtml escapes Telegram HTML control characters', () => {
  assert.equal(escapeTelegramHtml('a & <b>'), 'a &amp; &lt;b&gt;');
});

test('Telegram HTML helpers escape wrapped content', () => {
  assert.equal(telegramBold('a & <b>'), '<b>a &amp; &lt;b&gt;</b>');
  assert.equal(telegramCode('x > y'), '<code>x &gt; y</code>');
  assert.equal(telegramPre('line <1>'), '<pre>line &lt;1&gt;</pre>');
  assert.equal(telegramPreCode('line <1>', 'diff'), '<pre><code class="language-diff">line &lt;1&gt;</code></pre>');
  assert.equal(telegramExpandableBlockquote('a\n<b>'), '<blockquote expandable>a\n&lt;b&gt;</blockquote>');
  assert.equal(telegramSpoiler('secret & token'), '<tg-spoiler>secret &amp; token</tg-spoiler>');
  assert.equal(telegramDetails('More <info>', '<p>safe body</p>'), '<details><summary>More &lt;info&gt;</summary><p>safe body</p></details>');
});
