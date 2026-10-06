import { randomBytes } from 'node:crypto';
import type { ChannelInlineKeyboard } from '../core/channel_port.js';
import type { ChannelTextEvent, ChannelCallbackEvent } from '../core/channel_events.js';

/** Scoped, expiring actions for channels without inline buttons. */
export class TextActions {
  private readonly actions = new Map<string, { scopeId: string; data: string; messageId: number; expires: number }>();
  constructor(private readonly ttlMs = 300_000, private readonly maxActions = 2000) {}

  render(scopeId: string, messageId: number, keyboard: ChannelInlineKeyboard): string {
    this.prune();
    return keyboard.flat().map(button => {
      this.prune();
      while (this.actions.size >= this.maxActions && this.actions.size) this.actions.delete(this.actions.keys().next().value!);
      const code = randomBytes(6).toString('hex');
      this.actions.set(code, { scopeId, data: button.callback_data, messageId, expires: Date.now() + this.ttlMs });
      return `${button.text}  /choose ${code}`;
    }).join('\n');
  }

  resolve(event: ChannelTextEvent): ChannelCallbackEvent | null {
    this.prune();
    const match = /^\/choose\s+([a-f0-9]+)\s*$/i.exec(event.text);
    const code = match?.[1];
    if (!code) return null;
    const action = this.actions.get(code);
    if (!action || action.scopeId !== event.scopeId) return null;
    this.actions.delete(code);
    return { scopeId: event.scopeId, chatId: event.chatId, topicId: event.topicId, userId: event.userId,
      messageId: action.messageId, data: action.data, callbackQueryId: `text:${code}`, ...(event.languageCode ? { languageCode: event.languageCode } : {}) };
  }

  clearMessage(scopeId: string, messageId: number): void {
    for (const [code, action] of this.actions) if (action.scopeId === scopeId && action.messageId === messageId) this.actions.delete(code);
  }

  clear(): void { this.actions.clear(); }
  private prune(): void {
    for (const [code, action] of this.actions) if (action.expires <= Date.now()) this.actions.delete(code);
    while (this.actions.size > this.maxActions) this.actions.delete(this.actions.keys().next().value!);
  }
}
