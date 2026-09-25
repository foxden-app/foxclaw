import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { AppLocale } from '../types.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import type { TelegramMessagingPort, InlineKeyboard } from '../channels/telegram/telegram_messaging_port.js';
import { parseCommand } from '../controller/commands.js';
import { normalizeLocale } from '../i18n.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../telegram/addressing.js';
import { chunkTelegramMessage } from '../telegram/text.js';
import { stageInboundAttachments } from './attachments.js';
import { buildAttachmentPrompt, type StagedTelegramAttachment } from '../telegram/media.js';
import { TurnQueueManager, type TurnMessageMode } from './turn_queue.js';
import { renderStreamPreviewContent } from './stream_preview.js';
import type {
  IEngineAdapter,
  EngineTurnRequest,
  EngineTurnExecution,
  EngineTurnResult,
  EngineModel,
} from './engine_spi.js';

export const STREAM_THROTTLE_MS = 700;
export const TYPING_INTERVAL_MS = 4000;

export interface UnifiedActiveTurn {
  scopeId: string;
  messageId: number;
  threadId: string | null;
  execution: EngineTurnExecution;
  accumulatedText: string;
  toolLines: string[];
  flushTimer: NodeJS.Timeout | null;
  lastFlushTime: number;
  typingTimer: NodeJS.Timeout | null;
}

export interface EngineCustomUiHook {
  renderCustomStatus?(scopeId: string, locale: AppLocale): Promise<string | null>;
  renderCustomSetupRows?(scopeId: string, locale: AppLocale): Promise<InlineKeyboard>;
  handleCustomCallback?(scopeId: string, data: string, locale: AppLocale, messageId?: number): Promise<boolean>;
  handleCustomCommand?(scopeId: string, command: string, args: string, locale: AppLocale, event?: TelegramTextEvent): Promise<boolean>;
  handleCustomInbound?(event: TelegramTextEvent, locale: AppLocale): Promise<boolean>;
}

export class UnifiedChannelOrchestrator {
  readonly config: AppConfig;
  readonly store: BridgeStore;
  readonly logger: Logger;
  readonly bot: TelegramGateway;
  readonly adapter: IEngineAdapter;
  readonly messaging: TelegramMessagingPort;
  readonly queueManager: TurnQueueManager;
  readonly customUi?: EngineCustomUiHook | undefined;

  private readonly activeTurns = new Map<string, UnifiedActiveTurn>();

  constructor(options: {
    config: AppConfig;
    store: BridgeStore;
    logger: Logger;
    bot: TelegramGateway;
    adapter: IEngineAdapter;
    messaging: TelegramMessagingPort;
    customUi?: EngineCustomUiHook | undefined;
  }) {
    this.config = options.config;
    this.store = options.store;
    this.logger = options.logger;
    this.bot = options.bot;
    this.adapter = options.adapter;
    this.messaging = options.messaging;
    this.queueManager = new TurnQueueManager();
    this.customUi = options.customUi;
  }

