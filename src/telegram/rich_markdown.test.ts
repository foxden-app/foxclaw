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

test('renderTelegramMarkdownRichHtml preserves nested numbered choices', () => {
  const html = renderTelegramMarkdownRichHtml([
    '1. **Default model** Which route?',
    '   1. Private model - Internal first.',
    '   2. DeepSeek first - External fallback.',
    '2. **Offline package** Which strategy?',
    '   1. Image tar - docker save/load.',
  ].join('\n'));

  assert.equal(
    html,
    '<ol><li><b>Default model</b> Which route?<ol><li>Private model - Internal first.</li><li>DeepSeek first - External fallback.</li></ol></li><li><b>Offline package</b> Which strategy?<ol><li>Image tar - docker save/load.</li></ol></li></ol>',
  );
});
