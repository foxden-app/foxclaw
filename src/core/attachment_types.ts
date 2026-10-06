export type AttachmentKind =
  | 'photo'
  | 'document'
  | 'audio'
  | 'voice'
  | 'video'
  | 'animation'
  | 'sticker'
  | 'videoNote';

export interface InboundAttachment {
  kind: AttachmentKind;
  fileId: string;
  fileUniqueId: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  isAnimated: boolean;
  isVideo: boolean;
  /** When set, {@link stageAttachments} copies this file instead of Telegram Bot API download. */
  localPath?: string;
}

export interface StagedAttachment extends InboundAttachment {
  fileName: string;
  localPath: string;
  relativePath: string;
  nativeImage: boolean;
}

