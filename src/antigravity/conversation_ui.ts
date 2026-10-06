import { AGY_OPEN_CALLBACK_PREFIX, AGY_SETUP_CALLBACK_PREFIX, AGY_WATCH_CALLBACK_PREFIX } from './ui_callbacks.js';
import type { AppLocale } from '../types.js';
import { type InlineKeyboard } from '../channels/telegram/telegram_messaging_port.js';
import { formatAge, type AntigravityConversation } from './conversations.js';
import path from 'node:path';
import fs from 'node:fs';
import { AntigravitySubagentTracker } from './subagents.js';
import { escapeTelegramHtml } from '../telegram/html.js';
import { chunkTelegramMessage } from '../telegram/text.js';
import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { BackendUiHost } from '../core/backend_ui.js';
import type { IEngineAdapter } from '../core/engine_spi.js';
import type { AntigravityConversationManager } from './conversations.js';

interface PanelUi { sendMessage: BackendUiHost['sendMessage']; editMessage: BackendUiHost['editMessage']; scheduleStalePanelDeletion: BackendUiHost['scheduleStalePanelDeletion']; }
interface ExecutionView { syncCurrentBackendSettings(scopeId: string): void; hasActiveTurn(scopeId: string): boolean; getAdapterForScope(scopeId: string): IEngineAdapter; }

export interface AntigravityWatcher {
  scopeId: string;
  conversationId: string;
  transcriptPath: string;
  fileOffset: number;
  remainder: string;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  messageId: number | null;
  currentToolLines: string[];
  lastContentPreview: string;
  subagentTracker: AntigravitySubagentTracker;
}

