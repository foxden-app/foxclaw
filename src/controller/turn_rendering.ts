import { type RawExecCommandEvent, type TurnOutputKind } from './activity.js';
import type { AppLocale } from '../types.js';
import { TELEGRAM_RICH_MESSAGE_TEXT_LIMIT } from '../telegram/rich.js';
import { escapeTelegramHtml, telegramBold, telegramDetails, telegramExpandableBlockquote } from '../telegram/html.js';
import { renderTelegramMarkdownRichHtml } from '../telegram/rich_markdown.js';
import {
  ActiveTurn,
  ActiveTurnSegment,
  ToolBatchState,
  ToolBatchCounts,
  ArchivedStatusContent,
  TOOL_ARCHIVE_MAX_LINES,
  TOOL_ARCHIVE_LINE_LIMIT,
  ToolDescriptor,
} from './state_types.js';

export function ensureTurnSegment(
  active: ActiveTurn,
  itemId: string,
  phase?: string | null,
  outputKind?: TurnOutputKind,
  isPlan?: boolean,
): ActiveTurnSegment {
  let segment = active.segments.find((entry) => entry.itemId === itemId);
  if (segment) {
    if (phase !== undefined) {
      segment.phase = phase;
    }
    if (outputKind !== undefined) {
      segment.outputKind = outputKind;
    }
    if (isPlan !== undefined) {
      segment.isPlan = segment.isPlan || isPlan;
    }
    return segment;
  }
  segment = {
    itemId,
    phase: phase ?? null,
    outputKind: outputKind ?? 'commentary',
    isPlan: Boolean(isPlan),
    text: '',
    completed: false,
    startedAtMs: Date.now(),
    completedAtMs: null,
    messages: [],
    voiceSnippetId: null,
  };
  active.segments.push(segment);
  return segment;
}

export function renderCollapsedCommentary(locale: AppLocale, segments: ActiveTurnSegment[]): string {
  const firstAt = segments[0]?.startedAtMs ?? Date.now();
  const lastSegment = segments[segments.length - 1];
  const lastAt = lastSegment?.completedAtMs ?? lastSegment?.startedAtMs ?? firstAt;
  const range = firstAt === lastAt
    ? formatClockTimestamp(firstAt)
    : `${formatClockTimestamp(firstAt)} - ${formatClockTimestamp(lastAt)}`;
  const summary = locale === 'zh'
    ? `过程汇报 · ${segments.length} 条 · ${range}`
    : `Progress · ${segments.length} updates · ${range}`;
  const maxBodyLength = TELEGRAM_RICH_MESSAGE_TEXT_LIMIT - summary.length - 1024;
  const blocks: string[] = [];
  let bodyLength = 0;
  let omitted = 0;

  for (const segment of segments) {
    const endAt = segment.completedAtMs ?? segment.startedAtMs;
    const timestamp = endAt === segment.startedAtMs
      ? formatClockTimestamp(segment.startedAtMs)
      : `${formatClockTimestamp(segment.startedAtMs)} - ${formatClockTimestamp(endAt)}`;
    const block = `<h4>${escapeTelegramHtml(timestamp)}</h4>\n${renderTelegramMarkdownRichHtml(segment.text)}`;
    if (bodyLength + block.length > maxBodyLength) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
    bodyLength += block.length;
  }
  if (omitted > 0) {
    blocks.push(`<p>${escapeTelegramHtml(locale === 'zh' ? `另有 ${omitted} 条过长内容未收入归档` : `${omitted} oversized updates omitted`)}</p>`);
  }
  return telegramDetails(summary, blocks.join('\n'));
}

export function formatClockTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function createToolBatchState(): ToolBatchState {
  return {
    openCallIds: new Set<string>(),
    actionKeys: new Set<string>(),
    actionLines: [],
    counts: { files: 0, searches: 0, edits: 0, commands: 0 },
    finalizeTimer: null,
  };
}

export function incrementToolBatchCount(counts: ToolBatchCounts, kind: keyof ToolBatchCounts): void {
  counts[kind] += 1;
}

export function formatToolBatchStatus(
  locale: AppLocale,
  counts: ToolBatchCounts,
  actionLines: string[],
  inProgress: boolean,
): string {
  const heading = formatToolBatchHeading(locale, counts, inProgress);
  const detailLines = actionLines.slice(0, 6);
  if (detailLines.length === 0) {
    return heading;
  }
  return [heading, ...detailLines].join('\n');
}

export function renderArchivedToolBatchStatus(
  locale: AppLocale,
  counts: ToolBatchCounts,
  actionLines: string[],
): ArchivedStatusContent {
  const text = formatToolBatchStatus(locale, counts, actionLines, false);
  if (actionLines.length === 0) {
    return { text, html: null };
  }
  const heading = formatToolBatchHeading(locale, counts, false);
  const detailLines = actionLines
    .slice(0, TOOL_ARCHIVE_MAX_LINES)
    .map(line => truncateInline(line, TOOL_ARCHIVE_LINE_LIMIT));
  const html = [
    telegramBold(heading),
    telegramExpandableBlockquote(detailLines.join('\n')),
  ].join('\n');
  return { text, html };
}

