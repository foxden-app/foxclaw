import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../logger.js';
import type { AppLocale } from '../types.js';

export interface SubagentProgressInfo {
  conversationId: string;
  parentConversationId: string;
  agentName: string;
  role?: string | undefined;
  typeName?: string | undefined;
  status: 'running' | 'idle' | 'done';
  stepIndex: number;
  toolCount: number;
  currentTool: string | null;
  recentTools: string[];
  lastAction: string;
  lastContentPreview: string;
  updatedAt: number;
  completedAt?: number | undefined;
}

export interface SubagentToolEvent {
  subagentName: string;
  conversationId: string;
  toolName: string;
  args?: Record<string, unknown> | string | undefined;
  summary?: string | undefined;
  status: 'running' | 'completed' | 'failed';
  stepIndex?: number | undefined;
}

export interface SubagentPollResult {
  subagents: SubagentProgressInfo[];
  activeSubagents: SubagentProgressInfo[];
  newToolEvents: SubagentToolEvent[];
  hasUpdates: boolean;
}

export function cleanParameterValue(val: unknown): string {
  if (typeof val !== 'string') return '';
  let str = val.trim();
  if (str.startsWith('"') && str.endsWith('"') && str.length >= 2) {
    str = str.slice(1, -1).trim();
  }
  return str;
}

