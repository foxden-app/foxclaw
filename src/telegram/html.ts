export function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeTelegramHtmlAttribute(value: string): string {
  return escapeTelegramHtml(value).replaceAll('"', '&quot;');
}

export function telegramBold(value: string): string {
  return `<b>${escapeTelegramHtml(value)}</b>`;
}

export function telegramCode(value: string): string {
  return `<code>${escapeTelegramHtml(value)}</code>`;
}

export function telegramPre(value: string): string {
  return `<pre>${escapeTelegramHtml(value)}</pre>`;
}

export function telegramPreCode(value: string, language?: string): string {
  const classAttr = language ? ` class="language-${escapeTelegramHtmlAttribute(language)}"` : '';
  return `<pre><code${classAttr}>${escapeTelegramHtml(value)}</code></pre>`;
}

export function telegramExpandableBlockquote(value: string): string {
  return `<blockquote expandable>${escapeTelegramHtml(value)}</blockquote>`;
}

export function telegramSpoiler(value: string): string {
  return `<tg-spoiler>${escapeTelegramHtml(value)}</tg-spoiler>`;
}

export function telegramDetails(summary: string, bodyHtml: string, open = false): string {
  return `<details${open ? ' open' : ''}><summary>${escapeTelegramHtml(summary)}</summary>${bodyHtml}</details>`;
}
