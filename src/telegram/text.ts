export const TELEGRAM_MESSAGE_LIMIT = 4000;
export const TELEGRAM_STREAM_MESSAGE_LIMIT = 1200;
export const TELEGRAM_DRAFT_LIMIT = 4000;

export function sanitizeTelegramPreview(text: string): string {
  if (!text.trim()) return 'Working...';
  return text.length > TELEGRAM_MESSAGE_LIMIT
    ? `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 3)}...`
    : text;
}

export { chunkMessage as chunkTelegramMessage } from '../core/message_text.js';
import { chunkMessage as chunkTelegramMessage } from '../core/message_text.js';

export function chunkTelegramStreamMessage(text: string, limit = TELEGRAM_STREAM_MESSAGE_LIMIT): string[] {
  return chunkTelegramMessage(text, limit, '');
}

export function clipTelegramDraftMessage(text: string, fallbackText = 'Thinking...'): string {
  const source = text.trim() ? text : fallbackText;
  if (source.length <= TELEGRAM_DRAFT_LIMIT) {
    return source;
  }
  return `${source.slice(0, TELEGRAM_DRAFT_LIMIT - 1)}…`;
}
