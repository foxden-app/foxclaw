import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTelegramMarkdownRichHtml } from './rich_markdown.js';

test('renderTelegramMarkdownRichHtml maps common Codex Markdown to RichMessage HTML', () => {
  const html = renderTelegramMarkdownRichHtml([
    '# Result',
    '',
    '- **Changed** `src/app.ts`',
    '- See [docs](https://example.com/docs?x=1&y=2)',
    '',
    '```ts',
    'const value = "<ok>";',
    '```',
  ].join('\n'));

  assert.match(html, /<h2>Result<\/h2>/);
  assert.match(html, /<ul><li><b>Changed<\/b> <code>src\/app\.ts<\/code><\/li>/);
  assert.match(html, /<a href="https:\/\/example\.com\/docs\?x=1&amp;y=2">docs<\/a>/);
  assert.match(html, /<pre><code class="language-ts">const value = "&lt;ok&gt;";<\/code><\/pre>/);
});

test('renderTelegramMarkdownRichHtml escapes plain HTML and unsafe links', () => {
  const html = renderTelegramMarkdownRichHtml('<b>literal</b> [bad](javascript:alert(1))');

  assert.equal(html, '<p>&lt;b&gt;literal&lt;/b&gt; bad</p>');
});
