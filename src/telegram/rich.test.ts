import assert from 'node:assert/strict';
import test from 'node:test';
import { TELEGRAM_RICH_MESSAGE_BLOCK_LIMIT, TELEGRAM_RICH_MESSAGE_TEXT_LIMIT, telegramRichHtml, telegramRichMarkdown } from './rich.js';

test('telegramRichHtml builds the Bot API InputRichMessage shape', () => {
  assert.deepEqual(telegramRichHtml('<h2>FoxClaw</h2>'), { html: '<h2>FoxClaw</h2>' });
  assert.deepEqual(telegramRichHtml('<p>x</p>', { skipEntityDetection: true, isRtl: true }), {
    html: '<p>x</p>',
    is_rtl: true,
    skip_entity_detection: true,
  });
  assert.deepEqual(telegramRichMarkdown('# x', { skipEntityDetection: true }), {
    markdown: '# x',
    skip_entity_detection: true,
  });
});

test('rich message limits document the Telegram API envelope we target', () => {
  assert.equal(TELEGRAM_RICH_MESSAGE_TEXT_LIMIT, 32_768);
  assert.equal(TELEGRAM_RICH_MESSAGE_BLOCK_LIMIT, 500);
});
