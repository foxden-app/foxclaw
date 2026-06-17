import { escapeTelegramHtml, telegramPreCode } from './html.js';

const SAFE_LINK_SCHEMES = /^(https?:|mailto:|tg:)/i;

export function renderTelegramMarkdownRichHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(telegramPreCode(codeLines.join('\n'), sanitizeCodeLanguage(fence[1] ?? '')));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min(4, Math.max(2, heading[1]!.length + 1));
      blocks.push(`<h${level}>${renderInlineRichHtml(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index]!)) {
        items.push(stripListMarker(lines[index]!, false));
        index += 1;
      }
      blocks.push(`<ul>${items.map(item => `<li>${renderInlineRichHtml(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index]!)) {
        items.push(stripListMarker(lines[index]!, true));
        index += 1;
      }
      blocks.push(`<ol>${items.map(item => `<li>${renderInlineRichHtml(item)}</li>`).join('')}</ol>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index]!)) {
        quoteLines.push(lines[index]!.replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(`<blockquote>${quoteLines.map(renderInlineRichHtml).join('<br>')}</blockquote>`);
      continue;
    }

    const paragraphLines = [line.trimEnd()];
    index += 1;
    while (
      index < lines.length
      && lines[index]!.trim()
      && !/^```/.test(lines[index]!)
      && !/^(#{1,4})\s+/.test(lines[index]!)
      && !/^\s*[-*+]\s+/.test(lines[index]!)
      && !/^\s*\d+[.)]\s+/.test(lines[index]!)
      && !/^\s*>\s?/.test(lines[index]!)
    ) {
      paragraphLines.push(lines[index]!.trimEnd());
      index += 1;
    }
    blocks.push(`<p>${renderInlineRichHtml(paragraphLines.join('\n'))}</p>`);
  }

  return blocks.join('\n') || '<p></p>';
}

export function renderInlineRichHtml(markdown: string): string {
  const tokens: string[] = [];
  const protectedText = markdown.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `{{FOXCLAW_RICH_CODE_${tokens.length}}}`;
    tokens.push(`<code>${escapeTelegramHtml(code)}</code>`);
    return token;
  });

  let html = escapeTelegramHtml(protectedText);
  html = html.replace(/\[([^\]\n]+)\]\(((?:[^()\s]+|\([^)\s]*\))+)\)/g, (_match, label: string, url: string) => {
    const normalizedUrl = unescapeHtmlAttribute(url);
    if (!SAFE_LINK_SCHEMES.test(normalizedUrl)) {
      return label;
    }
    return `<a href="${escapeTelegramHtmlAttribute(normalizedUrl)}">${label}</a>`;
  });
  html = html.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, '<b>$1</b>');
  html = html.replace(/__([^_\n][\s\S]*?[^_\n])__/g, '<b>$1</b>');
  html = html.replace(/\{\{FOXCLAW_RICH_CODE_(\d+)}}/g, (_match, tokenIndex: string) => tokens[Number(tokenIndex)] ?? '');
  return html.replaceAll('\n', '<br>');
}

function stripListMarker(line: string, ordered: boolean): string {
  return ordered
    ? line.replace(/^\s*\d+[.)]\s+/, '')
    : line.replace(/^\s*[-*+]\s+/, '');
}

function sanitizeCodeLanguage(language: string): string | undefined {
  const normalized = language.trim().replace(/[^A-Za-z0-9_+-]/g, '');
  return normalized || undefined;
}

function escapeTelegramHtmlAttribute(value: string): string {
  return escapeTelegramHtml(value).replaceAll('"', '&quot;');
}

function unescapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"');
}
