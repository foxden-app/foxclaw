import type { TaskCommentaryArchive } from '../core/commentary_archive.js';
import { escapeTelegramHtml } from './html.js';
import { renderTelegramMarkdownRichHtml } from './rich_markdown.js';

export interface TelegramCommentaryArchive {
  html: string;
  document?: { filename: string; contents: Buffer; contentType: string };
}

export function commentaryArchiveHeader(archive: TaskCommentaryArchive): string {
  const zh = archive.locale === 'zh';
  const seconds = Math.max(0, Math.round((archive.endedAt - archive.startedAt) / 1000));
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  const count = (n?: number) => typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.max(0, n)).toLocaleString('en-US') : '—';
  const usage = archive.usage;
  const total = usage?.totalTokens ?? (usage?.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : undefined);
  return `${zh ? '总时间' : 'Total time'}: ${duration}  ${zh ? 'Token（总/入/出/缓存）' : 'Tokens (total/in/out/cache)'}: ${[total, usage?.inputTokens, usage?.outputTokens, usage?.cachedTokens].map(count).join('/')}`;
}

function interval(entry: TaskCommentaryArchive['entries'][number]): string {
  const clock = (time?: number) => time === undefined ? '—' : new Date(time).toLocaleTimeString('en-GB', { hour12: false });
  return `${clock(entry.startedAt)}–${clock(entry.endedAt)}`;
}

function entryHtml(entry: TaskCommentaryArchive['entries'][number]): string {
  return `<p><b>${escapeTelegramHtml(interval(entry))}</b></p>${renderTelegramMarkdownRichHtml(entry.text)}`;
}

export function buildTelegramCommentaryArchive(archive: TaskCommentaryArchive): TelegramCommentaryArchive {
  const header = commentaryArchiveHeader(archive);
  const body = archive.entries.map(entryHtml).join('\n');
  const wrap = (content: string) => `<details><summary>${escapeTelegramHtml(header)}</summary>${content}</details>`;
  const html = wrap(body);
  // Conservative budgets also cover expanded entities and nested list blocks.
  const blocks = (html.match(/<(?:p|h[1-6]|pre|ul|ol|li|blockquote|details)\b/g) ?? []).length;
  if (html.length <= 30000 && blocks <= 450) return { html };

  const zh = archive.locale === 'zh';
  const preview = archive.entries.slice(0, 3).map(entry => entryHtml({ ...entry, text: entry.text.length > 600 ? `${entry.text.slice(0, 600)}…` : entry.text })).join('\n');
  const label = zh ? '查看全部小结' : 'View all summaries';
  const fullDocument = `<!doctype html><html lang="${zh ? 'zh' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${label}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 20px;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f3f4f6;padding:12px}code{font-family:monospace}</style><body><h1>${escapeTelegramHtml(header)}</h1>${body}</body></html>`;
  return {
    html: wrap(`${preview}<p>${zh ? `共 ${archive.entries.length} 条小结，完整内容见下方文件。` : `${archive.entries.length} summaries; complete content in the file below.`}</p><figure><tg-document src="tg://document?id=commentary_archive"></tg-document><figcaption>${label}</figcaption></figure>`),
    document: { filename: zh ? '查看全部小结.html' : 'all-summaries.html', contents: Buffer.from(fullDocument), contentType: 'text/html' },
  };
}