export function formatToolBatchHeading(locale: AppLocale, counts: ToolBatchCounts, inProgress: boolean): string {
  const parts = formatToolBatchCountParts(locale, counts);
  const hasBrowse = counts.files > 0 || counts.searches > 0;
  const hasEdit = counts.edits > 0;
  const hasCommand = counts.commands > 0;
  let verb: string;
  if (hasEdit && !hasBrowse && !hasCommand) {
    verb = locale === 'zh' ? (inProgress ? '正在编辑' : '已编辑') : (inProgress ? 'Editing' : 'Edited');
  } else if (hasBrowse && !hasEdit && !hasCommand) {
    verb = locale === 'zh' ? (inProgress ? '正在浏览' : '已浏览') : (inProgress ? 'Browsing' : 'Browsed');
  } else if (hasCommand && !hasBrowse && !hasEdit) {
    verb = locale === 'zh' ? (inProgress ? '正在运行' : '已运行') : (inProgress ? 'Running' : 'Ran');
  } else {
    verb = locale === 'zh' ? (inProgress ? '正在处理' : '已处理') : (inProgress ? 'Processing' : 'Processed');
  }
  if (parts.length === 0) {
    return locale === 'zh'
      ? `${verb}操作...`
      : `${verb} operations...`;
  }
  return locale === 'zh'
    ? `${verb} ${parts.join('，')}`
    : `${verb} ${parts.join(', ')}`;
}

export function formatToolBatchCountParts(locale: AppLocale, counts: ToolBatchCounts): string[] {
  const parts: string[] = [];
  if (counts.files > 0) {
    parts.push(locale === 'zh' ? `${counts.files} 个文件` : pluralize(counts.files, 'file'));
  }
  if (counts.searches > 0) {
    parts.push(locale === 'zh' ? `${counts.searches} 个搜索` : pluralize(counts.searches, 'search'));
  }
  if (counts.edits > 0) {
    parts.push(locale === 'zh' ? `${counts.edits} 个编辑` : pluralize(counts.edits, 'edit'));
  }
  if (counts.commands > 0) {
    parts.push(locale === 'zh' ? `${counts.commands} 个命令` : pluralize(counts.commands, 'command'));
  }
  return parts;
}

export function pluralize(count: number, noun: string): string {
  if (count === 1) {
    return `1 ${noun}`;
  }
  const plural = noun === 'search'
    ? 'searches'
    : noun === 'file'
      ? 'files'
      : `${noun}s`;
  return `${count} ${plural}`;
}

export function describeExecCommand(event: RawExecCommandEvent): ToolDescriptor[] {
  const descriptors = (event.parsedCmd ?? [])
    .map((entry) => describeParsedCommand(entry))
    .filter((entry): entry is ToolDescriptor => entry !== null);
  if (descriptors.length > 0) {
    return descriptors;
  }
  const commandText = renderShellCommand(event.command);
  return [{
    kind: 'commands',
    key: `command:${commandText}`,
    line: `$ ${commandText}`,
  }];
}

export function describeParsedCommand(entry: any): ToolDescriptor | null {
  const type = typeof entry?.type === 'string' ? entry.type : '';
  const path = compactPath(entry?.path ?? entry?.name ?? null);
  const query = typeof entry?.query === 'string' ? entry.query : null;
  switch (type) {
    case 'search':
      return {
        kind: 'searches',
        key: `search:${path ?? '.'}:${query ?? ''}`,
        line: path ? `Searched for ${truncateInline(query || '', 80)} in ${path}` : `Searched for ${truncateInline(query || '', 80)}`,
      };
    case 'read':
      return {
        kind: 'files',
        key: `read:${path ?? 'unknown'}`,
        line: `Read ${path ?? 'file'}`,
      };
    case 'list_files':
      return {
        kind: 'files',
        key: `list:${path ?? 'workspace'}`,
        line: path ? `Listed ${path}` : 'Listed files',
      };
    case 'write':
    case 'edit':
    case 'apply_patch':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Edited ${path ?? 'files'}`,
      };
    case 'move':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Moved ${path ?? 'files'}`,
      };
    case 'copy':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Copied ${path ?? 'files'}`,
      };
    case 'delete':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Deleted ${path ?? 'files'}`,
      };
    case 'mkdir':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Created ${path ?? 'files'}`,
      };
    default:
      return null;
  }
}

export function compactPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  return value.replace(/^\.\//, '');
}

export function renderShellCommand(command: string[]): string {
  if (command.length >= 3 && (command[0] === '/bin/zsh' || command[0] === 'zsh') && command[1] === '-lc') {
    return command[2] ?? command.join(' ');
  }
  return command.join(' ');
}

export function truncateInline(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

export function extractLatestPlanMarkdown(active: ActiveTurn): string | null {
  const segmentPlan = extractLatestPlanSegmentMarkdown(active);
  if (segmentPlan) {
    return segmentPlan;
  }
  return extractLatestProposedPlanMarkdown(active);
}

export function extractLatestPlanSegmentMarkdown(active: ActiveTurn): string | null {
  for (let index = active.segments.length - 1; index >= 0; index -= 1) {
    const segment = active.segments[index]!;
    if (!segment.isPlan) {
      continue;
    }
    const text = segment.text.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

export function extractLatestProposedPlanMarkdown(active: ActiveTurn): string | null {
  return extractLatestProposedPlanBlock([
    active.finalText,
    active.buffer,
    ...active.segments.map(segment => segment.text),
  ].filter((text): text is string => typeof text === 'string' && text.length > 0).join('\n'));
}

export function extractLatestProposedPlanBlock(text: string): string | null {
  const pattern = /<proposed_plan\b[^>]*>([\s\S]*?)<\/proposed_plan>/gi;
  let latest: string | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const plan = match[1]?.trim();
    if (plan) {
      latest = plan;
    }
  }
  return latest;
}