export function extractSubagentToolSummary(
  name: string,
  parameters?: Record<string, unknown> | string | undefined,
): string | undefined {
  if (!parameters) return undefined;
  let params: Record<string, unknown> = {};
  if (typeof parameters === 'string') {
    try {
      params = JSON.parse(parameters) as Record<string, unknown>;
    } catch {
      return parameters.slice(0, 60);
    }
  } else if (typeof parameters === 'object') {
    params = parameters;
  }

  const summary = cleanParameterValue(params.toolSummary);
  if (summary) return summary.slice(0, 60);

  const action = cleanParameterValue(params.toolAction);
  if (action) return action.slice(0, 60);

  const cmd = cleanParameterValue(params.CommandLine);
  if (cmd) return `$ ${cmd.slice(0, 70)}`;

  const targetFile = cleanParameterValue(params.TargetFile);
  if (targetFile) return path.basename(targetFile);

  const absPath = cleanParameterValue(params.AbsolutePath);
  if (absPath) return path.basename(absPath);

  const p = cleanParameterValue(params.path);
  if (p) return path.basename(p);

  const q = cleanParameterValue(params.query);
  if (q) return q.slice(0, 60);

  const url = cleanParameterValue(params.Url);
  if (url) return url.slice(0, 60);

  const prompt = cleanParameterValue(params.Prompt);
  if (prompt) return prompt.slice(0, 50);

  return undefined;
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface InternalSubagentState {
  info: SubagentProgressInfo;
  transcriptPath: string;
  fileOffset: number;
  remainder: string;
  seenToolKeys: Set<string>;
  lastRunningTool?: {
    toolName: string;
    summary?: string | undefined;
    stepIndex: number;
  } | null | undefined;
}

export class AntigravitySubagentTracker {
  private readonly baseDir: string;
  private readonly dbPath: string;
  private readonly logger: Logger | undefined;
  private readonly parentConversationId: string;
  private readonly subagents = new Map<string, InternalSubagentState>();
  private parentTranscriptOffset = 0;
  private parentTranscriptRemainder = '';

  constructor(parentConversationId: string, baseDir?: string, logger?: Logger) {
    this.parentConversationId = parentConversationId;
    this.baseDir = baseDir || path.join(os.homedir(), '.gemini', 'antigravity-cli');
    this.dbPath = path.join(this.baseDir, 'conversation_summaries.db');
    this.logger = logger;
  }

  get trackedCount(): number {
    return this.subagents.size;
  }

  getSubagents(): SubagentProgressInfo[] {
    return Array.from(this.subagents.values()).map((s) => ({ ...s.info }));
  }

  getActiveSubagents(): SubagentProgressInfo[] {
    return Array.from(this.subagents.values())
      .filter((s) => s.info.status === 'running')
      .map((s) => ({ ...s.info }));
  }

  getTranscriptPath(conversationId: string): string {
    return path.join(this.baseDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  /**
   * Discovers and polls active subagents for new steps, tool calls, and completion status.
   */
  async poll(): Promise<SubagentPollResult> {
    let hasUpdates = false;
    const newToolEvents: SubagentToolEvent[] = [];

    // 1. Discover subagents from SQLite database
    this.discoverSubagentsFromDb();

    // 2. Discover subagents from parent transcript.jsonl
    this.discoverSubagentsFromParentTranscript();

    // 3. Poll each tracked subagent's transcript
    for (const [subId, state] of this.subagents.entries()) {
      const updated = this.pollSubagentTranscript(state, newToolEvents);
      if (updated) {
        hasUpdates = true;
      }
    }

    const all = this.getSubagents();
    const active = all.filter((s) => s.status === 'running');

    return {
      subagents: all,
      activeSubagents: active,
      newToolEvents,
      hasUpdates,
    };
  }

  private discoverSubagentsFromDb(): void {
    if (!fs.existsSync(this.dbPath)) return;
    try {
      const db = new DatabaseSync(this.dbPath, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 2000;');

        // Discover direct subagents of parent, as well as nested subagents
        const parentIdsToQuery = [this.parentConversationId, ...Array.from(this.subagents.keys())];
        const placeholders = parentIdsToQuery.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT conversation_id, agent_name, status, not_fully_idle, killed, last_modified_time, parent_conversation_id
          FROM conversation_summaries
          WHERE parent_conversation_id IN (${placeholders}) AND killed = 0
          ORDER BY last_modified_time ASC
        `).all(...parentIdsToQuery) as Record<string, unknown>[];

        for (const r of rows) {
          const id = String(r.conversation_id);
          const parentId = String(r.parent_conversation_id || this.parentConversationId);
          const agentName = String(r.agent_name || 'Subagent');
          const isIdle = !r.not_fully_idle || r.status === 'CASCADE_RUN_STATUS_IDLE';

          if (!this.subagents.has(id)) {
            const transcriptPath = this.getTranscriptPath(id);
            this.subagents.set(id, {
              info: {
                conversationId: id,
                parentConversationId: parentId,
                agentName,
                status: isIdle ? 'done' : 'running',
                stepIndex: 0,
                toolCount: 0,
                currentTool: null,
                recentTools: [],
                lastAction: '',
                lastContentPreview: '',
                updatedAt: Date.now(),
              },
              transcriptPath,
              fileOffset: 0,
              remainder: '',
              seenToolKeys: new Set<string>(),
            });
          }
        }
      } finally {
        db.close();
      }
    } catch (err) {
      this.logger?.debug('antigravity.subagents.db_discovery_error', { error: String(err) });
    }
  }

  private discoverSubagentsFromParentTranscript(): void {
    const parentTranscript = this.getTranscriptPath(this.parentConversationId);
    if (!fs.existsSync(parentTranscript)) return;

    try {
      const stats = fs.statSync(parentTranscript);
      if (stats.size < this.parentTranscriptOffset) {
        this.parentTranscriptOffset = 0;
        this.parentTranscriptRemainder = '';
      }
      if (stats.size === this.parentTranscriptOffset) return;

      const bytesToRead = stats.size - this.parentTranscriptOffset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(parentTranscript, 'r');
      try {
        fs.readSync(fd, buffer, 0, bytesToRead, this.parentTranscriptOffset);
      } finally {
        fs.closeSync(fd);
      }

      this.parentTranscriptOffset = stats.size;
      const chunk = this.parentTranscriptRemainder + buffer.toString('utf8');
      const lines = chunk.split('\n');
      this.parentTranscriptRemainder = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          this.extractSubagentsFromTranscriptEntry(entry, this.parentConversationId);
        } catch {
          // ignore malformed lines
        }
      }
    } catch (err) {
      this.logger?.debug('antigravity.subagents.parent_transcript_error', { error: String(err) });
    }
  }

  private extractSubagentsFromTranscriptEntry(entry: any, parentId: string): void {
    // 1. Check tool_calls for invoke_subagent
    if (Array.isArray(entry.tool_calls)) {
      for (const tc of entry.tool_calls) {
        if (tc.name === 'invoke_subagent' && tc.args) {
          let subagentsArg = tc.args.Subagents;
          if (typeof subagentsArg === 'string') {
            try {
              subagentsArg = JSON.parse(subagentsArg);
            } catch {
              // ignore
            }
          }
          if (Array.isArray(subagentsArg)) {
            for (const sub of subagentsArg) {
              const name = sub.Role || sub.TypeName || 'Subagent';
              // Stored as pending hints if needed
            }
          }
        }
      }
    }

    // 2. Check generic content or output for Created the following subagents
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (content.includes('Created the following subagents') || content.includes('conversationId')) {
      const convMatches = content.matchAll(/"conversationId":\s*"([0-9a-fA-F-]{36})"/g);
      for (const match of convMatches) {
        const subId = match[1];
        if (subId && subId !== this.parentConversationId && !this.subagents.has(subId)) {
          const transcriptPath = this.getTranscriptPath(subId);
          this.subagents.set(subId, {
            info: {
              conversationId: subId,
              parentConversationId: parentId,
              agentName: 'Subagent',
              status: 'running',
              stepIndex: 0,
              toolCount: 0,
              currentTool: null,
              recentTools: [],
              lastAction: '',
              lastContentPreview: '',
              updatedAt: Date.now(),
            },
            transcriptPath,
            fileOffset: 0,
            remainder: '',
            seenToolKeys: new Set<string>(),
          });
        }
      }
    }
  }

  private pollSubagentTranscript(state: InternalSubagentState, newToolEvents: SubagentToolEvent[]): boolean {
    if (!fs.existsSync(state.transcriptPath)) {
      return false;
    }

    try {
      const stats = fs.statSync(state.transcriptPath);
      if (stats.size < state.fileOffset) {
        state.fileOffset = 0;
        state.remainder = '';
      }
      if (stats.size === state.fileOffset) {
        return false;
      }

      const bytesToRead = stats.size - state.fileOffset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(state.transcriptPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, bytesToRead, state.fileOffset);
      } finally {
        fs.closeSync(fd);
      }

      state.fileOffset = stats.size;
      const chunk = state.remainder + buffer.toString('utf8');
      const lines = chunk.split('\n');
      state.remainder = lines.pop() ?? '';

      let hasUpdates = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: any;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue;
        }

        // Check if subagent spawned a nested subagent
        this.extractSubagentsFromTranscriptEntry(entry, state.info.conversationId);

        if (typeof entry.step_index === 'number') {
          state.info.stepIndex = entry.step_index;
        }

        if (entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
          // Task description received
          hasUpdates = true;
          state.info.updatedAt = Date.now();
        }

        if (entry.type === 'GENERIC') {
          hasUpdates = true;
          state.info.updatedAt = Date.now();
          if (state.lastRunningTool) {
            newToolEvents.push({
              subagentName: state.info.agentName,
              conversationId: state.info.conversationId,
              toolName: state.lastRunningTool.toolName,
              summary: state.lastRunningTool.summary,
              status: entry.status === 'ERROR' ? 'failed' : 'completed',
              stepIndex: state.lastRunningTool.stepIndex,
            });
            state.lastRunningTool = null;
            state.info.currentTool = null;
          }
        }

        if (entry.type === 'PLANNER_RESPONSE') {
          hasUpdates = true;
          state.info.updatedAt = Date.now();

          if (typeof entry.content === 'string' && entry.content.trim()) {
            state.info.lastContentPreview = entry.content.trim().slice(-300);
          }

          if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
            for (const tc of entry.tool_calls) {
              const toolName = tc.name || 'tool';
              const toolKey = `${state.info.stepIndex}:${toolName}:${JSON.stringify(tc.args || {})}`;

              if (!state.seenToolKeys.has(toolKey)) {
                state.seenToolKeys.add(toolKey);
                state.info.toolCount += 1;

                if (state.lastRunningTool) {
                  newToolEvents.push({
                    subagentName: state.info.agentName,
                    conversationId: state.info.conversationId,
                    toolName: state.lastRunningTool.toolName,
                    summary: state.lastRunningTool.summary,
                    status: 'completed',
                    stepIndex: state.lastRunningTool.stepIndex,
                  });
                  state.lastRunningTool = null;
                }

                if (toolName === 'send_message') {
                  state.info.status = 'done';
                  state.info.completedAt = Date.now();
                  state.info.lastAction = '✅ 完成任务并回传结果给主 Agent';
                  state.info.currentTool = null;
                } else {
                  const summary = extractSubagentToolSummary(toolName, tc.args);
                  const displayDesc = summary ? ` · <i>${escapeTelegramHtml(summary)}</i>` : '';
                  const toolLine = `⚙️ <code>${escapeTelegramHtml(toolName)}</code>${displayDesc}`;

                  state.info.recentTools.push(toolLine);
                  state.info.currentTool = summary ? `${toolName} (${summary})` : toolName;
                  state.info.lastAction = summary ? `${toolName}: ${summary}` : toolName;

                  state.lastRunningTool = {
                    toolName,
                    summary,
                    stepIndex: state.info.stepIndex,
                  };

                  newToolEvents.push({
                    subagentName: state.info.agentName,
                    conversationId: state.info.conversationId,
                    toolName,
                    args: tc.args,
                    summary,
                    status: 'running',
                    stepIndex: state.info.stepIndex,
                  });
                }
              }
            }
          }

          // If entry is DONE and was send_message, subagent is finished
          if (entry.status === 'DONE' && state.info.status === 'done') {
            newToolEvents.push({
              subagentName: state.info.agentName,
              conversationId: state.info.conversationId,
              toolName: 'completed',
              summary: 'Subagent finished',
              status: 'completed',
              stepIndex: state.info.stepIndex,
            });
          }
        }
      }

      return hasUpdates;
    } catch (err) {
      this.logger?.debug('antigravity.subagent.poll_error', {
        conversationId: state.info.conversationId,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * Renders subagent progress for Telegram messages (watch mode or stream preview).
   */
  renderTelegramBlock(locale: AppLocale = 'zh'): string {
    const all = this.getSubagents();
    if (all.length === 0) return '';

    const lines: string[] = [];
    const activeCount = all.filter((s) => s.status === 'running').length;
    const headerTitle =
      locale === 'zh'
        ? `🤖 <b>子 Agent 实时动态 (${activeCount > 0 ? `${activeCount} 个执行中` : `共 ${all.length} 个已完成`})</b>`
        : `🤖 <b>Subagent Activity (${activeCount > 0 ? `${activeCount} running` : `${all.length} completed`})</b>`;

    lines.push(headerTitle);

    for (const sub of all) {
      const isDone = sub.status === 'done';
      const icon = isDone ? '✅' : '🔄';
      const statusText = isDone
        ? (locale === 'zh' ? '已完成' : 'Completed')
        : (locale === 'zh' ? `步骤 #${sub.stepIndex} · 已执行 ${sub.toolCount} 项工具` : `Step #${sub.stepIndex} · ${sub.toolCount} tools`);

      const name = escapeTelegramHtml(sub.agentName || 'Subagent');
      lines.push(`${icon} <b>[${name}]</b> <i>(${statusText})</i>`);

      if (!isDone && sub.currentTool) {
        lines.push(`  ⚙️ <b>正在执行</b>: <code>${escapeTelegramHtml(sub.currentTool)}</code>`);
      } else if (isDone && sub.lastAction) {
        lines.push(`  ↳ <i>${escapeTelegramHtml(sub.lastAction)}</i>`);
      }

      if (sub.recentTools.length > 0) {
        const recent = sub.recentTools.slice(-3);
        for (const t of recent) {
          lines.push(`  ↳ ${t}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * One-line summary of what active subagents are currently doing.
   */
  getActiveSummaryLine(locale: AppLocale = 'zh'): string | null {
    const active = this.getActiveSubagents();
    if (active.length === 0) return null;

    const first = active[0]!;
    const name = first.agentName || 'Subagent';
    const action = first.currentTool || first.lastAction || (locale === 'zh' ? '正在执行' : 'Working');
    return locale === 'zh'
      ? `🤖 子 Agent [${name}] 正在执行: ${action}…`
      : `🤖 Subagent [${name}] running: ${action}…`;
  }
}
