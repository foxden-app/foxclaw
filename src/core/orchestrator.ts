import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { AppLocale, ReasoningEffortValue, AccessPresetValue, ActiveTurnMessageMode } from '../types.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import type { TelegramMessagingPort, InlineKeyboard } from '../channels/telegram/telegram_messaging_port.js';
import { parseCommand } from '../controller/commands.js';
import { normalizeLocale, getTelegramCommands, getAntigravityTelegramCommands } from '../i18n.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../telegram/addressing.js';
import { chunkTelegramMessage } from '../telegram/text.js';
import { stageInboundAttachments } from './attachments.js';
import { buildAttachmentPrompt, type StagedTelegramAttachment } from '../telegram/media.js';
import { TurnQueueManager, type TurnMessageMode } from './turn_queue.js';
import { renderStreamPreviewContent } from './stream_preview.js';
import { BRIDGE_SCOPE_TELEGRAM_PREFIX, BRIDGE_SCOPE_WEIXIN_PREFIX, parseTelegramTargetFromBridgeScope } from './bridge_scope.js';
import { escapeTelegramHtml } from '../telegram/html.js';
import { formatTokenUsageSummary, formatBackendTokenUsageBreakdown } from '../store/token_usage.js';
import type {
  IEngineAdapter,
  EngineTurnRequest,
  EngineTurnExecution,
  EngineTurnResult,
  EngineModel,
  BackendDescriptor,
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
  stepIndex?: number;
  toolCount: number;
  currentTool?: string | null;
  startTime: number;
}

export interface EngineCustomUiHook {
  renderCustomStatus?(scopeId: string, locale: AppLocale): Promise<string | null>;
  renderCustomSetupRows?(scopeId: string, locale: AppLocale): Promise<InlineKeyboard>;
  handleCustomCallback?(scopeId: string, data: string, locale: AppLocale, messageId?: number, event?: TelegramCallbackEvent): Promise<boolean>;
  handleCustomCommand?(scopeId: string, command: string, args: string, locale: AppLocale, event?: TelegramTextEvent): Promise<boolean>;
  handleCustomInbound?(event: TelegramTextEvent, locale: AppLocale): Promise<boolean>;
}

export class UnifiedChannelOrchestrator {
  readonly config: AppConfig;
  readonly store: BridgeStore;
  readonly logger: Logger;
  readonly bot: TelegramGateway;
  readonly messaging: TelegramMessagingPort;
  readonly queueManager: TurnQueueManager;
  readonly customUi?: EngineCustomUiHook | undefined;

  private readonly backends = new Map<string, BackendDescriptor>();
  private readonly defaultBackendId: string;
  private readonly activeTurns = new Map<string, UnifiedActiveTurn>();
  private readonly stalePanelDeleteTimers = new Map<string, NodeJS.Timeout>();
  private readonly backendProvider?: (() => Promise<BackendDescriptor[]> | BackendDescriptor[]) | undefined;

  get adapter(): IEngineAdapter {
    return this.getAdapterForBackend(this.defaultBackendId);
  }

  constructor(options: {
    config: AppConfig;
    store: BridgeStore;
    logger: Logger;
    bot: TelegramGateway;
    adapter?: IEngineAdapter;
    adapters?: Map<string, IEngineAdapter> | IEngineAdapter[];
    backends?: BackendDescriptor[];
    backendProvider?: (() => Promise<BackendDescriptor[]> | BackendDescriptor[]) | undefined;
    defaultBackendId?: string;
    messaging: TelegramMessagingPort;
    customUi?: EngineCustomUiHook | undefined;
  }) {
    this.config = options.config;
    this.store = options.store;
    this.logger = options.logger;
    this.bot = options.bot;
    this.messaging = options.messaging;
    this.queueManager = new TurnQueueManager();
    this.customUi = options.customUi;
    this.backendProvider = options.backendProvider;

    if (options.backends) {
      for (const b of options.backends) {
        this.backends.set(b.id, b);
      }
    }
    if (options.adapters) {
      if (options.adapters instanceof Map) {
        for (const [id, ad] of options.adapters) {
          if (!this.backends.has(id)) {
            this.backends.set(id, { id, name: ad.name, engineType: id, adapter: ad });
          }
        }
      } else if (Array.isArray(options.adapters)) {
        for (const ad of options.adapters) {
          if (!this.backends.has(ad.id)) {
            this.backends.set(ad.id, { id: ad.id, name: ad.name, engineType: ad.id, adapter: ad });
          }
        }
      }
    }
    if (options.adapter && !this.backends.has(options.adapter.id)) {
      this.backends.set(options.adapter.id, {
        id: options.adapter.id,
        name: options.adapter.name,
        engineType: options.adapter.id,
        adapter: options.adapter,
        isDefault: true,
      });
    }

    const firstId = Array.from(this.backends.keys())[0] ?? 'default';
    this.defaultBackendId = options.defaultBackendId ?? options.adapter?.id ?? firstId;
  }

  getAdapterForScope(scopeId: string): IEngineAdapter {
    const activeBackendId = this.store.getActiveBackend(scopeId) || this.defaultBackendId;
    return this.getAdapterForBackend(activeBackendId);
  }

  getBackendDescriptorForScope(scopeId: string): BackendDescriptor {
    const activeBackendId = this.store.getActiveBackend(scopeId) || this.defaultBackendId;
    return (
      this.backends.get(activeBackendId) ??
      this.backends.get(this.defaultBackendId) ?? {
        id: activeBackendId,
        name: activeBackendId,
        engineType: activeBackendId,
        adapter: this.adapter,
      }
    );
  }

