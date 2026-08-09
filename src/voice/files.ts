import path from 'node:path';

export const TELEGRAM_VOICE_MAX_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_VOICE_SUPPORTED_EXTENSIONS = '.ogg, .opus, .oga, .mp3, .m4a';

export function telegramVoiceContentType(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.ogg':
    case '.oga':
    case '.opus':
      return 'audio/ogg';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    default:
      return null;
  }
}
