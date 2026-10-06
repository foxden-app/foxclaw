// Compatibility exports for existing Telegram consumers; storage and input are channel-independent.
export type { AttachmentKind as TelegramAttachmentKind, InboundAttachment as TelegramInboundAttachment, StagedAttachment as StagedTelegramAttachment } from '../core/attachment_types.js';
export { ATTACHMENT_INBOX_DIR as TELEGRAM_INBOX_DIR, DEFAULT_REMOTE_DOWNLOAD_LIMIT_BYTES as TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
  isNativeImageAttachment, planAttachmentStoragePath, buildAttachmentPrompt, summarizeInput as summarizeTelegramInput } from '../core/attachment_files.js';
