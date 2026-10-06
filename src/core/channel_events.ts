import type { InboundAttachment } from './attachment_types.js';

export interface ChannelMessageEntity { type: string; offset: number; length: number; user?: { id: number }; }

export interface ChannelTextEvent {
  chatId: string;
  topicId: number | null;
  scopeId: string;
  chatType: string;
  userId: string;
  text: string;
  messageId: number;
  mediaGroupId?: string | null;
  attachments: InboundAttachment[];
  entities: ChannelMessageEntity[];
  replyToBot: boolean;
  languageCode?: string;
}

export interface ChannelCallbackEvent {
  chatId: string;
  topicId: number | null;
  scopeId: string;
  userId: string;
  data: string;
  callbackQueryId: string;
  messageId: number;
  languageCode?: string;
}


/** A transport-correlated stop; generation identifiers never select a task in another scope. */
export interface ChannelStopEvent { scopeId: string; taskId: string; }
export type ChannelInbound = { kind: 'text'; event: ChannelTextEvent } | { kind: 'callback'; event: ChannelCallbackEvent } | { kind: 'stop'; event: ChannelStopEvent };