  getAdapterForBackend(backendId: string): IEngineAdapter {
    const desc = this.backends.get(backendId);
    if (desc) return desc.adapter;
    const fallback = this.backends.get(this.defaultBackendId) ?? Array.from(this.backends.values())[0];
    if (!fallback) {
      throw new Error(`No engine adapter available in orchestrator for backend '${backendId}'`);
    }
    return fallback.adapter;
  }

  registerBackend(desc: BackendDescriptor): void {
    this.backends.set(desc.id, desc);
  }

  async listBackends(): Promise<BackendDescriptor[]> {
    const list: BackendDescriptor[] = [];
    const seen = new Set<string>();

    if (this.backendProvider) {
      try {
        const dynamicList = await this.backendProvider();
        for (const b of dynamicList) {
          list.push(b);
          seen.add(b.id);
          if (!this.backends.has(b.id)) {
            this.backends.set(b.id, b);
          }
        }
      } catch (err) {
        this.logger.warn('orchestrator.backend_provider_failed', { error: String(err) });
      }
    }

    for (const b of this.backends.values()) {
      if (!seen.has(b.id)) {
        list.push(b);
        seen.add(b.id);
      }
    }

    return list;
  }

  async resolveBackendDescriptor(backendId: string): Promise<BackendDescriptor | null> {
    const cached = this.backends.get(backendId);
    if (cached) return cached;
    const all = await this.listBackends();
    return all.find((b) => b.id === backendId) ?? null;
  }

