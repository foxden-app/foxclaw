import type { ChannelTextEvent } from '../core/channel_events.js';
import { BRIDGE_SCOPE_WEIXIN_PREFIX } from '../core/bridge_scope.js';
import type { ChannelPort } from '../core/channel_port.js';
type LegacyPanelPort = ChannelPort & Partial<Pick<TelegramMessagingPort, 'sendRichHtml' | 'editHtml' | 'editRichHtml' | 'sendVoice' | 'clearInlineKeyboard' | 'sendDraft' | 'sendRichDraft' | 'sendRichMarkdownDraft'>>;
import type { InlineKeyboard, TelegramMessagingPort } from './telegram/telegram_messaging_port.js';
import type { WeixinMessagingPort } from './weixin/weixin_messaging_port.js';

/**
 * Routes outbound calls by `scopeId` prefix: {@link BRIDGE_SCOPE_WEIXIN_PREFIX} vs Telegram.
 * Telegram-only surfaces (callbacks, Bot API files) always use the Telegram port.
 */
export class BridgeMessagingRouter {
  constructor(
    private readonly telegram: LegacyPanelPort,
    private readonly weixin: WeixinMessagingPort | null,
  ) {}

  resolveAction(event: ChannelTextEvent) { return this.isWeixinScope(event.scopeId) ? this.weixin?.resolveAction?.(event) ?? null : null; }

  get hasWeixinTransport(): boolean {
    return this.weixin !== null;
  }

  private isWeixinScope(scopeId: string): boolean {
    return scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX);
  }

  canSendToScope(scopeId: string): boolean {
    return !this.isWeixinScope(scopeId) || this.weixin !== null;
  }

  private requireWeixinTransport(scopeId: string): WeixinMessagingPort {
    if (!this.weixin) {
      throw new Error(`Weixin channel is disabled for scope ${scopeId}`);
    }
    return this.weixin;
  }

  sendPlain(scopeId: string, text: string, keyboard?: InlineKeyboard): Promise<number> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).sendPlain(scopeId, text, keyboard);
    }
    return this.telegram.sendPlain(scopeId, text, keyboard);
  }

  sendHtml(scopeId: string, text: string, keyboard?: InlineKeyboard): Promise<number> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).sendHtml(scopeId, text, keyboard);
    }
    return this.telegram.sendHtml(scopeId, text, keyboard);
  }

  sendRichHtml(scopeId: string, html: string, fallbackHtml: string, keyboard?: InlineKeyboard): Promise<number> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).sendHtml(scopeId, fallbackHtml, keyboard);
    }
    return this.telegram.sendRichHtml?.(scopeId, html, keyboard) ?? this.telegram.sendHtml(scopeId, fallbackHtml, keyboard);
  }

  sendRichMarkdown(scopeId: string, markdown: string, fallbackText: string, keyboard?: InlineKeyboard): Promise<number> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).sendPlain(scopeId, fallbackText, keyboard);
    }
    return this.telegram.sendRichMarkdown(scopeId, markdown, keyboard);
  }

  sendVoice(scopeId: string, filename: string, contents: Buffer, caption?: string, contentType?: string): Promise<number> {
    if (this.isWeixinScope(scopeId)) {
      throw new Error(`Voice messages are not supported for Weixin scope ${scopeId}`);
    }
    if (!this.telegram.sendVoice) throw new Error('Channel does not support sendVoice');
    return this.telegram.sendVoice(scopeId, filename, contents, caption, contentType);
  }

  editPlain(scopeId: string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).editPlain(scopeId, messageId, text, keyboard);
    }
    return this.telegram.editPlain(scopeId, messageId, text, keyboard);
  }

  editHtml(scopeId: string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).editHtml(scopeId, messageId, text, keyboard);
    }
    return this.telegram.editHtml?.(scopeId, messageId, text, keyboard) ?? this.telegram.editRichMarkdown(scopeId, messageId, text, keyboard);
  }

  editRichHtml(scopeId: string, messageId: number, html: string, fallbackHtml: string, keyboard?: InlineKeyboard): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).editHtml(scopeId, messageId, fallbackHtml, keyboard);
    }
    return this.telegram.editRichHtml?.(scopeId, messageId, html, keyboard) ?? this.editHtml(scopeId, messageId, fallbackHtml, keyboard);
  }

  editRichMarkdown(scopeId: string, messageId: number, markdown: string, fallbackText: string, keyboard?: InlineKeyboard): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).editPlain(scopeId, messageId, fallbackText, keyboard);
    }
    return this.telegram.editRichMarkdown(scopeId, messageId, markdown, keyboard);
  }

  deleteMessage(scopeId: string, messageId: number): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).deleteMessage(scopeId, messageId);
    }
    return this.telegram.deleteMessage(scopeId, messageId);
  }

  sendTypingInScope(scopeId: string): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).sendTypingInScope(scopeId);
    }
    return this.telegram.sendTypingInScope(scopeId);
  }

  clearInlineKeyboard(scopeId: string, messageId: number): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).clearInlineKeyboard(scopeId, messageId);
    }
    return this.telegram.clearInlineKeyboard?.(scopeId, messageId) ?? Promise.resolve();
  }

  sendDraft(scopeId: string, draftId: number, text: string): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).sendDraft(scopeId, draftId, text);
    }
    if (!this.telegram.sendDraft) throw new Error('Channel does not support sendDraft');
    return this.telegram.sendDraft(scopeId, draftId, text);
  }

  sendRichDraft(scopeId: string, draftId: number, html: string, fallbackText: string): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).sendDraft(scopeId, draftId, fallbackText);
    }
    if (!this.telegram.sendRichDraft) throw new Error('Channel does not support sendRichDraft');
    return this.telegram.sendRichDraft(scopeId, draftId, html);
  }

  sendRichMarkdownDraft(scopeId: string, draftId: number, markdown: string, fallbackText: string): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.requireWeixinTransport(scopeId).sendDraft(scopeId, draftId, fallbackText);
    }
    if (!this.telegram.sendRichMarkdownDraft) throw new Error('Channel does not support sendRichMarkdownDraft');
    return this.telegram.sendRichMarkdownDraft(scopeId, draftId, markdown);
  }

  answerCallback(callbackQueryId: string, text: string): Promise<void> {
    if (callbackQueryId.startsWith('text:')) return this.weixin?.answerCallback(callbackQueryId, text) ?? Promise.resolve();
    return this.telegram.answerCallback(callbackQueryId, text);
  }

  getFile(fileId: string): ReturnType<ChannelPort['getFile']> {
    return this.telegram.getFile(fileId);
  }

  downloadResolvedFile(remoteFilePath: string, destinationPath: string): ReturnType<ChannelPort['downloadResolvedFile']> {
    return this.telegram.downloadResolvedFile(remoteFilePath, destinationPath);
  }
}