  registerInboundHandlers(): void {
    this.bot.on('text', (event) => {
      this.handleText(event).catch((err) => {
        this.logger.error('orchestrator.inbound_text_error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.bot.on('callback', (event) => {
      this.handleCallback(event).catch((err) => {
        this.logger.error('orchestrator.inbound_callback_error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  async start(): Promise<void> {
    await this.bot.start();
    this.logger.info('orchestrator.started', { engine: this.adapter.id });

    // Crash recovery: check interrupted preview messages from before restart
    try {
      const activePreviews = this.store.listActiveTurnPreviews().filter(
        (p) => p.turnId.startsWith(`${this.adapter.id}_`),
      );
      for (const prev of activePreviews) {
        this.store.removeActiveTurnPreview(prev.turnId);
        this.editMessage(
          prev.scopeId,
          prev.messageId,
          '🔄 **Foxclaw 服务已重新加载/重启**\n\n检测到上一轮任务执行被服务重启中断，正在自动继续执行…',
        ).catch(() => {});

        const fakeEvent: TelegramTextEvent = {
          scopeId: prev.scopeId,
          chatId: prev.scopeId,
          topicId: null,
          chatType: 'private',
          userId: 'system',
          messageId: prev.messageId,
          text: '继续',
          attachments: [],
          entities: [],
          replyToBot: false,
        };
        const resumeTimer = setTimeout(() => {
          this.startPromptTurn(fakeEvent, '请继续完成上一步未完成的任务', 'zh').catch((err) => {
            this.logger.warn('orchestrator.auto_resume_failed', {
              scopeId: prev.scopeId,
              error: String(err),
            });
          });
        }, 1500);
        resumeTimer?.unref?.();
      }
    } catch (err) {
      this.logger.warn('orchestrator.restore_active_turns_error', { error: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.bot.stop();
    for (const [scopeId, turn] of this.activeTurns.entries()) {
      if (turn.flushTimer) clearTimeout(turn.flushTimer);
      if (turn.typingTimer) clearInterval(turn.typingTimer);
      turn.execution.cancel();
      this.activeTurns.delete(scopeId);
    }
  }

  getActiveTurnsCount(): number {
    return this.activeTurns.size;
  }

  hasActiveTurn(scopeId: string): boolean {
    return this.activeTurns.has(scopeId);
  }

  async sendMessage(scopeId: string, text: string, keyboard?: InlineKeyboard): Promise<number> {
    const chunks = chunkTelegramMessage(text);
    let lastMsgId = 0;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const kb = isLast ? keyboard : undefined;
      lastMsgId = await this.messaging.sendRichMarkdown(scopeId, chunks[i]!, kb);
    }
    return lastMsgId;
  }

  async editMessage(scopeId: string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.messaging.editRichMarkdown(scopeId, messageId, text, keyboard);
  }

  async handleText(event: TelegramTextEvent): Promise<void> {
    const scopeId = event.scopeId;
    const locale: AppLocale = this.store.getChatSettings(scopeId)?.locale ?? 'zh';
    const isDefaultTopic = isDefaultTelegramScope({
      chatType: event.chatType,
      allowedChatId: this.config.tgAllowedChatId ?? null,
      allowedTopicId: this.config.tgAllowedTopicId ?? null,
      topicId: event.topicId ?? null,
      requireExplicitGroupAddressing: false,
    });

    const parsedCommand = parseCommand(event.text);
    const addressing = resolveTelegramAddressing({
      text: event.text,
      attachmentsCount: event.attachments?.length ?? 0,
      entities: event.entities,
      command: parsedCommand,
      botUsername: this.bot.username,
      isDefaultTopic,
      replyToBot: event.replyToBot,
    });

    if (addressing.kind === 'ignore') return;

    if (this.customUi?.handleCustomInbound) {
      const handled = await this.customUi.handleCustomInbound(event, locale);
      if (handled) return;
    }

    if (addressing.kind === 'command') {
      const commandName = addressing.command.name.toLowerCase();
      const argsString = addressing.command.args.join(' ').trim();

      if (this.customUi?.handleCustomCommand) {
        const handled = await this.customUi.handleCustomCommand(scopeId, commandName, argsString, locale, event);
        if (handled) return;
      }

      switch (commandName) {
        case 'start':
        case 'help':
          await this.sendHelp(scopeId, locale);
          return;
        case 'status':
          await this.sendStatus(scopeId, locale);
          return;
        case 'setup':
          await this.sendSetupMenu(scopeId, locale);
          return;
        case 'models':
          await this.sendModelsMenu(scopeId, locale);
          return;
        case 'model':
          if (argsString) {
            this.store.setChatSettings(scopeId, argsString, null);
            await this.sendMessage(
              scopeId,
              locale === 'zh' ? `✅ 模型已切换为: \`${argsString}\`` : `✅ Model switched to: \`${argsString}\``,
            );
          } else {
            await this.sendModelsMenu(scopeId, locale);
          }
          return;
        case 'effort':
          await this.handleEffortCommand(scopeId, argsString, locale);
          return;
        case 'boost':
          await this.handleBoostCommand(scopeId, argsString, locale);
          return;
        case 'active':
          await this.handleActiveCommand(scopeId, argsString, locale);
          return;
        case 'queue':
          await this.handleQueueCommand(event, argsString, locale);
          return;
        case 'steer':
          await this.handleSteerCommand(event, argsString, locale);
          return;
        case 'interrupt':
        case 'stop':
        case 'abort':
          await this.handleInterrupt(scopeId, locale);
          return;
        case 'clear':
        case 'new':
          await this.handleNewSession(scopeId, locale);
          return;
      }
    }

    if (addressing.kind === 'prompt') {
      await this.startPromptTurn(event, addressing.text, locale);
    }
  }

  async handleCallback(event: TelegramCallbackEvent): Promise<void> {
    const scopeId = event.scopeId;
    const locale: AppLocale = 'zh';
    const data = event.data || '';
    const messageId = event.messageId;

    if (this.customUi?.handleCustomCallback) {
      const handled = await this.customUi.handleCustomCallback(scopeId, data, locale, messageId);
      if (handled) return;
    }

    if (data.startsWith('engine:m:')) {
      const model = data.slice('engine:m:'.length);
      this.store.setChatSettings(scopeId, model, null);
      await this.messaging.answerCallback(event.callbackQueryId, `Model: ${model}`);
      await this.sendModelsMenu(scopeId, locale, messageId);
      return;
    }

    if (data.startsWith('engine:setup:')) {
      const sub = data.slice('engine:setup:'.length);
      if (sub === 'main') {
        await this.messaging.answerCallback(event.callbackQueryId, '');
        await this.sendSetupMenu(scopeId, locale, messageId);
        return;
      }
      if (sub === 'boost') {
        const isBoost = this.store.getChatSettings(scopeId)?.serviceTier === 'boost';
        const nextBoost = !isBoost;
        this.store.setChatServiceTier(scopeId, nextBoost ? 'boost' : null);
        if (nextBoost) {
          this.store.setChatSettings(scopeId, null, 'high');
        }
        await this.messaging.answerCallback(
          event.callbackQueryId,
          nextBoost ? (locale === 'zh' ? '🚀 Boost 模式已开启 (深度 High)' : '🚀 Boost Mode enabled (High)') : (locale === 'zh' ? '⚪ Boost 模式已关闭' : '⚪ Boost Mode disabled'),
        );
        await this.sendSetupMenu(scopeId, locale, messageId);
        return;
      }
      if (sub === 'models') {
        await this.messaging.answerCallback(event.callbackQueryId, '');
        await this.sendModelsMenu(scopeId, locale, messageId);
        return;
      }
      if (sub === 'active_mode') {
        const settings = this.store.getChatSettings(scopeId);
        const current = settings?.activeTurnMessageMode ?? 'queue';
        const next: TurnMessageMode = current === 'steer' ? 'queue' : 'steer';
        this.store.setChatActiveTurnMessageMode(scopeId, next);
        await this.messaging.answerCallback(
          event.callbackQueryId,
          next === 'steer' ? '已切换为：⚡ 插话模式' : '已切换为：⏳ 排队模式',
        );
        await this.sendSetupMenu(scopeId, locale, messageId);
        return;
      }
      if (sub === 'new') {
        await this.messaging.answerCallback(event.callbackQueryId, '已创建新会话');
        await this.handleNewSession(scopeId, locale);
        return;
      }
    }
  }

  async startPromptTurn(
    event: TelegramTextEvent,
    prompt: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    const binding = this.store.getBinding(scopeId);
    const cwd = binding?.cwd || this.config.defaultCwd;
    const threadId = binding?.threadId || 'default';

    let effectivePrompt = prompt;
    let stagedAttachments: StagedTelegramAttachment[] | undefined;
    if (event.attachments && event.attachments.length > 0) {
      const nonDocJson = event.attachments.filter(
        (a) => !(a.kind === 'document' && (a.fileName?.endsWith('.json') || a.mimeType?.includes('json'))),
      );
      if (nonDocJson.length > 0) {
        const staged = await stageInboundAttachments(
          this.messaging,
          cwd,
          threadId,
          nonDocJson,
          this.logger,
        );
        if (staged.length > 0) {
          stagedAttachments = staged;
          effectivePrompt = buildAttachmentPrompt(prompt, staged);
        }
      }
    }

    if (this.activeTurns.has(scopeId)) {
      const settings = this.store.getChatSettings(scopeId);
      const mode = settings?.activeTurnMessageMode ?? 'queue';

      if (mode === 'steer') {
        const active = this.activeTurns.get(scopeId);
        if (active) {
          active.execution.cancel();
          if (active.typingTimer) clearInterval(active.typingTimer);
          if (active.flushTimer) clearTimeout(active.flushTimer);
          this.activeTurns.delete(scopeId);
        }
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `⚡ **已插话中断前置任务，立即开始新指令**：\n> ${effectivePrompt}`
            : `⚡ **Interrupted previous turn, executing new instruction**:\n> ${effectivePrompt}`,
        );
        await this.executeTurn(event, effectivePrompt, locale, 0, stagedAttachments);
        return;
      }

      await this.enqueuePromptTurn(event, effectivePrompt, locale);
      return;
    }

    await this.executeTurn(event, effectivePrompt, locale, 0, stagedAttachments);
  }

  private async enqueuePromptTurn(
    event: TelegramTextEvent,
    prompt: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    const queueId = `${this.adapter.id}_q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const binding = this.store.getBinding(scopeId);

    this.store.saveQueuedTurnInput({
      queueId,
      scopeId,
      chatId: String(event.chatId),
      chatType: event.chatType,
      topicId: event.topicId ?? null,
      threadId: binding?.threadId || '',
      inputJson: JSON.stringify([{ type: 'text', text: prompt }]),
      sourceSummary: prompt,
      messageId: event.messageId ?? null,
      status: 'queued',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
    });

    const queueCount = this.store.countQueuedTurnInputs(scopeId);
    await this.sendMessage(
      scopeId,
      locale === 'zh'
        ? `📥 **已加入排队队列** (当前队列: ${queueCount} 条)\n当前任务完成后将自动按序执行：\n> ${prompt}\n\n*提示：发送 /interrupt 可中断当前任务，或在 /setup 中切换为“插话”模式。*`
        : `📥 **Queued** (${queueCount} in queue)\nWill execute automatically once current turn finishes:\n> ${prompt}\n\n*Tip: send /interrupt to stop, or switch to "Steer" in /setup.*`,
    );
  }

  private async drainNextQueuedTurn(event: TelegramTextEvent, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    try {
      const nextQueued = this.store.peekQueuedTurnInput(scopeId);
      if (!nextQueued) return;

      this.store.updateQueuedTurnInputStatus(nextQueued.queueId, 'completed');
      let parsedInput = nextQueued.sourceSummary;
      try {
        const arr = JSON.parse(nextQueued.inputJson);
        if (Array.isArray(arr) && arr[0]?.text) {
          parsedInput = arr[0].text;
        }
      } catch {}

      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `▶️ **开始执行排队任务**：\n> ${parsedInput}`
          : `▶️ **Executing queued task**:\n> ${parsedInput}`,
      );

      void this.startPromptTurn(
        {
          ...event,
          text: parsedInput,
        },
        parsedInput,
        locale,
      );
    } catch (err) {
      this.logger.warn('orchestrator.drain_queue_failed', { error: String(err) });
    }
  }

  private async executeTurn(
    event: TelegramTextEvent,
    prompt: string,
    locale: AppLocale,
    retryCount = 0,
    stagedAttachments?: StagedTelegramAttachment[],
  ): Promise<void> {
    const scopeId = event.scopeId;
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);

    const cwd = binding?.cwd || this.config.defaultCwd;
    const threadId = binding?.threadId || null;
    const model = settings?.model || 'default';
    const isBoost = settings?.serviceTier === 'boost';
    const effort = isBoost ? 'high' : (settings?.reasoningEffort ?? 'high');

    const effectivePrompt = isBoost && !prompt.startsWith('[Boost Mode:')
      ? `[Boost Mode: Proceed with deep thinking, strategic planning, multiple perspectives, and rigorous verification.]\n\n${prompt}`
      : prompt;

    const initialMsgId = await this.sendMessage(
      scopeId,
      locale === 'zh'
        ? (isBoost ? `🚀 ${this.adapter.name} (Boost 模式) 正在深度思考中…` : `⏳ ${this.adapter.name} 正在思考中…`)
        : (isBoost ? `🚀 ${this.adapter.name} (Boost Mode) is thinking deeply…` : `⏳ ${this.adapter.name} is thinking…`),
    );

    const turnKey = `${this.adapter.id}_${scopeId}_${Date.now()}`;
    try {
      this.store.saveActiveTurnPreview({
        turnId: turnKey,
        scopeId,
        threadId: threadId || '',
        messageId: initialMsgId,
      });
    } catch {}

    const req: EngineTurnRequest = {
      scopeId,
      prompt: effectivePrompt,
      stagedAttachments,
      threadId,
      cwd,
      model,
      effort,
      serviceTier: isBoost ? 'boost' : (settings?.serviceTier ?? null),
      locale,
    };

    if (this.adapter.preflightTurn) {
      try {
        await this.adapter.preflightTurn(req);
      } catch (err) {
        this.logger.warn('orchestrator.preflight_failed', { error: String(err) });
      }
    }

    const execution = this.adapter.executeTurn(req);

    const activeTurn: UnifiedActiveTurn = {
      scopeId,
      messageId: initialMsgId,
      threadId,
      execution,
      accumulatedText: '',
      toolLines: [],
      flushTimer: null,
      lastFlushTime: Date.now(),
      typingTimer: null,
    };

    this.activeTurns.set(scopeId, activeTurn);

    activeTurn.typingTimer = setInterval(() => {
      this.messaging.sendTypingInScope(scopeId).catch(() => {});
    }, TYPING_INTERVAL_MS);
    activeTurn.typingTimer?.unref?.();

    const scheduleFlush = () => {
      if (activeTurn.flushTimer) return;
      const elapsed = Date.now() - activeTurn.lastFlushTime;
      const delay = Math.max(0, STREAM_THROTTLE_MS - elapsed);
      activeTurn.flushTimer = setTimeout(() => {
        activeTurn.flushTimer = null;
        activeTurn.lastFlushTime = Date.now();
        const content = renderStreamPreviewContent({
          toolLines: activeTurn.toolLines,
          accumulatedText: activeTurn.accumulatedText,
          isBoost,
          engineName: this.adapter.name,
        });
        this.editMessage(activeTurn.scopeId, activeTurn.messageId, content).catch(() => {});
      }, delay);
      activeTurn.flushTimer?.unref?.();
    };

    execution.on('delta', (delta) => {
      activeTurn.accumulatedText += delta;
      scheduleFlush();
    });

    execution.on('tool', (tool) => {
      const statusIcon = tool.status === 'running' ? '⚙️' : tool.status === 'failed' ? '❌' : '✅';
      const line = `${statusIcon} \`${tool.name}\``;
      if (!activeTurn.toolLines.includes(line)) {
        activeTurn.toolLines.push(line);
      }
      scheduleFlush();
    });

    const retryTurn = async (nextRetryCount: number) => {
      await this.executeTurn(event, prompt, locale, nextRetryCount, stagedAttachments);
    };

    execution.on('result', async (res: EngineTurnResult) => {
      if (activeTurn.flushTimer) clearTimeout(activeTurn.flushTimer);
      if (activeTurn.typingTimer) clearInterval(activeTurn.typingTimer);
      this.activeTurns.delete(scopeId);
      this.store.removeActiveTurnPreview(turnKey);

      if (res.conversationId && (!binding?.threadId || binding.threadId !== res.conversationId)) {
        this.store.setBinding(scopeId, res.conversationId, cwd);
      }

      if (res.status === 'SUCCESS') {
        let finalText = (res.response || '').trim();
        if (!finalText && activeTurn.accumulatedText) {
          finalText = activeTurn.accumulatedText.trim();
        }

        let foldedTools = '';
        if (activeTurn.toolLines.length > 0) {
          foldedTools = `<blockquote expandable>🛠️ <b>已调用工具 (${activeTurn.toolLines.length} 项)</b>\n${activeTurn.toolLines.join('\n')}</blockquote>\n\n`;
        }

        const fullText = foldedTools + (finalText || '(无输出 / No output)');
        const chunks = chunkTelegramMessage(fullText, 4000);
        if (chunks.length > 0) {
          await this.editMessage(scopeId, activeTurn.messageId, chunks[0]!).catch(() => {
            return this.sendMessage(scopeId, chunks[0]!);
          });
          for (let i = 1; i < chunks.length; i++) {
            await this.sendMessage(scopeId, chunks[i]!);
          }
        }
        await this.drainNextQueuedTurn(event, locale);
        return;
      }

      if (res.status === 'ERROR') {
        const errorText = res.response || (res as any).error || 'Unknown error';
        if (this.adapter.handleTurnError) {
          const handled = await this.adapter.handleTurnError({
            error: errorText,
            request: req,
            retryCount,
            retryTurn,
            sendMessage: (text: string) => this.sendMessage(scopeId, text),
            editMessage: (messageId: number, text: string) => this.editMessage(scopeId, messageId, text),
          });
          if (handled) return;
        }

        await this.editMessage(
          scopeId,
          activeTurn.messageId,
          `❌ **${this.adapter.name} 错误**:\n\`\`\`\n${errorText}\n\`\`\``,
        );
        await this.drainNextQueuedTurn(event, locale);
        return;
      }

      await this.editMessage(
        scopeId,
        activeTurn.messageId,
        activeTurn.accumulatedText || '⚠️ 执行结束',
      );
      await this.drainNextQueuedTurn(event, locale);
    });

    execution.on('error', async (err: Error) => {
      if (activeTurn.flushTimer) clearTimeout(activeTurn.flushTimer);
      if (activeTurn.typingTimer) clearInterval(activeTurn.typingTimer);
      this.activeTurns.delete(scopeId);
      this.store.removeActiveTurnPreview(turnKey);

      if (this.adapter.handleTurnError) {
        const handled = await this.adapter.handleTurnError({
          error: err.message,
          request: req,
          retryCount,
          retryTurn,
          sendMessage: (text: string) => this.sendMessage(scopeId, text),
          editMessage: (messageId: number, text: string) => this.editMessage(scopeId, messageId, text),
        });
        if (handled) return;
      }

      await this.editMessage(
        scopeId,
        activeTurn.messageId,
        `❌ **执行异常**:\n\`\`\`\n${err.message}\n\`\`\``,
      );
      await this.drainNextQueuedTurn(event, locale);
    });
  }

  private async handleEffortCommand(scopeId: string, args: string, locale: AppLocale): Promise<void> {
    const target = args.trim().toLowerCase();
    if (target === 'low' || target === 'medium' || target === 'high') {
      const settings = this.store.getChatSettings(scopeId);
      if (target !== 'high' && settings?.serviceTier === 'boost') {
        this.store.setChatServiceTier(scopeId, null);
      }
      this.store.setChatSettings(scopeId, null, target as 'low' | 'medium' | 'high');
      await this.sendMessage(
        scopeId,
        locale === 'zh' ? `✅ 思考深度已设置为: \`${target}\`` : `✅ Reasoning effort set to: \`${target}\``,
      );
    } else {
      const current = this.store.getChatSettings(scopeId)?.reasoningEffort ?? 'high';
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `• **当前思考深度**: \`${current}\`\n\n用法: \`/effort <low|medium|high>\``
          : `• **Current effort**: \`${current}\`\n\nUsage: \`/effort <low|medium|high>\``,
      );
    }
  }

  private async handleBoostCommand(scopeId: string, args: string, locale: AppLocale): Promise<void> {
    const isBoost = this.store.getChatSettings(scopeId)?.serviceTier === 'boost';
    const target = args.trim().toLowerCase();
    let nextBoost = !isBoost;
    if (target === 'on' || target === '1' || target === 'true') nextBoost = true;
    if (target === 'off' || target === '0' || target === 'false') nextBoost = false;

    this.store.setChatServiceTier(scopeId, nextBoost ? 'boost' : null);
    if (nextBoost) {
      this.store.setChatSettings(scopeId, null, 'high');
    }
    const msg = locale === 'zh'
      ? (nextBoost
          ? '🚀 已开启 **Boost 增强模式**！\n• 思考深度锁定为 `high`\n• 注入深度规划、多视角审视与交叉验证指令\n• 适用于复杂编程、长推理任务与疑难排错'
          : '⚪ 已关闭 Boost 模式。')
      : (nextBoost
          ? '🚀 **Boost Mode** enabled!\n• Reasoning effort locked to `high`\n• Deep planning, multi-perspective analysis & rigorous verification active'
          : '⚪ Boost mode disabled.');
    await this.sendMessage(scopeId, msg);
  }

  private async handleActiveCommand(scopeId: string, args: string, locale: AppLocale): Promise<void> {
    const target = args.trim().toLowerCase();
    if (target === 'steer' || target === 'queue') {
      this.store.setChatActiveTurnMessageMode(scopeId, target);
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `✅ 运行中消息模式已设置为: **${target === 'steer' ? '插话 ⚡ (立即中断接管)' : '排队 ⏳ (完成后自动执行)'}**`
          : `✅ Active-turn message mode set to: **${target}**`,
      );
    } else {
      const current = this.store.getChatSettings(scopeId)?.activeTurnMessageMode ?? 'queue';
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `• **当前运行中消息模式**: ${current === 'steer' ? '⚡ 插话 (立即中断接管)' : '⏳ 排队 (完成后自动执行)'}\n\n用法: \`/active <steer|queue>\` 或在 \`/setup\` 面板中一键切换。`
          : `• **Current mode**: ${current}\n\nUsage: \`/active <steer|queue>\` or toggle in \`/setup\`.`,
      );
    }
  }

  private async handleQueueCommand(event: TelegramTextEvent, args: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    if (!args.trim()) {
      const count = this.store.countQueuedTurnInputs(scopeId);
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `📥 当前队列中共有 ${count} 条待执行任务。\n用法: \`/queue <消息>\` 追加排队，或 \`/queue clear\` 清空队列。`
          : `📥 Total ${count} queued tasks.\nUsage: \`/queue <message>\` or \`/queue clear\`.`,
      );
      return;
    }
    if (args.trim().toLowerCase() === 'clear') {
      const cleared = this.store.cancelQueuedTurnInputs(scopeId);
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `🗑️ 已清空当前会话的 ${cleared} 条排队任务。`
          : `🗑️ Cleared ${cleared} queued tasks.`,
      );
      return;
    }
    await this.enqueuePromptTurn(event, args.trim(), locale);
  }

  private async handleSteerCommand(event: TelegramTextEvent, args: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    if (!args.trim()) {
      await this.sendMessage(
        scopeId,
        locale === 'zh' ? '用法: `/steer <消息>` (立即中断当前思考，带入新指令)' : 'Usage: `/steer <message>`',
      );
      return;
    }
    const active = this.activeTurns.get(scopeId);
    if (active) {
      active.execution.cancel();
      if (active.typingTimer) clearInterval(active.typingTimer);
      if (active.flushTimer) clearTimeout(active.flushTimer);
      this.activeTurns.delete(scopeId);
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `⚡ 已中断前置任务，立即开始插话指令：\n> ${args.trim()}`
          : `⚡ Interrupted active turn, executing steer instruction:\n> ${args.trim()}`,
      );
    }
    await this.executeTurn(event, args.trim(), locale);
  }

  async handleInterrupt(scopeId: string, locale: AppLocale): Promise<void> {
    const active = this.activeTurns.get(scopeId);
    const queuedCount = this.store.countQueuedTurnInputs(scopeId);
    if (active) {
      active.execution.cancel();
      if (active.flushTimer) clearTimeout(active.flushTimer);
      if (active.typingTimer) clearInterval(active.typingTimer);
      this.activeTurns.delete(scopeId);
      let extraMsg = '';
      if (queuedCount > 0) {
        extraMsg = locale === 'zh'
          ? `\nℹ️ 队列中尚有 ${queuedCount} 条任务，如需一并清空请发送 \`/queue clear\`。`
          : `\nℹ️ ${queuedCount} tasks in queue. Send \`/queue clear\` to remove.`;
      }
      await this.sendMessage(
        scopeId,
        (locale === 'zh' ? '🛑 已发送中断请求。' : '🛑 Interrupt request sent.') + extraMsg,
      );
    } else if (queuedCount > 0) {
      const cleared = this.store.cancelQueuedTurnInputs(scopeId);
      await this.sendMessage(
        scopeId,
        locale === 'zh' ? `🛑 当前无运行中任务，已清空 ${cleared} 条排队任务。` : `🛑 Cleared ${cleared} queued tasks.`,
      );
    } else {
      await this.sendMessage(
        scopeId,
        locale === 'zh' ? 'ℹ️ 当前没有正在执行或排队的任务。' : 'ℹ️ No active or queued tasks to interrupt.',
      );
    }
  }

  async handleNewSession(scopeId: string, locale: AppLocale): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const cwd = binding?.cwd || this.config.defaultCwd;
    const newThreadId = `${this.adapter.id}_${Date.now()}`;
    this.store.setBinding(scopeId, newThreadId, cwd);

    await this.sendMessage(
      scopeId,
      locale === 'zh'
        ? `✨ **已开启全新会话**\n会话 ID: \`${newThreadId}\`\n工作目录: \`${cwd}\``
        : `✨ **New Session Created**\nThread: \`${newThreadId}\`\nDirectory: \`${cwd}\``,
    );
  }

