export const TELEGRAM_RICH_MESSAGE_TEXT_LIMIT = 32_768;
export const TELEGRAM_RICH_MESSAGE_BLOCK_LIMIT = 500;

export interface TelegramInputRichMessage {
  html?: string;
  markdown?: string;
  is_rtl?: true;
  skip_entity_detection?: true;
}

export interface TelegramRichMessageOptions {
  isRtl?: boolean;
  skipEntityDetection?: boolean;
}

export function telegramRichHtml(html: string, options: TelegramRichMessageOptions = {}): TelegramInputRichMessage {
  const message: TelegramInputRichMessage = { html };
  if (options.isRtl) {
    message.is_rtl = true;
  }
  if (options.skipEntityDetection) {
    message.skip_entity_detection = true;
  }
  return message;
}
