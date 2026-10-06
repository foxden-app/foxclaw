import { randomInt } from 'node:crypto';
import type { TelegramGateway } from './gateway.js';
import { parseTelegramTargetFromBridgeScope } from '../core/bridge_scope.js';
import { telegramRichHtml } from './rich.js';
import { renderTelegramMarkdownRichHtml } from './rich_markdown.js';

interface Preview { scopeId: string; draftId: number | null; messageId: number; }
/** Owns live drafts and fallback cards; draft ids are never persistent message ids. */
export class TelegramTaskPreviews {
  private readonly previews = new Map<string, Preview>();
  private readonly draftIds = new Set<number>();
  constructor(private readonly gateway: TelegramGateway) {}
  private keyboard(taskId: string) { return [[{ text: '🛑 停止 / Stop', callback_data: `engine:stop:${taskId}` }]]; }
  private async sendCard(scopeId: string, taskId: string, html: string): Promise<number> {
    const target = parseTelegramTargetFromBridgeScope(scopeId);
    try { return await this.gateway.sendRichMessage(target.chatId, telegramRichHtml(html), this.keyboard(taskId), target.topicId); }
    catch { return this.gateway.sendHtmlMessage(target.chatId, html.replace(/<\/?p>/g, ''), this.keyboard(taskId), target.topicId); }
  }
  async begin(scopeId: string, taskId: string, text: string, reuseMessageId = 0): Promise<number> {
    const target = parseTelegramTargetFromBridgeScope(scopeId);
    const html = renderTelegramMarkdownRichHtml(text);
    const preview: Preview = { scopeId, draftId: null, messageId: reuseMessageId };
    this.previews.set(taskId, preview);
    if (reuseMessageId > 0) {
      await this.gateway.editRichMessage(target.chatId, reuseMessageId, telegramRichHtml(html), this.keyboard(taskId));
      return reuseMessageId;
    }
    if (/^[1-9]\d*$/.test(target.chatId)) {
      let draftId = randomInt(1, 2 ** 31);
      while (this.draftIds.has(draftId)) draftId = randomInt(1, 2 ** 31);
      this.draftIds.add(draftId); preview.draftId = draftId;
      this.gateway.registerGeneration(draftId, scopeId, taskId, target.chatId, target.topicId);
      try { await this.gateway.sendRichMessageDraft(target.chatId, draftId, telegramRichHtml(html), target.topicId, true); return 0; }
      catch { this.gateway.releaseGeneration(draftId); this.draftIds.delete(draftId); preview.draftId = null; }
    }
    preview.messageId = await this.sendCard(scopeId, taskId, html);
    return preview.messageId;
  }
  async update(scopeId: string, taskId: string, messageId: number, html: string): Promise<number> {
    const preview = this.previews.get(taskId);
    if (!preview || preview.scopeId !== scopeId) return messageId;
    const target = parseTelegramTargetFromBridgeScope(scopeId);
    if (preview.draftId !== null) {
      try { await this.gateway.sendRichMessageDraft(target.chatId, preview.draftId, telegramRichHtml(html), target.topicId, true); return 0; }
      catch {
        const draftId = preview.draftId;
        this.gateway.releaseGeneration(draftId); this.draftIds.delete(draftId); preview.draftId = null;
        await this.gateway.sendMessageDraft(target.chatId, draftId, '', target.topicId).catch(() => {});
        preview.messageId = await this.sendCard(scopeId, taskId, html);
        return preview.messageId;
      }
    }
    try { await this.gateway.editRichMessage(target.chatId, preview.messageId, telegramRichHtml(html), this.keyboard(taskId)); }
    catch { await this.gateway.editHtmlMessage(target.chatId, preview.messageId, html, this.keyboard(taskId)); }
    return preview.messageId;
  }
  async end(scopeId: string, taskId: string): Promise<void> {
    const preview = this.previews.get(taskId);
    if (!preview || preview.scopeId !== scopeId) return;
    this.previews.delete(taskId);
    if (preview.draftId !== null) {
      this.gateway.releaseGeneration(preview.draftId); this.draftIds.delete(preview.draftId);
      const target = parseTelegramTargetFromBridgeScope(scopeId);
      await this.gateway.sendMessageDraft(target.chatId, preview.draftId, '', target.topicId).catch(() => {});
    }
  }
}