  async sendStatus(scopeId: string, locale: AppLocale): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);
    const isBusy = this.activeTurns.has(scopeId);
    const customStatus = this.customUi?.renderCustomStatus ? await this.customUi.renderCustomStatus(scopeId, locale) : '';

    const text =
      locale === 'zh'
        ? `📊 **${this.adapter.name} 运行状态**\n\n` +
          `• **状态**: ${isBusy ? '⚡ 正在执行任务' : '💤 空闲'}\n` +
          `• **当前模型**: \`${settings?.model || '默认'}\`\n` +
          `• **绑定会话**: \`${binding?.threadId || '(新会话)'}\`\n` +
          `• **工作目录**: \`${binding?.cwd || this.config.defaultCwd}\`` +
          (customStatus ? `\n${customStatus}` : '')
        : `📊 **${this.adapter.name} Status**\n\n` +
          `• **State**: ${isBusy ? '⚡ Executing' : '💤 Idle'}\n` +
          `• **Model**: \`${settings?.model || 'default'}\`\n` +
          `• **Thread**: \`${binding?.threadId || '(new)'}\`\n` +
          `• **Directory**: \`${binding?.cwd || this.config.defaultCwd}\`` +
          (customStatus ? `\n${customStatus}` : '');

    const keyboard: InlineKeyboard = [
      [
        { text: '⚙️ 控制面板', callback_data: 'engine:setup:main' },
        { text: '🧠 切换模型', callback_data: 'engine:setup:models' },
      ],
    ];

    await this.sendMessage(scopeId, text, keyboard);
  }

  async sendSetupMenu(scopeId: string, locale: AppLocale, editMessageId?: number): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const mode = settings?.activeTurnMessageMode ?? 'queue';
    const isBoost = settings?.serviceTier === 'boost';

    const text =
      locale === 'zh'
        ? `⚙️ **${this.adapter.name} 控制面板**\n\n` +
          `• **当前模型**: \`${settings?.model || '默认'}\`\n` +
          `• **Boost 增强**: ${isBoost ? '🚀 已开启' : '⚪ 已关闭'}\n` +
          `• **运行中消息**: ${mode === 'steer' ? '⚡ 插话 (立即中断接管)' : '⏳ 排队 (完成后自动执行)'}\n\n` +
          `请选择要配置的项目：`
        : `⚙️ **${this.adapter.name} Setup Panel**\n\n` +
          `• **Model**: \`${settings?.model || 'default'}\`\n` +
          `• **Boost**: ${isBoost ? '🚀 Enabled' : '⚪ Disabled'}\n` +
          `• **Active-Turn**: ${mode === 'steer' ? '⚡ Steer' : '⏳ Queue'}\n\n` +
          `Select setting to configure:`;

    const keyboard: InlineKeyboard = [
      [
        {
          text: isBoost ? (locale === 'zh' ? '🚀 Boost: 开启' : '🚀 Boost: On') : (locale === 'zh' ? '⚪ Boost: 关闭' : '⚪ Boost: Off'),
          callback_data: 'engine:setup:boost',
        },
        { text: '🧠 切换模型', callback_data: 'engine:setup:models' },
      ],
      [
        {
          text: mode === 'steer' ? '⚡ 运行中: 插话' : '⏳ 运行中: 排队',
          callback_data: 'engine:setup:active_mode',
        },
        { text: '✨ 新建会话', callback_data: 'engine:setup:new' },
      ],
      [
        { text: '🔄 刷新面板', callback_data: 'engine:setup:main' },
      ],
    ];

    if (this.customUi?.renderCustomSetupRows) {
      const customRows = await this.customUi.renderCustomSetupRows(scopeId, locale);
      keyboard.unshift(...customRows);
    }

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, text, keyboard);
    } else {
      await this.sendMessage(scopeId, text, keyboard);
    }
  }

  async sendModelsMenu(scopeId: string, locale: AppLocale, editMessageId?: number): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const currentModel = settings?.model;
    const models = await this.adapter.listModels();

    const keyboard: InlineKeyboard = [];
    for (let i = 0; i < models.length; i += 2) {
      const row: InlineKeyboard[0] = [];
      const m1 = models[i]!;
      const isM1Active = m1.id === currentModel || (!currentModel && m1.isDefault);
      row.push({
        text: `${isM1Active ? '✅ ' : ''}${m1.name}`,
        callback_data: `engine:m:${m1.id}`,
      });
      if (i + 1 < models.length) {
        const m2 = models[i + 1]!;
        const isM2Active = m2.id === currentModel || (!currentModel && m2.isDefault);
        row.push({
          text: `${isM2Active ? '✅ ' : ''}${m2.name}`,
          callback_data: `engine:m:${m2.id}`,
        });
      }
      keyboard.push(row);
    }

    keyboard.push([{ text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' }]);

    const title =
      locale === 'zh'
        ? `🎯 **选择 ${this.adapter.name} 模型**`
        : `🎯 **Select ${this.adapter.name} Model**`;

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, title, keyboard);
    } else {
      await this.sendMessage(scopeId, title, keyboard);
    }
  }

  async sendHelp(scopeId: string, locale: AppLocale): Promise<void> {
    const text =
      locale === 'zh'
        ? `🦊 **FoxClaw — ${this.adapter.name} 使用指南**\n\n` +
          `• 直接发送消息即可向 AI 发起提问或任务\n` +
          `• 发送照片、文件等多媒体，AI 可自动下载落盘并分析\n\n` +
          `**常用命令：**\n` +
          `/setup — 控制面板（切换模型、插话/排队模式管理）\n` +
          `/models — 快速切换 AI 模型\n` +
          `/status — 查看当前运行状态与会话信息\n` +
          `/interrupt — 中断当前正在运行的任务\n` +
          `/new — 清空历史并新建会话\n` +
          `/help — 显示本帮助手册\n`
        : `🦊 **FoxClaw — ${this.adapter.name} Quick Guide**\n\n` +
          `• Send any prompt to chat or run tasks\n` +
          `• Send photos or documents for AI inspection\n\n` +
          `**Commands:**\n` +
          `/setup — Control panel\n` +
          `/models — Switch model\n` +
          `/status — Check runtime status\n` +
          `/interrupt — Stop active turn\n` +
          `/new — Start fresh session\n` +
          `/help — Show this help\n`;

    await this.sendMessage(scopeId, text);
  }
}
