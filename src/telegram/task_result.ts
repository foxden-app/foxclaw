import { telegramRichHtml, telegramRichMarkdown } from './rich.js';
import { renderTelegramMarkdownRichHtml } from './rich_markdown.js';

/** Only the generated fold formatting is accepted; arbitrary model HTML remains escaped. */
export function telegramTaskResult(content: string) {
  const folded = /^(<blockquote expandable>[\s\S]*?<\/blockquote>)(?:\s*|$)/.exec(content);
  if (!folded) return telegramRichMarkdown(content, { skipEntityDetection: true });
  const response = content.slice(folded[0].length);
  const summary = folded[1]!.replace(/<[^>]*>/g, tag => /^(?:<\/?(?:b|i|code)>|<blockquote expandable>|<\/blockquote>)$/.test(tag)
    ? tag : tag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  return telegramRichHtml(`${response.trim() ? renderTelegramMarkdownRichHtml(response) : ''}\n${summary}`, { skipEntityDetection: true });
}
