export function chunkMessage(text: string, limit = 4000, fallbackText = 'Completed.'): string[] {
  const source = text.trim() ? text : fallbackText;
  if (!source) {
    return [];
  }
  if (source.length <= limit) {
    return [source];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    const remaining = source.length - start;
    if (remaining <= limit) {
      chunks.push(source.slice(start));
      break;
    }

    const tentativeEnd = start + limit;
    const window = source.slice(start, tentativeEnd);
    const splitAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    const end = splitAt >= Math.floor(limit / 2)
      ? start + splitAt + 1
      : tentativeEnd;

    chunks.push(source.slice(start, end));
    start = end;
  }

  return chunks.filter(chunk => chunk.length > 0);
}


export function escapeHtml(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
