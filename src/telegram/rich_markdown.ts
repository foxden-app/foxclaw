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

    const list = parseListMarker(line);
    if (list) {
      const rendered = consumeList(lines, index, list.indent, list.ordered);
      blocks.push(rendered.html);
      index = rendered.nextIndex;
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
      && !parseListMarker(lines[index]!)
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

function consumeList(
  lines: string[],
  startIndex: number,
  indent: number,
  ordered: boolean,
): { html: string; nextIndex: number } {
  const items: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const marker = parseListMarker(lines[index]!);
    if (!marker || marker.indent < indent) {
      break;
    }
    if (marker.indent > indent) {
      break;
    }
    if (marker.ordered !== ordered) {
      break;
    }

    let itemHtml = renderInlineRichHtml(marker.text);
    index += 1;

    while (index < lines.length) {
      const nested = parseListMarker(lines[index]!);
      if (!nested || nested.indent <= indent) {
        break;
      }
      const rendered = consumeList(lines, index, nested.indent, nested.ordered);
      itemHtml += rendered.html;
      index = rendered.nextIndex;
    }

    items.push(`<li>${itemHtml}</li>`);
  }

  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.join('')}</${tag}>`, nextIndex: index };
}

function parseListMarker(line: string): { indent: number; ordered: boolean; text: string } | null {
  const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
  if (ordered) {
    return {
      indent: ordered[1]!.replaceAll('\t', '    ').length,
      ordered: true,
      text: ordered[2]!,
    };
  }
  const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (unordered) {
    return {
      indent: unordered[1]!.replaceAll('\t', '    ').length,
      ordered: false,
      text: unordered[2]!,
    };
  }
  return null;
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
