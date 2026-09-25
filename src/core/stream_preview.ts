export interface StreamPreviewState {
  toolLines: string[];
  accumulatedText: string;
  isBoost?: boolean;
  engineName?: string;
}

export function renderStreamPreviewContent(state: StreamPreviewState): string {
  const parts: string[] = [];

  if (state.toolLines.length > 0) {
    const recent = state.toolLines.slice(-6);
    parts.push(
      `<blockquote expandable>🛠️ <b>正在调用工具 (${state.toolLines.length} 项)</b>\n${recent.join('\n')}</blockquote>`,
    );
    parts.push('');
  }

  if (state.accumulatedText) {
    const preview = state.accumulatedText.slice(-3000);
    parts.push(preview);
  } else {
    const name = state.engineName || 'AI';
    parts.push(state.isBoost ? `🚀 ${name} (Boost 模式) 正在深度思考中…` : `⏳ ${name} 正在思考中…`);
  }

  return parts.join('\n');
}
