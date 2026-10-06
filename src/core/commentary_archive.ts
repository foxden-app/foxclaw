import type { AppLocale } from '../types.js';
import type { EngineTurnResult } from './engine_spi.js';

export interface TaskCommentaryArchive {
  startedAt: number;
  endedAt: number;
  locale: AppLocale;
  usage?: EngineTurnResult['usage'];
  entries: Array<{ text: string; startedAt?: number | undefined; endedAt?: number | undefined }>;
}
