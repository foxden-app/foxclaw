import type { AppConfig } from '../config.js';
import type { AppLocale } from '../types.js';
import type { ChannelTextEvent, ChannelCallbackEvent, ChannelInbound } from './channel_events.js';
import type { ParsedCommand } from '../controller/commands.js';
import type { AttachmentDownloader } from './attachments.js';

/** Bridge-local handles; a transport maps these to its native message identifiers. */
export type ChannelMessageRef = number;
export type ChannelInlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;
export type InboundAddressing = { kind: 'ignore' } | { kind: 'prompt'; text: string } | { kind: 'command'; command: ParsedCommand };

/** Presentation and file transport contract. Native addressing and interaction live in channels. */
export interface ChannelPort extends AttachmentDownloader {
  readonly capabilities?: { editableMessages: boolean; inlineActions: boolean; maxMessageLength: number };
  resolveIncoming?(event: ChannelTextEvent, config: AppConfig, username?: string | null): InboundAddressing;
  setScopeCommands?(scopeId: string, commands: Array<{ command: string; description: string }>): Promise<void>;
  beginTaskPreview?(scopeId: string, taskId: string, text: string, reuseMessageId?: number): Promise<number>;
  updateTaskPreview?(scopeId: string, taskId: string, messageId: number, html: string): Promise<number>;
  sendTaskCommentary?(scopeId: string, text: string): Promise<number>;
  foldTaskCommentary?(scopeId: string, messageId: number, text: string): Promise<void>;
  endTaskPreview?(scopeId: string, taskId: string): Promise<void>;
  resolveAction?(event: ChannelTextEvent): ChannelCallbackEvent | null;
  editPlain(scopeId: string, messageId: ChannelMessageRef, text: string, keyboard?: ChannelInlineKeyboard): Promise<void>;
  sendPlain(scopeId: string, text: string, keyboard?: ChannelInlineKeyboard): Promise<ChannelMessageRef>;
  sendHtml(scopeId: string, text: string, keyboard?: ChannelInlineKeyboard): Promise<ChannelMessageRef>;
  sendRichMarkdown(scopeId: string, text: string, keyboard?: ChannelInlineKeyboard): Promise<ChannelMessageRef>;
  editRichMarkdown(scopeId: string, messageId: ChannelMessageRef, text: string, keyboard?: ChannelInlineKeyboard): Promise<void>;
  deleteMessage(scopeId: string, messageId: ChannelMessageRef): Promise<void>;
  sendTypingInScope(scopeId: string): Promise<void>;
  answerCallback(callbackId: string, text: string): Promise<void>;
}

export interface ChannelGateway {
  setInboundConsumer?(consumer: (id: string, inbound: ChannelInbound) => Promise<void>): () => void;
  readonly username?: string | null;
  on(event: 'text', listener: (event: ChannelTextEvent) => void): unknown;
  on(event: 'callback', listener: (event: ChannelCallbackEvent) => void): unknown;
  off?(event: 'text' | 'callback', listener: (...args: any[]) => void): unknown;
  start(): Promise<void>;
  stop(): void | Promise<void>;
}

export interface ChannelCommand { command: string; description: string; }
export type ChannelCommandProvider = (locale: AppLocale) => ChannelCommand[];
