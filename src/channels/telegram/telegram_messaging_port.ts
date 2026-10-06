import { TelegramTaskPreviews } from '../../telegram/task_preview.js';
import { telegramTaskResult } from '../../telegram/task_result.js';
import type { AppConfig } from '../../config.js';
import type { ChannelTextEvent } from '../../core/channel_events.js';
import { parseCommand } from '../../controller/commands.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../../telegram/addressing.js';
import { parseTelegramTargetFromBridgeScope } from '../../core/bridge_scope.js';
import type { ChannelPort } from '../../core/channel_port.js';
import type { TelegramGateway } from '../../telegram/gateway.js';
import type { TelegramRemoteFile } from '../../telegram/api.js';
import { renderTelegramMarkdownRichHtml } from '../../telegram/rich_markdown.js';
import { escapeTelegramHtml } from '../../telegram/html.js';
import { telegramRichHtml, telegramRichMarkdown } from '../../telegram/rich.js';
import type { TaskCommentaryArchive } from '../../core/commentary_archive.js';
import { buildTelegramCommentaryArchive } from '../../telegram/commentary_archive.js';

export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

/**
 * Telegram outbound operations addressed by bridge scope id (`telegram:…`).
 */
export class TelegramMessagingPort implements ChannelPort {
  private readonly taskPreviews: TelegramTaskPreviews;
  constructor(private readonly gateway: TelegramGateway) { this.taskPreviews = new TelegramTaskPreviews(gateway); }
  beginTaskPreview(scopeId: string, taskId: string, text: string, reuseMessageId = 0) { return this.taskPreviews.begin(scopeId, taskId, text, reuseMessageId); }
  updateTaskPreview(scopeId: string, taskId: string, messageId: number, html: string) { return this.taskPreviews.update(scopeId, taskId, messageId, html); }
  endTaskPreview(scopeId: string, taskId: string) { return this.taskPreviews.end(scopeId, taskId); }

  async sendTaskCommentary(scopeId: string, text: string): Promise<number> {
    return this.sendRichMarkdown(scopeId, text);
  }
  async archiveTaskCommentary(scopeId: string, messageId: number, archive: TaskCommentaryArchive): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(scopeId);
    const rendered = buildTelegramCommentaryArchive(archive);
    if (rendered.document) {
      await this.gateway.editRichMessageWithDocument(target.chatId, messageId, rendered.html, rendered.document);
    } else {
      await this.gateway.editRichMessage(target.chatId, messageId, telegramRichHtml(rendered.html, { skipEntityDetection: true }), []);
    }
  }
  async foldTaskCommentary(scopeId: string, messageId: number, text: string): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(scopeId);
    try {
      await this.gateway.editRichMessage(target.chatId, messageId,
        telegramRichHtml(`<details><summary>过程小结</summary>${renderTelegramMarkdownRichHtml(text)}</details>`, { skipEntityDetection: true }), []);
    } catch {
      // The plain HTML endpoint has a smaller envelope than rich messages.
      if (text.length > 3000) throw new Error('Long commentary requires Telegram rich messages');
      await this.gateway.editHtmlMessage(target.chatId, messageId, `<blockquote expandable>${escapeTelegramHtml(text)}</blockquote>`, []);
    }
  }

  readonly capabilities = { editableMessages: true, inlineActions: true, maxMessageLength: 4000 };

  resolveIncoming(event: ChannelTextEvent, config: AppConfig, username?: string | null) {
    return resolveTelegramAddressing({ text: event.text, attachmentsCount: event.attachments.length,
      entities: event.entities, command: parseCommand(event.text), botUsername: username ?? null,
      isDefaultTopic: isDefaultTelegramScope({ chatType: event.chatType, allowedChatId: config.tgAllowedChatId ?? null,
        allowedTopicId: config.tgAllowedTopicId ?? null, topicId: event.topicId, requireExplicitGroupAddressing: false }), replyToBot: event.replyToBot });
  }

  async setScopeCommands(scopeId: string, commands: Array<{ command: string; description: string }>): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(scopeId);
    await this.gateway.setChatCommands(target.chatId, commands);
  }

  async sendPlain(
    bridgeScopeId: string,
    text: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<number> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    return this.gateway.sendMessage(target.chatId, text, inlineKeyboard, target.topicId);
  }

  async sendHtml(
    bridgeScopeId: string,
    text: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<number> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    return this.gateway.sendHtmlMessage(target.chatId, text, inlineKeyboard, target.topicId);
  }

  async sendRichHtml(
    bridgeScopeId: string,
    html: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<number> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    return this.gateway.sendRichMessage(
      target.chatId,
      telegramRichHtml(html, { skipEntityDetection: true }),
      inlineKeyboard,
      target.topicId,
    );
  }

  async sendRichMarkdown(
    bridgeScopeId: string,
    markdown: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<number> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    return this.gateway.sendRichMessage(
      target.chatId,
      telegramTaskResult(markdown),
      inlineKeyboard,
      target.topicId,
    );
  }

  async sendVoice(
    bridgeScopeId: string,
    filename: string,
    contents: Buffer,
    caption?: string,
    contentType?: string,
  ): Promise<number> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    return this.gateway.sendVoice(target.chatId, filename, contents, caption, target.topicId, contentType);
  }

  async editPlain(
    bridgeScopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.editMessage(target.chatId, messageId, text, inlineKeyboard);
  }

  async editHtml(
    bridgeScopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.editHtmlMessage(target.chatId, messageId, text, inlineKeyboard);
  }

  async editRichHtml(
    bridgeScopeId: string,
    messageId: number,
    html: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.editRichMessage(
      target.chatId,
      messageId,
      telegramRichHtml(html, { skipEntityDetection: true }),
      inlineKeyboard,
    );
  }

  async editRichMarkdown(
    bridgeScopeId: string,
    messageId: number,
    markdown: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.editRichMessage(
      target.chatId,
      messageId,
      telegramTaskResult(markdown),
      inlineKeyboard,
    );
  }

  async deleteMessage(bridgeScopeId: string, messageId: number): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.deleteMessage(target.chatId, messageId);
  }

  async sendTypingInScope(bridgeScopeId: string): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.sendTypingInThread(target.chatId, target.topicId);
  }

  async clearInlineKeyboard(bridgeScopeId: string, messageId: number): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.clearMessageInlineKeyboard(target.chatId, messageId);
  }

  async sendDraft(bridgeScopeId: string, draftId: number, text: string): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.sendMessageDraft(target.chatId, draftId, text, target.topicId);
  }

  async sendRichDraft(bridgeScopeId: string, draftId: number, html: string): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.sendRichMessageDraft(
      target.chatId,
      draftId,
      telegramRichHtml(html, { skipEntityDetection: true }),
      target.topicId,
    );
  }

  async sendRichMarkdownDraft(bridgeScopeId: string, draftId: number, markdown: string): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.sendRichMessageDraft(
      target.chatId,
      draftId,
      telegramRichMarkdown(markdown, { skipEntityDetection: true }),
      target.topicId,
    );
  }

  answerCallback(callbackQueryId: string, text: string): Promise<void> {
    return this.gateway.answerCallback(callbackQueryId, text);
  }

  getFile(fileId: string): Promise<TelegramRemoteFile> {
    return this.gateway.getFile(fileId);
  }

  downloadResolvedFile(remoteFilePath: string, destinationPath: string): Promise<number> {
    return this.gateway.downloadResolvedFile(remoteFilePath, destinationPath);
  }
}