  syncCurrentBackendSettings(scopeId: string): void {
    const activeBackend = this.getBackendDescriptorForScope(scopeId);
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);
    this.store.setScopeBackendBinding(
      scopeId,
      activeBackend.id,
      binding?.threadId ?? '',
      binding?.cwd ?? null,
      {
        model: settings?.model ?? null,
        reasoningEffort: settings?.reasoningEffort ?? null,
        activeTurnMessageMode: settings?.activeTurnMessageMode ?? null,
        serviceTier: settings?.serviceTier ?? null,
        accessPreset: settings?.accessPreset ?? null,
      },
    );
  }

  scheduleStalePanelDeletion(scopeId: string, messageId: number): void {
    if (this.config.telegramPanelTtlMs <= 0 || scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      return;
    }
    const key = `${scopeId}:${messageId}`;
    const existing = this.stalePanelDeleteTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.stalePanelDeleteTimers.delete(key);
      if (typeof this.messaging?.deleteMessage === 'function') {
        void this.messaging.deleteMessage(scopeId, messageId).catch((error) => {
          this.logger.debug('telegram.stale_panel_delete_failed', { scopeId, messageId, error: String(error) });
        });
      }
    }, this.config.telegramPanelTtlMs);
    timer.unref();
    this.stalePanelDeleteTimers.set(key, timer);
  }

  async switchBackend(
    scopeId: string,
    targetBackendId: string,
    locale: AppLocale,
  ): Promise<{
    previousBackendId: string;
    newBackendId: string;
    restoredThreadId: string | null;
    cwd: string | null;
  }> {
    const currentBackendId = this.store.getActiveBackend(scopeId) || this.defaultBackendId;
    const targetDesc = await this.resolveBackendDescriptor(targetBackendId);
    if (!targetDesc) {
      throw new Error(
        locale === 'zh'
          ? `未找到目标后端: ${targetBackendId}`
          : `Target backend not found: ${targetBackendId}`,
      );
    }

    if (targetDesc.onSelect) {
      await targetDesc.onSelect(scopeId);
    }

    if (!this.backends.has(targetDesc.id)) {
      this.backends.set(targetDesc.id, targetDesc);
    }

    if (currentBackendId === targetBackendId) {
      const currentBinding = this.store.getBinding(scopeId);
      return {
        previousBackendId: currentBackendId,
        newBackendId: targetBackendId,
        restoredThreadId: currentBinding?.threadId ?? null,
        cwd: currentBinding?.cwd ?? null,
      };
    }

    const currentBinding = this.store.getBinding(scopeId);
    const currentSettings = this.store.getChatSettings(scopeId);
    this.store.setScopeBackendBinding(
      scopeId,
      currentBackendId,
      currentBinding?.threadId ?? '',
      currentBinding?.cwd ?? null,
      {
        model: currentSettings?.model ?? null,
        reasoningEffort: currentSettings?.reasoningEffort ?? null,
        activeTurnMessageMode: currentSettings?.activeTurnMessageMode ?? null,
        serviceTier: currentSettings?.serviceTier ?? null,
        accessPreset: currentSettings?.accessPreset ?? null,
      },
    );

    this.store.setActiveBackend(scopeId, targetBackendId);

    const saved = this.store.getScopeBackendBinding(scopeId, targetBackendId);
    if (saved) {
      if (saved.threadId) {
        this.store.setBinding(scopeId, saved.threadId, saved.cwd ?? this.config.defaultCwd);
      } else {
        this.store.clearBinding(scopeId);
      }
      this.store.setChatSettings(
        scopeId,
        saved.model ?? null,
        (saved.reasoningEffort as ReasoningEffortValue) ?? null,
      );
      if (saved.activeTurnMessageMode !== undefined && saved.activeTurnMessageMode !== null) {
        this.store.setChatActiveTurnMessageMode(
          scopeId,
          (saved.activeTurnMessageMode as ActiveTurnMessageMode) ?? null,
        );
      }
      if (saved.serviceTier !== undefined) {
        this.store.setChatServiceTier(scopeId, saved.serviceTier ?? null);
      }
      if (saved.accessPreset !== undefined) {
        this.store.setChatAccessPreset(scopeId, (saved.accessPreset as AccessPresetValue) ?? null);
      }
    } else {
      this.store.clearBinding(scopeId);
      const defaultEffort: ReasoningEffortValue = targetDesc.engineType === 'antigravity' ? 'high' : 'medium';
      this.store.setChatSettings(scopeId, null, defaultEffort);
      this.store.setChatServiceTier(scopeId, null);
    }

    const isCodex = targetDesc.engineType === 'codex';
    const activeSettings = this.store.getChatSettings(scopeId);
    const modelText = activeSettings?.model ? `\`${activeSettings.model}\`` : (locale === 'zh' ? '引擎默认' : 'default');
    const effortText = activeSettings?.reasoningEffort ?? (isCodex ? 'medium' : 'high');
    const modeText = activeSettings?.activeTurnMessageMode ?? 'queue';

    const switchMsg =
      locale === 'zh'
        ? `🔄 **已切换至后端: ${targetDesc.name}** (\`${targetDesc.id}\`)\n\n` +
          `• **引擎类型**: ${isCodex ? 'OpenAI Codex (App Server)' : 'Google Antigravity (AGY)'}\n` +
          `• **绑定账号**: \`${targetDesc.account || '默认账号'}\`${targetDesc.details ? ` (${targetDesc.details})` : ''}\n` +
          `• **会话状态**: ${saved?.threadId ? `已恢复历史会话 (\`${saved.threadId.slice(0, 16)}…\`)\n• **工作目录**: \`${saved.cwd ?? this.config.defaultCwd}\`` : '新会话就绪 (发送消息将开启新会话)'}\n` +
          `• **记忆配置**: 模型 ${modelText} | 思考深度 \`${effortText}\` | 插话模式 \`${modeText}\`\n` +
          `• **专属指令**: \`/models\` (${isCodex ? 'Codex模型' : 'Gemini模型'}), \`/auth\` (${isCodex ? 'OpenAI账号池' : 'Google授权'}), \`/threads\` (${isCodex ? 'Codex历史' : 'AGY历史'})\n\n` +
          `⚡ **当前 Telegram Bot 已完全切换为 ${isCodex ? 'OpenAI Codex' : 'Google Antigravity'} 交互人格与执行引擎！**`
        : `🔄 **Switched to Backend: ${targetDesc.name}** (\`${targetDesc.id}\`)\n\n` +
          `• **Engine**: ${isCodex ? 'OpenAI Codex (App Server)' : 'Google Antigravity (AGY)'}\n` +
          `• **Account**: \`${targetDesc.account || 'default'}\`${targetDesc.details ? ` (${targetDesc.details})` : ''}\n` +
          `• **Thread**: ${saved?.threadId ? `Restored (\`${saved.threadId.slice(0, 16)}…\`)\n• **Directory**: \`${saved.cwd ?? this.config.defaultCwd}\`` : 'Ready (next prompt starts new thread)'}\n` +
          `• **Restored Settings**: Model ${modelText} | Effort \`${effortText}\` | Message Mode \`${modeText}\`\n\n` +
          `⚡ **Telegram Bot is now fully operated by ${isCodex ? 'OpenAI Codex' : 'Google Antigravity'}!**`;

    try {
      await this.sendMessage(scopeId, switchMsg);
    } catch (err) {
      this.logger.warn('orchestrator.switch_announce_failed', { error: String(err) });
    }

    try {
      if (scopeId.startsWith(BRIDGE_SCOPE_TELEGRAM_PREFIX)) {
        const target = parseTelegramTargetFromBridgeScope(scopeId);
        const cmds = isCodex ? getTelegramCommands(locale) : getAntigravityTelegramCommands(locale);
        await this.bot.setChatCommands(target.chatId, cmds);
      }
    } catch (err) {
      this.logger.warn('orchestrator.set_chat_commands_failed', { error: String(err) });
    }

    this.logger.info('orchestrator.backend_switched', {
      scopeId,
      from: currentBackendId,
      to: targetBackendId,
      restoredThreadId: saved?.threadId ?? null,
    });

    return {
      previousBackendId: currentBackendId,
      newBackendId: targetBackendId,
      restoredThreadId: saved?.threadId ?? null,
      cwd: saved?.cwd ?? null,
    };
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

  dispatchInboundLikeTelegramText(event: TelegramTextEvent): void {
    this.handleText(event).catch((err) => {
      this.logger.error('orchestrator.inbound_text_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async start(): Promise<void> {
    await this.bot.start();
    this.logger.info('orchestrator.started', {
      defaultEngine: this.adapter.id,
      backends: Array.from(this.backends.keys()),
    });

    // Crash recovery: check interrupted preview messages from before restart
    try {
      const backendIds = new Set(this.backends.keys());
      for (const desc of this.backends.values()) {
        backendIds.add(desc.adapter.id);
      }
      const activePreviews = this.store.listActiveTurnPreviews().filter((p) => {
        for (const bId of backendIds) {
          if (p.turnId.startsWith(`${bId}_`)) return true;
        }
        return false;
      });
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
            this.syncCurrentBackendSettings(scopeId);
            await this.sendMessage(
              scopeId,
              locale === 'zh' ? `✅ 模型已切换为: \`${argsString}\`` : `✅ Model switched to: \`${argsString}\``,
            );
          } else {
            await this.sendModelsMenu(scopeId, locale);
          }
          return;
        case 'backend':
        case 'backends':
        case 'engine':
        case 'engines':
          await this.handleBackendCommand(scopeId, argsString, locale);
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
          await this.handleNewSession(scopeId, locale, argsString);
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
      const handled = await this.customUi.handleCustomCallback(scopeId, data, locale, messageId, event);
      if (handled) return;
    }

    if (data.startsWith('engine:backend:')) {
      const targetId = data.slice('engine:backend:'.length);
      try {
        const targetDesc = await this.resolveBackendDescriptor(targetId);
        if (targetDesc) {
          await this.switchBackend(scopeId, targetId, locale);
          await this.messaging.answerCallback(
            event.callbackQueryId,
            locale === 'zh' ? `已切换到: ${targetDesc.name}` : `Switched to: ${targetDesc.name}`,
          );
        } else {
          await this.messaging.answerCallback(
            event.callbackQueryId,
            locale === 'zh' ? '未找到对应后端服务' : 'Backend not found',
          );
        }
      } catch (err) {
        await this.messaging.answerCallback(
          event.callbackQueryId,
          locale === 'zh' ? `切换失败: ${String(err)}` : `Switch failed: ${String(err)}`,
        );
      }
      await this.sendSetupMenu(scopeId, locale, messageId);
      return;
    }

    if (data.startsWith('engine:m:') || data.startsWith('setup:model:')) {
      const rawModel = data.startsWith('engine:m:')
        ? data.slice('engine:m:'.length)
        : decodeURIComponent(data.slice('setup:model:'.length));
      const model = rawModel === 'default' ? null : rawModel;
      this.store.setChatSettings(scopeId, model, null);
      this.syncCurrentBackendSettings(scopeId);
      await this.messaging.answerCallback(event.callbackQueryId, `Model: ${rawModel}`);
      await this.sendSetupMenu(scopeId, locale, messageId);
      return;
    }

    if (data.startsWith('engine:effort:') || data.startsWith('setup:effort:')) {
      const rawEffort = data.startsWith('engine:effort:')
        ? data.slice('engine:effort:'.length)
        : data.slice('setup:effort:'.length);
      const targetEffort = rawEffort === 'default' ? null : (rawEffort as ReasoningEffortValue);
      const settings = this.store.getChatSettings(scopeId);
      if (targetEffort !== 'high' && settings?.serviceTier === 'boost') {
        this.store.setChatServiceTier(scopeId, null);
      }
      this.store.setChatSettings(scopeId, null, targetEffort);
      this.syncCurrentBackendSettings(scopeId);
      await this.messaging.answerCallback(event.callbackQueryId, `Effort: ${rawEffort}`);
      await this.sendSetupMenu(scopeId, locale, messageId);
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
        this.syncCurrentBackendSettings(scopeId);
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
        this.syncCurrentBackendSettings(scopeId);
        await this.messaging.answerCallback(
          event.callbackQueryId,
          next === 'steer' ? '已切换为：⚡ 插话模式' : '已切换为：⏳ 排队模式',
        );
        await this.sendSetupMenu(scopeId, locale, messageId);
        return;
      }
      if (sub === 'backend') {
        await this.messaging.answerCallback(event.callbackQueryId, '');
        await this.sendBackendMenu(scopeId, locale, messageId);
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
    const adapter = this.getAdapterForScope(scopeId);
    const queueId = `${adapter.id}_q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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
    const adapter = this.getAdapterForScope(scopeId);

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
        ? (isBoost ? `🚀 ${adapter.name} (Boost 模式) 正在深度思考中…` : `⏳ ${adapter.name} 正在思考中…`)
        : (isBoost ? `🚀 ${adapter.name} (Boost Mode) is thinking deeply…` : `⏳ ${adapter.name} is thinking…`),
    );

    const turnKey = `${adapter.id}_${scopeId}_${Date.now()}`;
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

    if (adapter.preflightTurn) {
      try {
        await adapter.preflightTurn(req);
      } catch (err) {
        this.logger.warn('orchestrator.preflight_failed', { error: String(err) });
      }
    }

    const execution = adapter.executeTurn(req);

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
      stepIndex: 1,
      toolCount: 0,
      currentTool: null,
      startTime: Date.now(),
    };

    this.activeTurns.set(scopeId, activeTurn);

    this.messaging.sendTypingInScope(scopeId).catch(() => {});
    activeTurn.typingTimer = setInterval(() => {
      this.messaging.sendTypingInScope(scopeId).catch(() => {});
      scheduleFlush();
    }, TYPING_INTERVAL_MS);
    activeTurn.typingTimer?.unref?.();

    const scheduleFlush = () => {
      if (activeTurn.flushTimer) return;
      const elapsed = Date.now() - activeTurn.lastFlushTime;
      const delay = Math.max(0, STREAM_THROTTLE_MS - elapsed);
      activeTurn.flushTimer = setTimeout(() => {
        activeTurn.flushTimer = null;
        activeTurn.lastFlushTime = Date.now();
        const elapsedSeconds = Math.max(1, Math.floor((Date.now() - activeTurn.startTime) / 1000));
        const content = renderStreamPreviewContent({
          toolLines: activeTurn.toolLines,
          accumulatedText: activeTurn.accumulatedText,
          isBoost,
          engineName: adapter.name,
          stepIndex: activeTurn.stepIndex,
          toolCount: activeTurn.toolCount,
          currentTool: activeTurn.currentTool,
          elapsedSeconds,
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
      if (tool.stepIndex && tool.stepIndex > 0) {
        activeTurn.stepIndex = tool.stepIndex;
      }
      const icon = tool.status === 'running' ? '⚙️' : tool.status === 'failed' ? '❌' : '✅';
      const summaryText = tool.summary ? ` · ${escapeTelegramHtml(tool.summary)}` : '';
      const line = `${icon} <code>${escapeTelegramHtml(tool.name)}</code>${summaryText}`;

      if (tool.status === 'running') {
        activeTurn.toolCount += 1;
        activeTurn.currentTool = tool.summary ? `${tool.name} (${tool.summary})` : tool.name;
        activeTurn.toolLines.push(line);
      } else {
        if (activeTurn.currentTool && activeTurn.currentTool.startsWith(tool.name)) {
          activeTurn.currentTool = null;
        }
        const lastIdx = activeTurn.toolLines.findLastIndex((l) => l.includes(`<code>${escapeTelegramHtml(tool.name)}</code>`));
        if (lastIdx !== -1) {
          activeTurn.toolLines[lastIdx] = line;
        } else {
          activeTurn.toolLines.push(line);
        }
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
        this.syncCurrentBackendSettings(scopeId);
      }

      if (res.usage) {
        this.store.recordTokenUsage(
          {
            inputTokens: res.usage.inputTokens,
            outputTokens: res.usage.outputTokens,
            cachedTokens: res.usage.cachedTokens,
            totalTokens: res.usage.totalTokens,
          },
          adapter.id,
        );
      }

      if (res.status === 'SUCCESS') {
        let finalText = (res.response || '').trim();
        if (!finalText && activeTurn.accumulatedText) {
          finalText = activeTurn.accumulatedText.trim();
        }

        let foldedTools = '';
        if (activeTurn.toolLines.length > 0) {
          const roundText = activeTurn.stepIndex && activeTurn.stepIndex > 1 ? ` · 共 ${activeTurn.stepIndex} 轮` : '';
          foldedTools = `<blockquote expandable>🛠️ <b>执行小结${roundText} · 累计执行 ${activeTurn.toolLines.length} 次工具</b>\n${activeTurn.toolLines.join('\n')}</blockquote>\n\n`;
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
        const errorText = (res.error || res.response || (res as any).error || 'Unknown error').trim();
        if (adapter.handleTurnError) {
          const handled = await adapter.handleTurnError({
            error: errorText,
            request: req,
            retryCount,
            retryTurn,
            sendMessage: (text: string) => this.sendMessage(scopeId, text),
            editMessage: (messageId: number, text: string) => this.editMessage(scopeId, messageId, text),
          });
          if (handled) return;
        }

        // If the agent actually produced substantive response text, do NOT mask it with an error box!
        let finalText = (res.response || '').trim();
        if (!finalText && activeTurn.accumulatedText) {
          finalText = activeTurn.accumulatedText.trim();
        }

        const isPureError =
          !finalText ||
          finalText === errorText ||
          finalText.startsWith('Process exited with code') ||
          finalText.startsWith('Verification Required') ||
          finalText.startsWith('Error:') ||
          finalText.length <= 20;

        if (!isPureError) {
          let foldedTools = '';
          if (activeTurn.toolLines.length > 0) {
            const roundText = activeTurn.stepIndex && activeTurn.stepIndex > 1 ? ` · 共 ${activeTurn.stepIndex} 轮` : '';
            foldedTools = `<blockquote expandable>🛠️ <b>执行小结${roundText} · 累计执行 ${activeTurn.toolLines.length} 次工具</b>\n${activeTurn.toolLines.join('\n')}</blockquote>\n\n`;
          }

          const warningNote =
            errorText && errorText !== 'Unknown error' && errorText !== 'Antigravity execution failed'
              ? `\n\n⚠️ <i>(注意：任务结束时伴随提示: ${escapeTelegramHtml(errorText.slice(0, 120))})</i>`
              : '';
          const fullText = foldedTools + finalText + warningNote;
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

        await this.editMessage(
          scopeId,
          activeTurn.messageId,
          `❌ **${adapter.name} 错误**:\n\`\`\`\n${errorText}\n\`\`\``,
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

      if (adapter.handleTurnError) {
        const handled = await adapter.handleTurnError({
          error: err.message,
          request: req,
          retryCount,
          retryTurn,
          sendMessage: (text: string) => this.sendMessage(scopeId, text),
          editMessage: (messageId: number, text: string) => this.editMessage(scopeId, messageId, text),
        });
        if (handled) return;
      }

      if (activeTurn.accumulatedText && activeTurn.accumulatedText.trim().length > 20) {
        let foldedTools = '';
        if (activeTurn.toolLines.length > 0) {
          const roundText = activeTurn.stepIndex && activeTurn.stepIndex > 1 ? ` · 共 ${activeTurn.stepIndex} 轮` : '';
          foldedTools = `<blockquote expandable>🛠️ <b>执行小结${roundText} · 累计执行 ${activeTurn.toolLines.length} 次工具</b>\n${activeTurn.toolLines.join('\n')}</blockquote>\n\n`;
        }
        const fullText =
          foldedTools +
          activeTurn.accumulatedText.trim() +
          `\n\n⚠️ <i>(注意：任务执行中途异常中断: ${escapeTelegramHtml(err.message.slice(0, 120))})</i>`;
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
      this.syncCurrentBackendSettings(scopeId);
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
    this.syncCurrentBackendSettings(scopeId);
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
      this.syncCurrentBackendSettings(scopeId);
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

  async handleNewSession(scopeId: string, locale: AppLocale, targetCwdInput?: string): Promise<void> {
    const rawTarget = targetCwdInput?.trim();
    const binding = this.store.getBinding(scopeId);
    let cwd = binding?.cwd || this.config.defaultCwd;

    if (rawTarget) {
      let resolved = rawTarget;
      if (resolved.startsWith('~')) {
        resolved = path.join(os.homedir(), resolved.slice(1));
      } else if (!path.isAbsolute(resolved)) {
        resolved = path.resolve(cwd, resolved);
      }
      resolved = path.normalize(resolved);

      if (!fs.existsSync(resolved)) {
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `❌ **指定的工作目录不存在**：\`${resolved}\`\n请检查路径是否正确。`
            : `❌ **Directory does not exist**: \`${resolved}\``,
        );
        return;
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `❌ **指定的路径不是一个目录**：\`${resolved}\``
            : `❌ **Path is not a directory**: \`${resolved}\``,
        );
        return;
      }
      cwd = resolved;
    }

    // Cancel queued turn inputs
    this.store.cancelQueuedTurnInputs(scopeId);

    const active = this.activeTurns.get(scopeId);
    if (active) {
      active.execution.cancel();
      if (active.typingTimer) clearInterval(active.typingTimer);
      if (active.flushTimer) clearTimeout(active.flushTimer);
      this.activeTurns.delete(scopeId);
    }

    // Reset thread binding to empty/ready state with the target cwd
    this.store.setBinding(scopeId, '', cwd);

    this.syncCurrentBackendSettings(scopeId);

    const adapter = this.getAdapterForScope(scopeId);
    await this.sendMessage(
      scopeId,
      locale === 'zh'
        ? `✨ **已开启全新会话**\n• 当前引擎: **${adapter.name}**\n• 工作目录: \`${cwd}\`\n\n发送任意消息开启新任务。`
        : `✨ **New Session Created**\n• Engine: **${adapter.name}**\n• Directory: \`${cwd}\`\n\nSend a message to start.`,
    );
  }

  async sendStatus(scopeId: string, locale: AppLocale): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);
    const isBusy = this.activeTurns.has(scopeId);
    const backendDesc = this.getBackendDescriptorForScope(scopeId);
    const adapter = backendDesc.adapter;
    const customStatus = this.customUi?.renderCustomStatus ? await this.customUi.renderCustomStatus(scopeId, locale) : '';

    const totalUsage = this.store.getCumulativeTokenUsage();
    const tokenLine = formatTokenUsageSummary(totalUsage, locale);
    const allUsages = this.store.getAllBackendTokenUsages();
    const breakdown = formatBackendTokenUsageBreakdown(allUsages);

    const text =
      locale === 'zh'
        ? `📊 **${adapter.name} 运行状态**\n\n` +
          `• **当前引擎**: \`${backendDesc.name}\` (\`${backendDesc.id}\`)${backendDesc.account ? ` · \`${backendDesc.account}\`` : ''}\n` +
          `• **状态**: ${isBusy ? '⚡ 正在执行任务' : '💤 空闲'}\n` +
          `• **当前模型**: \`${settings?.model || '默认'}\`\n` +
          `${tokenLine}${breakdown}\n` +
          `• **绑定会话**: \`${binding?.threadId || '(新会话)'}\`\n` +
          `• **工作目录**: \`${binding?.cwd || this.config.defaultCwd}\`` +
          (customStatus ? `\n${customStatus}` : '')
        : `📊 **${adapter.name} Status**\n\n` +
          `• **Engine**: \`${backendDesc.name}\` (\`${backendDesc.id}\`)${backendDesc.account ? ` · \`${backendDesc.account}\`` : ''}\n` +
          `• **State**: ${isBusy ? '⚡ Executing' : '💤 Idle'}\n` +
          `• **Model**: \`${settings?.model || 'default'}\`\n` +
          `${tokenLine}${breakdown}\n` +
          `• **Thread**: \`${binding?.threadId || '(new)'}\`\n` +
          `• **Directory**: \`${binding?.cwd || this.config.defaultCwd}\`` +
          (customStatus ? `\n${customStatus}` : '');

    const keyboard: InlineKeyboard = [
      [
        { text: '⚙️ 控制面板', callback_data: 'engine:setup:main' },
        { text: '🧠 切换模型', callback_data: 'engine:setup:models' },
      ],
    ];

    const allBackends = await this.listBackends();
    if (allBackends.length > 1 || this.backendProvider) {
      keyboard.push([
        { text: `🔌 切换后端 (${allBackends.length})`, callback_data: 'engine:setup:backend' },
      ]);
    }

    const msgId = await this.sendMessage(scopeId, text, keyboard);
    this.scheduleStalePanelDeletion(scopeId, msgId);
  }

  async sendSetupMenu(scopeId: string, locale: AppLocale, editMessageId?: number): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const mode = settings?.activeTurnMessageMode ?? 'queue';
    const isBoost = settings?.serviceTier === 'boost';
    const backendDesc = this.getBackendDescriptorForScope(scopeId);
    const adapter = backendDesc.adapter;
    const allBackends = await this.listBackends();

    const currentModel = settings?.model;
    const currentEffort = isBoost ? 'high' : (settings?.reasoningEffort ?? null);

    const text =
      locale === 'zh'
        ? `⚙️ **${adapter.name} 控制面板**\n\n` +
          `• **当前引擎**: \`${backendDesc.name}\` (\`${backendDesc.id}\`)${backendDesc.account ? ` · \`${backendDesc.account}\`` : ''}\n` +
          `• **当前模型**: \`${settings?.model || '默认'}\`\n` +
          `• **思考深度**: \`${currentEffort || '默认'}\`\n` +
          `• **Boost 增强**: ${isBoost ? '🚀 已开启' : '⚪ 已关闭'}\n` +
          `• **运行中消息**: ${mode === 'steer' ? '⚡ 插话 (立即中断接管)' : '⏳ 排队 (完成后自动执行)'}\n\n` +
          `请选择要配置的项目：`
        : `⚙️ **${adapter.name} Setup Panel**\n\n` +
          `• **Engine**: \`${backendDesc.name}\` (\`${backendDesc.id}\`)${backendDesc.account ? ` · \`${backendDesc.account}\`` : ''}\n` +
          `• **Model**: \`${settings?.model || 'default'}\`\n` +
          `• **Effort**: \`${currentEffort || 'default'}\`\n` +
          `• **Boost**: ${isBoost ? '🚀 Enabled' : '⚪ Disabled'}\n` +
          `• **Active-Turn**: ${mode === 'steer' ? '⚡ Steer' : '⏳ Queue'}\n\n` +
          `Select setting to configure:`;

    const keyboard: InlineKeyboard = [];

    // 1. Model choices (Codex style)
    const models = await adapter.listModels();
    const modelButtons: InlineKeyboard[0] = [
      {
        text: `${!currentModel || currentModel === 'default' ? '• ' : ''}${locale === 'zh' ? '默认模型' : 'Default'}`,
        callback_data: 'engine:m:default',
      },
    ];
    for (const m of models.slice(0, 5)) {
      const isAct = currentModel === m.id || (!currentModel && m.isDefault);
      const label = m.name.length > 14 ? `${m.name.slice(0, 13)}…` : m.name;
      modelButtons.push({
        text: `${isAct ? '• ' : ''}${label}`,
        callback_data: `engine:m:${m.id}`,
      });
    }
    for (let i = 0; i < modelButtons.length; i += 2) {
      keyboard.push(modelButtons.slice(i, i + 2));
    }

    // 2. Reasoning effort choices (Codex style)
    const isAgy = backendDesc.engineType === 'antigravity' || backendDesc.id === 'antigravity';
    const isCodex = backendDesc.engineType === 'codex' || backendDesc.id === 'codex';
    const supportedEfforts: string[] = isAgy
      ? ['low', 'medium', 'high']
      : isCodex
        ? ['low', 'medium', 'high', 'xhigh', 'max']
        : ['low', 'medium', 'high'];

    const effortButtons: InlineKeyboard[0] = [
      {
        text: `${!currentEffort || (currentEffort as string) === 'default' ? '• ' : ''}${locale === 'zh' ? '默认深度' : 'Default'}`,
        callback_data: 'engine:effort:default',
      },
      ...supportedEfforts.map((eff) => ({
        text: `${currentEffort === eff ? '• ' : ''}${eff}`,
        callback_data: `engine:effort:${eff}`,
      })),
    ];
    for (let i = 0; i < effortButtons.length; i += 3) {
      keyboard.push(effortButtons.slice(i, i + 3));
    }

    // 3. Boost & Active Mode row
    keyboard.push([
      {
        text: isBoost ? (locale === 'zh' ? '🚀 Boost: 开启' : '🚀 Boost: On') : (locale === 'zh' ? '⚪ Boost: 关闭' : '⚪ Boost: Off'),
        callback_data: 'engine:setup:boost',
      },
      {
        text: mode === 'steer' ? (locale === 'zh' ? '⚡ 插话模式' : '⚡ Steer') : (locale === 'zh' ? '⏳ 排队模式' : '⏳ Queue'),
        callback_data: 'engine:setup:active_mode',
      },
    ]);

    // 4. Custom rows (Account & History)
    if (this.customUi?.renderCustomSetupRows) {
      const customRows = await this.customUi.renderCustomSetupRows(scopeId, locale);
      keyboard.push(...customRows);
    }

    // 5. Session & Backend switcher row
    keyboard.push([
      { text: '✨ 新建会话', callback_data: 'engine:setup:new' },
      { text: `🔌 切换后端运行环境 (${allBackends.length})`, callback_data: 'engine:setup:backend' },
    ]);

    // 6. Refresh row
    keyboard.push([
      { text: '🔄 刷新面板', callback_data: 'engine:setup:main' },
    ]);

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.sendMessage(scopeId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }

  async sendModelsMenu(scopeId: string, locale: AppLocale, editMessageId?: number): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const currentModel = settings?.model;
    const adapter = this.getAdapterForScope(scopeId);
    const models = await adapter.listModels();

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
        ? `🎯 **选择 ${adapter.name} 模型**`
        : `🎯 **Select ${adapter.name} Model**`;

    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, title, keyboard);
      this.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.sendMessage(scopeId, title, keyboard);
      this.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }

  async sendHelp(scopeId: string, locale: AppLocale): Promise<void> {
    const adapter = this.getAdapterForScope(scopeId);
    const text =
      locale === 'zh'
        ? `🦊 **FoxClaw — ${adapter.name} 使用指南**\n\n` +
          `• 直接发送消息即可向 AI 发起提问或任务\n` +
          `• 发送照片、文件等多媒体，AI 可自动下载落盘并分析\n\n` +
          `**常用命令：**\n` +
          `/setup — 控制面板（切换模型、插话/排队模式管理）\n` +
          `/backend — 切换当前后端引擎与账号（如 Google Antigravity / OpenAI Codex / OpenCode）\n` +
          `/models — 快速切换 AI 模型\n` +
          `/threads — 查看与切换会话历史\n` +
          `/status — 查看当前运行状态与会话信息\n` +
          `/interrupt — 中断当前正在运行的任务\n` +
          `/new — 清空历史并新建会话\n` +
          `/help — 显示本帮助手册\n`
        : `🦊 **FoxClaw — ${adapter.name} Quick Guide**\n\n` +
          `• Send any prompt to chat or run tasks\n` +
          `• Send photos or documents for AI inspection\n\n` +
          `**Commands:**\n` +
          `/setup — Control panel\n` +
          `/backend — Switch active backend engine or account\n` +
          `/models — Switch model\n` +
          `/threads — List and switch conversations\n` +
          `/status — Check runtime status\n` +
          `/interrupt — Stop active turn\n` +
          `/new — Start fresh session\n` +
          `/help — Show this help\n`;

    const msgId = await this.sendMessage(scopeId, text);
    this.scheduleStalePanelDeletion(scopeId, msgId);
  }

  async sendBackendMenu(scopeId: string, locale: AppLocale, editMessageId?: number): Promise<void> {
    const backends = await this.listBackends();
    const activeBackend = this.getBackendDescriptorForScope(scopeId);
    const binding = this.store.getBinding(scopeId);

    const lines: string[] = [
      locale === 'zh' ? '🔌 **后端运行环境 (Backends & Engines)**' : '🔌 **Backends & Engines**',
      '',
      locale === 'zh'
        ? `• **当前活跃**: ● **${activeBackend.name}** (\`${activeBackend.id}\`)`
        : `• **Active**: ● **${activeBackend.name}** (\`${activeBackend.id}\`)`,
    ];

    if (activeBackend.account) {
      lines.push(locale === 'zh' ? `• **绑定账号**: \`${activeBackend.account}\`` : `• **Account**: \`${activeBackend.account}\``);
    }
    if (activeBackend.details) {
      lines.push(locale === 'zh' ? `• **状态详情**: ${activeBackend.details}` : `• **Details**: ${activeBackend.details}`);
    }
    if (binding?.threadId) {
      lines.push(
        locale === 'zh'
          ? `• **当前会话**: \`${binding.threadId.slice(0, 16)}…\` (\`${binding.cwd ?? this.config.defaultCwd}\`)`
          : `• **Thread**: \`${binding.threadId.slice(0, 16)}…\` (\`${binding.cwd ?? this.config.defaultCwd}\`)`,
      );
    } else {
      lines.push(
        locale === 'zh'
          ? `• **会话状态**: 未绑定 (发送新消息将开启新会话)`
          : `• **Thread**: None (next prompt starts new thread)`,
      );
    }

    lines.push('', '───────────────────', locale === 'zh' ? '**可用后端列表**：' : '**Available Backends**:');

    const keyboard: InlineKeyboard = [];

    backends.forEach((b, idx) => {
      const isCurrent = b.id === activeBackend.id;
      const marker = isCurrent ? '●' : '○';
      const badge = isCurrent ? (locale === 'zh' ? ' [当前活跃]' : ' [Active]') : '';
      const num = idx + 1;

      lines.push(`${marker} **${num}.** ${b.name}${badge}`);
      if (b.details || b.account) {
        lines.push(`   ${b.details || b.account}`);
      }

      keyboard.push([
        {
          text: `${marker} ${num}. ${b.name.length > 24 ? `${b.name.slice(0, 23)}…` : b.name}`,
          callback_data: `engine:backend:${b.id}`,
        },
      ]);
    });

    keyboard.push([{ text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' }]);

    const text = lines.join('\n');
    if (editMessageId) {
      await this.editMessage(scopeId, editMessageId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.sendMessage(scopeId, text, keyboard);
      this.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }

  async handleBackendCommand(scopeId: string, argsString: string, locale: AppLocale): Promise<void> {
    if (!argsString) {
      await this.sendBackendMenu(scopeId, locale);
      return;
    }

    const backends = await this.listBackends();
    let targetId = argsString.trim().toLowerCase();
    if (targetId.includes('反重力') || targetId === 'agy' || targetId === 'gemini') {
      targetId = 'antigravity';
    } else if (targetId.includes('codex') || targetId.includes('openai')) {
      targetId = 'codex';
    }

    // Check if target is a number index
    const num = parseInt(targetId, 10);
    if (!isNaN(num) && num >= 1 && num <= backends.length) {
      targetId = backends[num - 1]!.id;
    } else {
      // Find matching by id or name
      const found = backends.find(
        (b) => b.id.toLowerCase() === targetId || b.name.toLowerCase().includes(targetId),
      );
      if (found) {
        targetId = found.id;
      }
    }

    const targetDesc = await this.resolveBackendDescriptor(targetId);
    if (!targetDesc) {
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `❌ 未找到后端: \`${argsString}\`。可用列表: ${backends.map((b) => `\`${b.id}\``).join(', ')}`
          : `❌ Backend not found: \`${argsString}\`. Available: ${backends.map((b) => `\`${b.id}\``).join(', ')}`,
      );
      return;
    }

    await this.switchBackend(scopeId, targetId, locale);
    await this.sendSetupMenu(scopeId, locale);
  }
}
