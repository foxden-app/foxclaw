import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stageInboundAttachments, type TelegramFileDownloader } from './attachments.js';
import type { TelegramInboundAttachment } from '../telegram/media.js';

test('stageInboundAttachments downloads remote files and stages them locally', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-attachments-test-'));

  try {
    const mockDownloader: TelegramFileDownloader = {
      async getFile(fileId: string) {
        return {
          file_id: fileId,
          file_path: 'photos/mock-photo.jpg',
          file_size: 1024,
        };
      },
      async downloadResolvedFile(filePath: string, dest: string) {
        await fs.writeFile(dest, 'mock-binary-data');
      },
    };

    const attachment: TelegramInboundAttachment = {
      kind: 'photo',
      fileId: 'photo-123',
      fileUniqueId: 'u-123',
      fileName: 'test.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
      width: 800,
      height: 600,
      durationSeconds: null,
      isAnimated: false,
      isVideo: false,
    };

    const staged = await stageInboundAttachments(
      mockDownloader,
      tempDir,
      'thread-abc',
      [attachment],
    );

    assert.equal(staged.length, 1);
    assert.equal(staged[0]?.nativeImage, true);
    assert.ok(staged[0]?.localPath.includes('.telegram-inbox'));

    const content = await fs.readFile(staged[0]!.localPath, 'utf8');
    assert.equal(content, 'mock-binary-data');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
