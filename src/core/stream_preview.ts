import type { AppLocale } from '../types.js';
import { formatMetricTokenCount } from '../store/token_usage.js';
import { chunkTelegramMessage } from '../telegram/text.js';

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

export interface FoldedToolsSummaryOptions {
  stepIndex?: number | undefined;
  toolLines?: string[] | undefined;
  toolCount?: number | undefined;
  startTime?: number | undefined;
  durationSeconds?: number | undefined;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cachedTokens?: number | undefined;
    totalTokens?: number | undefined;
  } | undefined;
  locale?: AppLocale | undefined;
}

export function formatElapsedDuration(seconds: number, locale: AppLocale = 'zh'): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 60) return locale === 'zh' ? `${seconds}秒` : `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) {
    return locale === 'zh'
      ? `${mins}分${secs > 0 ? `${secs}秒` : ''}`
      : `${mins}m${secs > 0 ? ` ${secs}s` : ''}`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return locale === 'zh'
    ? `${hours}小时${remMins > 0 ? `${remMins}分` : ''}`
    : `${hours}h${remMins > 0 ? ` ${remMins}m` : ''}`;
}

export function buildFoldedToolsSummary(options: FoldedToolsSummaryOptions): string {
  const {
    stepIndex,
    toolLines = [],
    toolCount = toolLines.length,
    startTime,
    durationSeconds,
    usage,
    locale = 'zh',
  } = options;

  if (toolCount === 0 && (!stepIndex || stepIndex <= 1) && !usage) {
    return '';
  }

  const roundText = stepIndex && stepIndex > 1
    ? (locale === 'zh' ? ` · 共 ${stepIndex} 轮` : ` · ${stepIndex} turns`)
    : '';
  const toolText = toolCount > 0
    ? (locale === 'zh' ? ` · 累计执行 ${toolCount} 次工具` : ` · ${toolCount} tools`)
    : '';

  let durationText = '';
  const elapsedSec = typeof durationSeconds === 'number' && durationSeconds > 0
    ? durationSeconds
    : startTime
      ? Math.max(1, Math.round((Date.now() - startTime) / 1000))
      : 0;
  if (elapsedSec > 0) {
    durationText = locale === 'zh'
      ? ` · 耗时 ${formatElapsedDuration(elapsedSec, 'zh')}`
      : ` · in ${formatElapsedDuration(elapsedSec, 'en')}`;
  }

  // Header line
  const header = `🛠️ <b>${locale === 'zh' ? '执行小结' : 'Execution Summary'}${roundText}${toolText}${durationText}</b>`;

  // Token line
  let usageLine = '';
  if (usage && (usage.totalTokens || usage.inputTokens || usage.outputTokens || usage.cachedTokens)) {
    const totalVal = usage.totalTokens || ((usage.inputTokens || 0) + (usage.outputTokens || 0));
    const total = formatMetricTokenCount(totalVal);
    const input = formatMetricTokenCount(usage.inputTokens || 0);
    const output = formatMetricTokenCount(usage.outputTokens || 0);
    const cached = formatMetricTokenCount(usage.cachedTokens || 0);
    if (locale === 'zh') {
      usageLine = `\n🪙 <b>Token 消耗</b>: 总计 ${total} (输入 ${input} · 输出 ${output} · 缓存 ${cached})`;
    } else {
      usageLine = `\n🪙 <b>Token Usage</b>: Total ${total} (Input ${input} · Output ${output} · Cached ${cached})`;
    }
  }

  // Tool detail section:
  // If toolLines <= 25 (e.g. 10-20 step summaries in Codex/AGY): preserve ALL of them!
  // If toolLines > 25 (e.g. 100+ raw tool calls): keep first 3 + omitted notice + last 15.
  let toolDetailSection = '';
  if (toolLines.length > 0) {
    let previewLines: string[] = [];
    if (toolLines.length <= 25) {
      previewLines = toolLines;
    } else {
      const head = toolLines.slice(0, 3);
      const tail = toolLines.slice(-15);
      const omitted = toolCount - (head.length + tail.length);
      const omittedNote = omitted > 0
        ? `<i>${locale === 'zh' ? `(中间 ${omitted} 项历史工具调用已折叠收起)` : `(${omitted} intermediate tools collapsed)`}</i>`
        : '';
      previewLines = [...head, omittedNote, ...tail].filter(Boolean);
    }
    toolDetailSection = `\n\n<i>${locale === 'zh' ? '工具调用记录:' : 'Tool calls:'}</i>\n${previewLines.join('\n')}`;
  }

  return `<blockquote expandable>${header}${usageLine}${toolDetailSection}</blockquote>\n\n`;
}

export function combineSummaryAndResponse(
  foldedSummary: string,
  responseText: string,
  limit = 4000,
): string[] {
  const content = (responseText || '(无输出 / No output)').trim();
  if (!foldedSummary) {
    return chunkTelegramMessage(content, limit);
  }

  const combined = `${foldedSummary}${content}`;
  if (combined.length <= limit) {
    return [combined];
  }

  // Combined exceeds limit: chunk responseText cleanly without tearing foldedSummary apart!
  const remainingInFirstChunk = limit - foldedSummary.length;
  if (remainingInFirstChunk >= 300) {
    const window = content.slice(0, remainingInFirstChunk);
    const splitAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (splitAt >= Math.floor(remainingInFirstChunk / 3)) {
      const firstChunkText = content.slice(0, splitAt + 1).trim();
      const rest = content.slice(splitAt + 1).trim();
      const restChunks = chunkTelegramMessage(rest, limit);
      return [`${foldedSummary}${firstChunkText}`, ...restChunks];
    }
  }

  // If foldedSummary takes up most of the message or no clean paragraph break was found,
  // foldedSummary gets its own clean message, and responseText is chunked independently.
  const responseChunks = chunkTelegramMessage(content, limit);
  return [foldedSummary.trim(), ...responseChunks];
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
