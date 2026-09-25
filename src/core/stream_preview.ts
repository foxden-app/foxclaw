export interface StreamPreviewState {
  toolLines: string[];
  accumulatedText: string;
  isBoost?: boolean | undefined;
  engineName?: string | undefined;
  stepIndex?: number | undefined;
  toolCount?: number | undefined;
  currentTool?: string | null | undefined;
  elapsedSeconds?: number | undefined;
}

export function renderStreamPreviewContent(state: StreamPreviewState): string {
  const parts: string[] = [];
  const name = state.engineName || 'AI';

  const roundText = state.stepIndex && state.stepIndex > 0 ? `第 ${state.stepIndex} 轮` : '';
  const toolText = typeof state.toolCount === 'number' && state.toolCount > 0 ? `累计执行 ${state.toolCount} 次工具` : '';
  const timeText = typeof state.elapsedSeconds === 'number' && state.elapsedSeconds > 0 ? `已耗时 ${state.elapsedSeconds}s` : '';
  const meta = [roundText, toolText, timeText].filter(Boolean).join(' · ');

  if (meta || state.currentTool || state.toolLines.length > 0) {
    if (state.isBoost) {
      parts.push(`🚀 <b>${name} (Boost 模式) 正在执行中</b>${meta ? ` (${meta})` : ''}`);
    } else {
      parts.push(`🔄 <b>${name} 正在执行中</b>${meta ? ` (${meta})` : ''}`);
    }
  }

  if (state.currentTool) {
    parts.push(`⚙️ <b>当前正在运行</b>: <code>${escapeTelegramHtml(state.currentTool)}</code>`);
    parts.push('');
  }

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
    parts.push(state.isBoost ? `🚀 ${name} (Boost 模式) 正在深度思考中…` : `⏳ ${name} 正在思考中…`);
  }

  return parts.join('\n');
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