export class AntigravityConversationUi {
  private readonly watchers = new Map<string, AntigravityWatcher>();
  private readonly polls = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly config: AppConfig, private readonly store: BridgeStore, private readonly logger: Logger, private readonly conversations: AntigravityConversationManager, private readonly ui: PanelUi, private readonly orchestrator: ExecutionView) {}

  async sendThreadsPanel(
    scopeId: string,
    search: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    const boundThreadId = this.store.getBinding(scopeId)?.threadId;
    const list = this.conversations.listConversations(10, search);

    if (list.length === 0) {
      const emptyText =
        locale === 'zh'
          ? `📁 **Antigravity 会话列表**\n\n暂无历史会话。发送任意消息或执行 \`/new\` 即可创建。`
          : `📁 **Antigravity Conversations**\n\nNo history found. Send a message or run \`/new\` to create one.`;
      const emptyKb: InlineKeyboard = [
        [{ text: '✨ 新建会话', callback_data: 'engine:setup:new' }],
        [{ text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' }],
      ];
      if (editMessageId) {
        await this.ui.editMessage(scopeId, editMessageId, emptyText, emptyKb);
      } else {
        await this.ui.sendMessage(scopeId, emptyText, emptyKb);
      }
      return;
    }

    // Cache threads in database so `/open <idx>` works
    this.store.cacheThreadList(
      scopeId,
      list.map((c, i) => ({
        listIndex: i + 1,
        threadId: c.conversationId,
        name: c.title,
        preview: c.preview,
        cwd: c.workspaceDir ?? this.config.defaultCwd,
        modelProvider: 'antigravity',
        status: 'idle',
        updatedAt: c.updatedAt,
      })),
    );

    const currentWatcher = this.watchers.get(scopeId);
    const watchingThreadId = currentWatcher && !currentWatcher.stopped ? currentWatcher.conversationId : null;

    const lines: string[] = [
      locale === 'zh' ? `📁 **Antigravity 会话列表**：` : `📁 **Antigravity Conversations**:`,
      '',
    ];

    const keyboard: InlineKeyboard = [];

    list.forEach((session, idx) => {
      const isCurrent = session.conversationId === boundThreadId;
      const isWatching = session.conversationId === watchingThreadId;
      const marker = isCurrent ? '●' : '○';
      const short = session.conversationId.slice(0, 8);
      const dir = session.workspaceDir ?? this.config.defaultCwd;
      const age = formatAge(session.updatedAt, locale);
      const watchBadge = isWatching ? ' [👁 观察中]' : '';

      lines.push(`${marker} **${idx + 1}.** ${session.title}${watchBadge}`);
      lines.push(`   \`${short}\` · \`${dir}\` · ${age}`);

      if (idx < 8) {
        const dirName = path.basename(dir || this.config.defaultCwd);
        const titleSnippet = session.title ? session.title.replace(/\s+/g, ' ') : 'Untitled';
        const openText = `${isCurrent ? '✅ ' : ''}${idx + 1}. ${dirName}|${titleSnippet.length > 32 ? titleSnippet.slice(0, 31) + '…' : titleSnippet}`;
        keyboard.push([
          {
            text: openText,
            callback_data: `${AGY_OPEN_CALLBACK_PREFIX}${session.conversationId}`,
          },
        ]);
        keyboard.push([
          { text: '✏️', callback_data: `agy:rename:${session.conversationId}` },
          { text: isWatching ? '👁 监视' : '👀', callback_data: `${AGY_WATCH_CALLBACK_PREFIX}${session.conversationId}` },
          { text: '🗑️', callback_data: `agy:archive:${session.conversationId}` },
          { text: '➕', callback_data: `agy:new:${session.conversationId}` },
        ]);
      }
    });

    if (watchingThreadId) {
      keyboard.push([
        {
          text: locale === 'zh' ? '🛑 停止观察当前会话 (/unwatch)' : '🛑 Stop watching (/unwatch)',
          callback_data: `${AGY_WATCH_CALLBACK_PREFIX}stop`,
        },
      ]);
    }

    lines.push(
      '',
      locale === 'zh'
        ? `• 点击名称切换会话；\n• 点击快捷按钮：\`[✏️ 重命名]\` \`[👀 观察]\` \`[🗑️ 归档]\` \`[➕ 新建分支]\`；\n• 命令行：\`/open <编号>\`，\`/watch <编号>\`，\`/unwatch\`，\`/new\`。`
        : `• Tap name to bind conversation;\n• Tap actions: \`[✏️ Rename]\` \`[👀 Watch]\` \`[🗑️ Archive]\` \`[➕ Fork]\`;\n• Commands: \`/open <num>\`, \`/watch <num>\`, \`/unwatch\`, \`/new\`.`,
    );

    keyboard.push([
      { text: '➕ 新建', callback_data: 'engine:setup:new' },
      { text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' },
    ]);

    const content = lines.join('\n');
    if (editMessageId) {
      await this.ui.editMessage(scopeId, editMessageId, content, keyboard);
      this.ui.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.ui.sendMessage(scopeId, content, keyboard);
      this.ui.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }

  async openThread(
    scopeId: string,
    rawTarget: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    if (!rawTarget) {
      await this.ui.sendMessage(
        scopeId,
        locale === 'zh'
          ? '用法：`/open <编号|会话ID>`。例如 `/open 1`。可使用 `/threads` 查看有效编号。'
          : 'Usage: `/open <number|conversation-id>`. Use `/threads` to list.',
      );
      return;
    }

    const conv = this.conversations.resolveConversation(rawTarget, scopeId, this.store);
    if (!conv) {
      await this.ui.sendMessage(
        scopeId,
        locale === 'zh'
          ? `❌ 未找到会话 \`${rawTarget}\`。请使用 \`/threads\` 查看会话列表。`
          : `❌ Conversation \`${rawTarget}\` not found. Use \`/threads\` to list.`,
      );
      return;
    }

    const targetCwd = conv.workspaceDir || this.config.defaultCwd;
    this.store.setBinding(scopeId, conv.conversationId, targetCwd);

    const currentWatcher = this.watchers.get(scopeId);
    let watchNoteZh = '';
    let watchNoteEn = '';
    if (currentWatcher && !currentWatcher.stopped) {
      watchNoteZh = `\n• **当前观察**: \`${currentWatcher.conversationId.slice(0, 8)}\``;
      watchNoteEn = `\n• **Watching**: \`${currentWatcher.conversationId.slice(0, 8)}\``;
    }

    const text =
      locale === 'zh'
        ? `✅ **已切换绑定到既有 Antigravity 会话**\n\n` +
          `• **标题**: ${conv.title}\n` +
          `• **会话 ID**: \`${conv.conversationId}\`\n` +
          `• **工作目录**: \`${targetCwd}\`\n` +
          `• **更新时间**: ${formatAge(conv.updatedAt, 'zh')}` +
          watchNoteZh +
          `\n\n后续消息将在此会话继续执行。`
        : `✅ **Switched to Antigravity Conversation**\n\n` +
          `• **Title**: ${conv.title}\n` +
          `• **ID**: \`${conv.conversationId}\`\n` +
          `• **Directory**: \`${targetCwd}\`\n` +
          `• **Updated**: ${formatAge(conv.updatedAt, 'en')}` +
          watchNoteEn +
          `\n\nNext messages will continue in this conversation.`;

    const keyboard: InlineKeyboard = [
      [{ text: '👁 开启实时观察 (/watch)', callback_data: `${AGY_WATCH_CALLBACK_PREFIX}${conv.conversationId}` }],
      [
        { text: '📁 查看其他会话', callback_data: `${AGY_SETUP_CALLBACK_PREFIX}threads` },
        { text: '⚙️ 控制面板', callback_data: 'engine:setup:main' },
      ],
    ];

    if (editMessageId) {
      await this.ui.editMessage(scopeId, editMessageId, text, keyboard);
    } else {
      await this.ui.sendMessage(scopeId, text, keyboard);
    }
  }

  async watchConversation(
    scopeId: string,
    rawTarget: string,
    locale: AppLocale,
    editMessageId?: number,
    notify = true,
  ): Promise<void> {
    let conv: AntigravityConversation | null = null;
    if (rawTarget) {
      conv = this.conversations.resolveConversation(rawTarget, scopeId, this.store);
    } else {
      const boundThreadId = this.store.getBinding(scopeId)?.threadId;
      if (boundThreadId) {
        conv = this.conversations.getConversation(boundThreadId);
      }
    }

    if (!conv) {
      if (notify) {
        await this.ui.sendMessage(
          scopeId,
          locale === 'zh'
            ? `❌ 未找到指定会话进行观察。用法：\`/watch <编号|会话ID>\`，或使用 \`/threads\` 选择。`
            : `❌ Conversation not found. Usage: \`/watch <num|id>\` or check \`/threads\`.`,
        );
      }
      return;
    }

    const transcriptPath = this.conversations.getTranscriptPath(conv.conversationId);
    if (!transcriptPath) {
      if (notify) {
        await this.ui.sendMessage(
          scopeId,
          locale === 'zh'
            ? `⚠️ 会话 \`${conv.conversationId.slice(0, 8)}\` 暂无本地日志文件，无法进入实时观察模式。`
            : `⚠️ No transcript log found for \`${conv.conversationId.slice(0, 8)}\`.`,
        );
      }
      return;
    }

    // Stop existing watcher for this scope if any
    const existing = this.watchers.get(scopeId);
    if (existing) {
      existing.stopped = true;
      if (existing.timer) clearTimeout(existing.timer);
    }

    // Seek to end of file initially to only tail new entries
    let initialOffset = 0;
    try {
      if (fs.existsSync(transcriptPath)) {
        initialOffset = fs.statSync(transcriptPath).size;
      }
    } catch {
      /* ignore */
    }

    const watcher: AntigravityWatcher = {
      scopeId,
      conversationId: conv.conversationId,
      transcriptPath,
      fileOffset: initialOffset,
      remainder: '',
      timer: null,
      stopped: false,
      messageId: null,
      currentToolLines: [],
      lastContentPreview: '',
      subagentTracker: new AntigravitySubagentTracker(conv.conversationId, undefined, this.logger),
    };

    if (this.closed) return;
    this.watchers.set(scopeId, watcher);
    this.store.setWatchedThread(scopeId, conv.conversationId);

    if (notify) {
      const keyboard: InlineKeyboard = [
        [{ text: '🛑 停止观察 (/unwatch)', callback_data: `${AGY_WATCH_CALLBACK_PREFIX}stop` }],
        [
          { text: '📁 会话列表', callback_data: `${AGY_SETUP_CALLBACK_PREFIX}threads` },
          { text: '⚙️ 控制面板', callback_data: 'engine:setup:main' },
        ],
      ];

      const text =
        locale === 'zh'
          ? `👁 **已开启实时观察会话**\n\n` +
            `• **会话标题**: ${conv.title}\n` +
            `• **会话 ID**: \`${conv.conversationId}\`\n` +
            `• **工作目录**: \`${conv.workspaceDir || this.config.defaultCwd}\`\n` +
            `• **日志路径**: \`${transcriptPath}\`\n\n` +
            `现在开始，外部终端或其他客户端在此会话产生的步骤、工具调用和回复将实时同步至 Telegram。\n\n` +
            `发送 \`/unwatch\` 或点击下方按钮可随时退出观察。`
          : `👁 **Started Watching Conversation**\n\n` +
            `• **Title**: ${conv.title}\n` +
            `• **ID**: \`${conv.conversationId}\`\n` +
            `• **Directory**: \`${conv.workspaceDir || this.config.defaultCwd}\`\n` +
            `• **Log**: \`${transcriptPath}\`\n\n` +
            `Now monitoring new turns, tools, and responses in real-time.\n\n` +
            `Send \`/unwatch\` or tap below to stop.`;

      if (editMessageId) {
        await this.ui.editMessage(scopeId, editMessageId, text, keyboard);
      } else {
        await this.ui.sendMessage(scopeId, text, keyboard);
      }
    }

    this.scheduleWatcherPoll(watcher);
  }

  async unwatchConversation(
    scopeId: string,
    locale: AppLocale,
    notify = true,
  ): Promise<void> {
    this.store.setWatchedThread(scopeId, null);
    const watcher = this.watchers.get(scopeId);
    if (!watcher) {
      if (notify) {
        await this.ui.sendMessage(
          scopeId,
          locale === 'zh' ? 'ℹ️ 当前没有正在观察的会话。' : 'ℹ️ No conversation is currently being watched.',
        );
      }
      return;
    }

    watcher.stopped = true;
    if (watcher.timer) clearTimeout(watcher.timer);
    this.watchers.delete(scopeId);

    if (notify) {
      await this.ui.sendMessage(
        scopeId,
        locale === 'zh'
          ? `🛑 **已停止观察会话**\n\n已退出只读监控模式。`
          : `🛑 **Stopped Watching Conversation**\n\nExited read-only watch mode.`,
      );
    }
  }

  scheduleWatcherPoll(watcher: AntigravityWatcher): void {
    if (watcher.stopped || this.closed) return;
    watcher.timer = setTimeout(() => {
      watcher.timer = null;
      void this.trackPoll(watcher)
        .catch((err) => {
          this.logger.debug('antigravity.watch_poll_error', { error: String(err) });
        })
        .finally(() => {
          if (!watcher.stopped && this.watchers.get(watcher.scopeId) === watcher) {
            this.scheduleWatcherPoll(watcher);
          }
        });
    }, 1500);
    watcher.timer?.unref?.();
  }

  getScopeLocale(scopeId: string): AppLocale {
    return this.store.getChatSettings(scopeId)?.locale || 'zh';
  }

  async renderWatcherProgressUpdate(watcher: AntigravityWatcher): Promise<void> {
    const locale = this.getScopeLocale(watcher.scopeId);
    let messageText = `👁 <b>[Antigravity 观察中]</b>\n\n`;

    if (watcher.currentToolLines.length > 0) {
      const recent = watcher.currentToolLines.slice(-8);
      messageText += `<blockquote expandable>🛠️ <b>主会话工具 (${watcher.currentToolLines.length} 项)</b>\n${recent.join('\n')}</blockquote>\n\n`;
    }

    const subBlock = watcher.subagentTracker.renderTelegramBlock(locale);
    if (subBlock) {
      messageText += `${subBlock}\n\n`;
    }

    const activeSubSummary = watcher.subagentTracker.getActiveSummaryLine(locale);
    if (activeSubSummary) {
      messageText += `⏳ <b>${escapeTelegramHtml(activeSubSummary)}</b>`;
    } else if (watcher.lastContentPreview) {
      messageText += watcher.lastContentPreview.slice(-3000);
    } else {
      messageText += `⏳ 正在执行中…`;
    }

    if (watcher.messageId) {
      await this.ui.editMessage(watcher.scopeId, watcher.messageId, messageText).catch(() => {});
    } else {
      watcher.messageId = await this.ui.sendMessage(watcher.scopeId, messageText).catch(() => null);
    }
  }

  async pollWatcher(watcher: AntigravityWatcher): Promise<void> {
    if (watcher.stopped) return;

    const currentBinding = this.store.getBinding(watcher.scopeId);
    if (currentBinding?.threadId && currentBinding.threadId !== watcher.conversationId) {
      await this.unwatchConversation(watcher.scopeId, this.getScopeLocale(watcher.scopeId), false);
      return;
    }

    if (this.orchestrator.hasActiveTurn(watcher.scopeId)) {
      try {
        if (fs.existsSync(watcher.transcriptPath)) {
          watcher.fileOffset = fs.statSync(watcher.transcriptPath).size;
        }
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      let hasParentLines = false;
      const lines: string[] = [];

      if (fs.existsSync(watcher.transcriptPath)) {
        const stats = fs.statSync(watcher.transcriptPath);
        if (stats.size < watcher.fileOffset) {
          watcher.fileOffset = 0;
          watcher.remainder = '';
        } else if (stats.size > watcher.fileOffset) {
          const bytesToRead = stats.size - watcher.fileOffset;
          const buffer = Buffer.alloc(bytesToRead);
          const fd = fs.openSync(watcher.transcriptPath, 'r');
          try {
            fs.readSync(fd, buffer, 0, bytesToRead, watcher.fileOffset);
          } finally {
            fs.closeSync(fd);
          }

          watcher.fileOffset = stats.size;
          const chunk = watcher.remainder + buffer.toString('utf8');
          const splitLines = chunk.split('\n');
          watcher.remainder = splitLines.pop() ?? '';
          lines.push(...splitLines);
          hasParentLines = splitLines.length > 0;
        }
      }

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: any;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue;
        }

        await this.handleWatcherTranscriptEntry(watcher, entry);
      }

      // Poll subagents
      const subResult = await watcher.subagentTracker.poll();

      // If subagents had new tool events or status updates while the parent has no new lines
      if (subResult.hasUpdates && !hasParentLines) {
        await this.renderWatcherProgressUpdate(watcher);
      }
    } catch (err) {
      this.logger.debug('antigravity.poll_watcher_error', { error: String(err) });
    }
  }

  async handleWatcherTranscriptEntry(watcher: AntigravityWatcher, entry: any): Promise<void> {
    const locale = this.getScopeLocale(watcher.scopeId);

    if (entry.type === 'USER_INPUT') {
      const text = typeof entry.content === 'string' ? entry.content : '';
      const preview = text.length > 300 ? text.slice(0, 300) + '…' : text;
      await this.ui.sendMessage(
        watcher.scopeId,
        `👤 <b>外部用户输入</b>：\n${escapeTelegramHtml(preview)}`,
      );
      watcher.messageId = null;
      watcher.currentToolLines = [];
      watcher.lastContentPreview = '';
      return;
    }

    if (entry.type === 'GENERIC') {
      const content = typeof entry.content === 'string' ? entry.content : '';
      if (content.includes('Created the following subagents') || content.includes('conversationId')) {
        const subResult = await watcher.subagentTracker.poll();
        if (subResult.hasUpdates) {
          await this.renderWatcherProgressUpdate(watcher);
        }
      }
      return;
    }

    if (entry.type === 'PLANNER_RESPONSE') {
      let hasUpdate = false;
      if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
        for (const tc of entry.tool_calls) {
          const name = tc.name || 'tool';
          let desc = '';
          if (tc.args) {
            const raw = tc.args.toolSummary || tc.args.toolAction || tc.args.CommandLine || tc.args.TargetFile || '';
            desc = typeof raw === 'string' ? raw.replace(/^"|"$/g, '').trim() : '';
          }
          const toolLine = `⚙️ <code>${escapeTelegramHtml(name)}</code>${desc ? ` · <i>${escapeTelegramHtml(desc.slice(0, 60))}</i>` : ''}`;
          if (!watcher.currentToolLines.includes(toolLine)) {
            watcher.currentToolLines.push(toolLine);
            hasUpdate = true;
          }
        }
      }

      const isFinalAnswer =
        entry.status === 'DONE' &&
        typeof entry.content === 'string' &&
        entry.content.trim().length > 0 &&
        (!entry.tool_calls || entry.tool_calls.length === 0);

      if (isFinalAnswer) {
        if (watcher.messageId) {
          let progressFinal = `✅ <b>[Antigravity 步骤已完成]</b>`;
          if (watcher.currentToolLines.length > 0) {
            const maxPreview = 3;
            const recent = watcher.currentToolLines.slice(-maxPreview);
            const hiddenCount = watcher.currentToolLines.length - recent.length;
            const hiddenNote = hiddenCount > 0
              ? `\n<i>(其余 ${hiddenCount} 项历史工具调用已折叠收起)</i>`
              : '';
            progressFinal += `\n\n<blockquote expandable>🛠️ <b>已调用工具 (${watcher.currentToolLines.length} 项)</b>\n${recent.join('\n')}${hiddenNote}</blockquote>`;
          }

          const subBlock = watcher.subagentTracker.renderTelegramBlock(locale);
          if (subBlock) {
            progressFinal += `\n\n<blockquote expandable>${subBlock}</blockquote>`;
          }

          await this.ui.editMessage(watcher.scopeId, watcher.messageId, progressFinal).catch(() => {});
        }

        const chunks = chunkTelegramMessage(entry.content.trim(), 4000);
        for (const chunk of chunks) {
          await this.ui.sendMessage(watcher.scopeId, chunk);
        }

        watcher.messageId = null;
        watcher.currentToolLines = [];
        watcher.lastContentPreview = '';
        watcher.subagentTracker = new AntigravitySubagentTracker(watcher.conversationId, undefined, this.logger);
        return;
      }

      if (entry.content) {
        watcher.lastContentPreview = entry.content;
        hasUpdate = true;
      }

      if (hasUpdate) {
        let messageText = `👁 <b>[Antigravity 观察中]</b>\n\n`;
        if (watcher.currentToolLines.length > 0) {
          const recent = watcher.currentToolLines.slice(-8);
          messageText += `<blockquote expandable>🛠️ <b>已调用工具 (${watcher.currentToolLines.length} 项)</b>\n${recent.join('\n')}</blockquote>\n\n`;
        }

        const subBlock = watcher.subagentTracker.renderTelegramBlock(locale);
        if (subBlock) {
          messageText += `${subBlock}\n\n`;
        }

        const activeSubSummary = watcher.subagentTracker.getActiveSummaryLine(locale);
        if (activeSubSummary) {
          messageText += `⏳ <b>${escapeTelegramHtml(activeSubSummary)}</b>`;
        } else if (watcher.lastContentPreview) {
          messageText += watcher.lastContentPreview.slice(-3000);
        } else {
          messageText += `⏳ 正在执行步骤 #${entry.step_index ?? '…'}…`;
        }

        if (watcher.messageId) {
          await this.ui.editMessage(watcher.scopeId, watcher.messageId, messageText).catch(() => {});
        } else {
          watcher.messageId = await this.ui.sendMessage(watcher.scopeId, messageText).catch(() => null);
        }
      }
    }
  }
  watcherFor(scopeId: string) { return this.watchers.get(scopeId); }
  async stop(): Promise<void> { this.closed = true; for (const watcher of this.watchers.values()) { watcher.stopped = true; if (watcher.timer) clearTimeout(watcher.timer); } this.watchers.clear(); await Promise.allSettled([...this.polls]); }

  private trackPoll(watcher: AntigravityWatcher): Promise<void> { const pending = this.pollWatcher(watcher); this.polls.add(pending); void pending.finally(() => this.polls.delete(pending)).catch(() => {}); return pending; }

}
