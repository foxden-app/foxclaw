import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger.js';
import {
  planAttachmentStoragePath,
  isNativeImageAttachment,
  TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
  type StagedTelegramAttachment,
  type TelegramInboundAttachment,
} from '../telegram/media.js';

export interface TelegramFileDownloader {
  getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }>;
  downloadResolvedFile(filePath: string, destination: string): Promise<unknown>;
}

export async function stageInboundAttachments(
  downloader: TelegramFileDownloader,
  cwd: string,
  threadId: string,
  attachments: readonly TelegramInboundAttachment[],
  logger?: Logger,
): Promise<StagedTelegramAttachment[]> {
  const staged: StagedTelegramAttachment[] = [];
  for (const attachment of attachments) {
    try {
      if (attachment.localPath) {
        const planned = planAttachmentStoragePath(
          cwd,
          threadId,
          attachment,
          path.basename(attachment.localPath),
        );
        await fsPromises.mkdir(path.dirname(planned.localPath), { recursive: true });
        await fsPromises.copyFile(attachment.localPath, planned.localPath);
        const stat = await fsPromises.stat(planned.localPath);
        const resolvedSize = stat.size;
        staged.push({
          ...attachment,
          fileName: planned.fileName,
          fileSize: resolvedSize,
          localPath: planned.localPath,
          relativePath: planned.relativePath,
          nativeImage: isNativeImageAttachment(attachment),
        });
        continue;
      }

      const remoteFile = await downloader.getFile(attachment.fileId);
      const resolvedSize = attachment.fileSize ?? remoteFile.file_size ?? null;
      if (resolvedSize !== null && resolvedSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES) {
        logger?.warn('attachments.too_large', {
          fileId: attachment.fileId,
          size: resolvedSize,
        });
        continue;
      }
      if (!remoteFile.file_path) {
        continue;
      }
      const planned = planAttachmentStoragePath(cwd, threadId, attachment, remoteFile.file_path);
      await fsPromises.mkdir(path.dirname(planned.localPath), { recursive: true });
      await downloader.downloadResolvedFile(remoteFile.file_path, planned.localPath);
      staged.push({
        ...attachment,
        fileName: planned.fileName,
        fileSize: resolvedSize,
        localPath: planned.localPath,
        relativePath: planned.relativePath,
        nativeImage: isNativeImageAttachment(attachment),
      });
    } catch (error) {
      logger?.warn('attachments.download_failed', {
        fileId: attachment.fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return staged;
}
