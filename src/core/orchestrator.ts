import { ListenerScope } from './listener_scope.js';
import { randomUUID } from 'node:crypto';
import type { JournalTask } from '../store/task_journal.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { AppLocale, AccessPresetValue, ActiveTurnMessageMode } from '../types.js';
import type { ChannelGateway, ChannelPort, ChannelInlineKeyboard } from './channel_port.js';
import type { ChannelTextEvent, ChannelCallbackEvent, ChannelInbound } from './channel_events.js';
import { parseCommand } from '../controller/commands.js';
import { chunkMessage, escapeHtml } from './message_text.js';
import { stageInboundAttachments } from './attachments.js';
import type { StagedAttachment } from './attachment_types.js';
import type { TurnMessageMode } from './turn_queue.js';
import { BackendRegistry } from './backend_registry.js';
import { decodeQueuedEngineInput } from './queued_engine_input.js';
import { ScopeOperations } from './scope_operations.js';
import type { EngineCustomUiHook } from './backend_ui.js';
export type { EngineCustomUiHook } from './backend_ui.js';
import { renderStreamPreviewContent, buildFoldedToolsSummary, combineSummaryAndResponse } from './stream_preview.js';
import { formatTokenUsageSummary, formatBackendTokenUsageBreakdown } from '../store/token_usage.js';
import { isTransientNetworkError } from './network_errors.js';
import type { IEngineAdapter, EngineTurnExecution, EngineTurnResult, EngineCommentaryEvent, BackendDescriptor } from './engine_spi.js';

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
  suppressQueueDrain?: boolean;
  startTime: number;
  previewKey: string;
  queueId?: string | undefined;
  taskId: string;
  settling?: boolean;
  separateFinal?: boolean;
  commentaryIds?: Set<string>;
}

export class UnifiedChannelOrchestrator {
  readonly config: AppConfig;
  readonly store: BridgeStore;
  readonly logger: Logger;
  readonly bot: ChannelGateway;
  readonly messaging: ChannelPort;
  readonly customUi?: EngineCustomUiHook | undefined;

  private readonly backends: BackendRegistry;
  private readonly scopeOperations = new ScopeOperations();
  private readonly messageOperations = new ScopeOperations();
  private readonly settlements = new Set<Promise<void>>();
  private stopped = false;
  private readonly serviceUi?: EngineCustomUiHook | undefined;
  private readonly defaultBackendId: string;
  private readonly activeTurns = new Map<string, UnifiedActiveTurn>();
  private readonly stalePanelDeleteTimers = new Map<string, NodeJS.Timeout>();
  private readonly recoveryTimers = new Set<NodeJS.Timeout>();
  private readonly ownsScope: (scopeId: string) => boolean;
  private readonly backendProvider?: (() => Promise<BackendDescriptor[]> | BackendDescriptor[]) | undefined;

  get adapter(): IEngineAdapter {
    return this.getAdapterForBackend(this.defaultBackendId);
  }

  constructor(options: {
    config: AppConfig;
    store: BridgeStore;
    logger: Logger;
    bot: ChannelGateway;
    adapter?: IEngineAdapter;
    adapters?: Map<string, IEngineAdapter> | IEngineAdapter[];
    backends?: BackendDescriptor[];
    backendProvider?: (() => Promise<BackendDescriptor[]> | BackendDescriptor[]) | undefined;
    defaultBackendId?: string;
    ownsScope?: (scopeId: string) => boolean;
    messaging: ChannelPort;
    customUi?: EngineCustomUiHook | undefined;
    serviceUi?: EngineCustomUiHook | undefined;
  }) {
    this.config = options.config;
    this.store = options.store;
    this.logger = options.logger;
    this.bot = options.bot;
    this.messaging = options.messaging;
    this.backends = new BackendRegistry(this);
    this.serviceUi = options.serviceUi;
    this.customUi = options.customUi;
    this.backendProvider = options.backendProvider;
    this.ownsScope = options.ownsScope ?? (() => true);

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
    if (!this.backends.has(this.defaultBackendId)) throw new Error(`Default backend '${this.defaultBackendId}' is not registered`);
  }

  getAdapterForScope(scopeId: string): IEngineAdapter {
    const activeBackendId = this.store.getActiveBackend(scopeId) || this.defaultBackendId;
    return this.getAdapterForBackend(activeBackendId);
  }

  getBackendDescriptorForScope(scopeId: string): BackendDescriptor {
    const id = this.store.getActiveBackend(scopeId) || this.defaultBackendId;
    const backend = this.backends.get(id);
    if (!backend) throw new Error(`Backend '${id}' is unavailable; use /backend to select an available backend`);
    return backend;
  }

  getAdapterForBackend(backendId: string): IEngineAdapter {
    const backend = this.backends.get(backendId);
    if (!backend) throw new Error(`Backend '${backendId}' is unavailable`);
    return backend.adapter;
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
          this.backends.set(b.id, b);
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
    if (this.config.telegramPanelTtlMs <= 0 || this.messaging.capabilities?.editableMessages === false) {
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

  async switchBackend(scopeId: string, targetBackendId: string, locale: AppLocale) {
    return this.scopeOperations.run(scopeId, () => this.switchBackendNow(scopeId, targetBackendId, locale));
  }

  private async switchBackendNow(
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

    if (this.stopped) throw new Error('Orchestrator is stopped');
    if (this.activeTurns.has(scopeId) || (currentBackendId !== targetBackendId && (this.store.countQueuedTurnInputs(scopeId) > 0 || this.store.taskJournal.listUnfinished(scopeId).length > 0))) {
      throw new Error(locale === 'zh' ? '请先中断当前任务并清空队列，再切换后端。' : 'Interrupt the active turn and clear its queue before switching backends.');
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
        null,
      );
      this.store.setChatEngineEffort(scopeId, saved.reasoningEffort ?? null);
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
      this.store.setChatModel(scopeId, null);
      this.store.setChatEngineEffort(scopeId, targetDesc.defaults?.reasoningEffort ?? null);
      this.store.setChatAccessPreset(scopeId, null);
      this.store.setChatCollaborationMode(scopeId, null);
      this.store.setChatServiceTier(scopeId, null);
    }

    const activeSettings = this.store.getChatSettings(scopeId);
    const modelText = activeSettings?.model ? `\`${activeSettings.model}\`` : (locale === 'zh' ? '引擎默认' : 'default');
    const effortText = activeSettings?.reasoningEffort ?? targetDesc.defaults?.reasoningEffort ?? 'default';
    const modeText = activeSettings?.activeTurnMessageMode ?? 'queue';

    const switchMsg =
      locale === 'zh'
        ? `🔄 **已切换至后端: ${targetDesc.name}** (\`${targetDesc.id}\`)\n\n` +
          `• **引擎类型**: ${targetDesc.name}\n` +
          (targetDesc.account ? `• **绑定账号**: \`${targetDesc.account}\`\n` : '') +
          `• **会话状态**: ${saved?.threadId ? `已恢复历史会话 (\`${saved.threadId.slice(0, 16)}…\`)\n• **工作目录**: \`${saved.cwd ?? this.config.defaultCwd}\`` : '新会话就绪 (发送消息将开启新会话)'}\n` +
          `• **记忆配置**: 模型 ${modelText} | 思考深度 \`${effortText}\` | 插话模式 \`${modeText}\`\n` +
          `• **操作**: \`/setup\` · \`/models\` · \`/threads\``
        : `🔄 **Switched to Backend: ${targetDesc.name}** (\`${targetDesc.id}\`)\n\n` +
          `• **Engine**: ${targetDesc.name}\n` +
          (targetDesc.account ? `• **Account**: \`${targetDesc.account}\`\n` : '') +
          `• **Thread**: ${saved?.threadId ? `Restored (\`${saved.threadId.slice(0, 16)}…\`)\n• **Directory**: \`${saved.cwd ?? this.config.defaultCwd}\`` : 'Ready (next prompt starts new thread)'}\n` +
          `• **Restored Settings**: Model ${modelText} | Effort \`${effortText}\` | Message Mode \`${modeText}\`\n\n` +
          `• **Controls**: \`/setup\` · \`/models\` · \`/threads\``;

    try {
      await this.sendMessage(scopeId, switchMsg);
    } catch (err) {
      this.logger.warn('orchestrator.switch_announce_failed', { error: String(err) });
    }

    try {
      if (targetDesc.commands) await this.messaging.setScopeCommands?.(scopeId, targetDesc.commands(locale));
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

  private removeInboundConsumer: (() => void) | null = null;
  private readonly intakeOperations = new ScopeOperations();
  private async receiveInbound(id: string, inbound: ChannelInbound): Promise<void> {
    if (this.stopped || !this.ownsScope(inbound.event.scopeId)) return;
    const retained: ChannelInbound = inbound.kind === 'text' && (this.backends.sensitiveInboundOwner(inbound.event)
      || (this.store.getServiceInteraction(inbound.event.scopeId, 'sensitive-input') && !parseCommand(inbound.event.text)))
      ? { kind: 'text', event: { ...inbound.event, text: '', attachments: [], entities: [], redacted: true } } : inbound;
    if (!this.store.channelInbox.accept(id, retained)) return;
    await this.intakeOperations.run(id, async () => {
      if (this.stopped) return;
      if (!this.store.channelInbox.accept(id, retained)) return;
      if (inbound.kind === 'text') await this.handleText(inbound.event);
      else if (inbound.kind === 'callback') await this.handleCallback(inbound.event);
      else await this.stopTask(inbound.event.scopeId, inbound.event.taskId);
      if (!this.stopped) this.store.channelInbox.complete(id);
    });
  }

  private readonly inboundListeners = new ListenerScope();

  registerInboundHandlers(): void {
    this.inboundListeners.clear();
    this.removeInboundConsumer?.();
    if (this.bot.setInboundConsumer) {
      this.removeInboundConsumer = this.bot.setInboundConsumer((id, inbound) => this.receiveInbound(id, inbound));
      return;
    }
    this.inboundListeners.listen(this.bot, 'text', (event: ChannelTextEvent) => {
      this.handleText(event).catch((err) => {
        this.logger.error('orchestrator.inbound_text_error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.inboundListeners.listen(this.bot, 'callback', (event: ChannelCallbackEvent) => {
      this.handleCallback(event).catch((err) => {
        this.logger.error('orchestrator.inbound_callback_error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  dispatchInboundLikeTelegramText(event: ChannelTextEvent): void {
    this.handleText(event).catch((err) => {
      this.logger.error('orchestrator.inbound_text_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.restoreDurableTasks();
    for (const pending of this.store.channelInbox.pending()) if (this.ownsScope(pending.inbound.event.scopeId)) {
      await this.receiveInbound(pending.id, pending.inbound).catch(error => this.logger.warn('orchestrator.intake_recovery_failed', { id: pending.id, error: String(error) }));
    }
    await this.bot.start();
    this.logger.info('orchestrator.started', {
      defaultEngine: this.adapter.id,
      backends: Array.from(this.backends.keys()),
    });

  }

  private recoveryEvent(scopeId: string, messageId = 0): ChannelTextEvent {
    return { scopeId, chatId: scopeId, topicId: null, chatType: 'private', userId: 'system', messageId,
      text: '', attachments: [], entities: [], replyToBot: false };
  }

  private async showRecovery(task: JournalTask): Promise<void> {
    const zh = task.request.locale === 'zh';
    const actions: ChannelInlineKeyboard = [[
      { text: zh ? '继续原任务' : 'Continue', callback_data: `engine:recover:continue:${task.id}` },
      { text: zh ? '重新执行' : 'Retry', callback_data: `engine:recover:retry:${task.id}` },
      { text: zh ? '放弃' : 'Cancel', callback_data: `engine:recover:cancel:${task.id}` },
    ]];
    await this.sendMessage(task.event.scopeId, zh
      ? `⚠️ **任务执行结果待确认**\n任务: \`${task.id}\`\n${task.error ? `提示: ${task.error}。` : '服务重启前可能已执行工具。'}原始输入与附件已保留，队列暂停。\n> ${task.sourcePrompt}\n\n/recover continue · /recover retry · /recover cancel`
      : `⚠️ **Task outcome requires confirmation**\nTask: \`${task.id}\`\n${task.error ? `Details: ${task.error}.` : 'Tools may already have run before the restart.'} Input and attachments are preserved; the queue is paused.\n> ${task.sourcePrompt}\n\n/recover continue · /recover retry · /recover cancel`, actions);
  }

  private async restoreDurableTasks(): Promise<void> {
    const tasks = this.store.taskJournal.listUnfinished().filter(task => this.ownsScope(task.event.scopeId));
    // A queued journal entry proves the executor was never invoked, even if queue claiming was interrupted.
    for (const task of tasks) if (task.state === 'queued' && task.queueId && this.store.getQueuedTurnInput(task.queueId)?.status === 'processing') {
      this.store.updateQueuedTurnInputStatus(task.queueId, 'queued');
    }
    // Claim uncertainty synchronously before recovering messages or starting any queued work.
    for (const task of tasks) if (task.state === 'running' && (!task.result || task.result.outcomeUnknown)) {
      this.store.taskJournal.update(task.id, 'awaiting_confirmation', { result: null });
    }
    // Import pre-journal previews and processing queues conservatively; their outcome is unknown.
    const journalScopes = new Set(tasks.filter(task => task.state !== 'queued').map(task => task.event.scopeId));
    for (const preview of this.store.listActiveTurnPreviews()) {
      if (!this.ownsScope(preview.scopeId) || journalScopes.has(preview.scopeId)) continue;
      const backend = [...this.backends.values()].find(b => preview.turnId.startsWith(`${b.adapter.id}_`));
      if (!backend) continue;
      const locale = this.store.getChatSettings(preview.scopeId)?.locale ?? 'zh';
      const queued = this.store.listQueuedTurnInputs(preview.scopeId).find(q => q.status === 'processing');
      const input = queued ? decodeQueuedEngineInput(queued.inputJson, queued.sourceSummary) : null;
      const event = this.recoveryEvent(preview.scopeId, preview.messageId);
      const task = this.captureTask(event, input?.prompt ?? (locale === 'zh' ? '继续重启前的任务' : 'Continue the task interrupted by restart'), locale, input?.stagedAttachments, queued?.queueId ?? null);
      this.store.taskJournal.update(task.id, 'running', { previewMessageId: preview.messageId, request: { ...task.request, threadId: preview.threadId || null } });
      this.store.taskJournal.update(task.id, 'awaiting_confirmation');
      journalScopes.add(preview.scopeId);
    }
    for (const queued of this.store.listQueuedTurnInputs()) {
      if (!this.ownsScope(queued.scopeId) || queued.status !== 'processing' || this.store.taskJournal.forQueue(queued.queueId)) continue;
      if (!this.backends.has(this.store.getActiveBackend(queued.scopeId) || this.defaultBackendId)) continue;
      const input = decodeQueuedEngineInput(queued.inputJson, queued.sourceSummary);
      const event = { ...this.recoveryEvent(queued.scopeId, queued.messageId ?? 0), chatId: queued.chatId, topicId: queued.topicId };
      const locale = this.store.getChatSettings(queued.scopeId)?.locale ?? 'zh';
      const task = this.captureTask(event, input.prompt, locale, input.stagedAttachments, queued.queueId);
      this.store.taskJournal.update(task.id, 'running');
      this.store.taskJournal.update(task.id, 'awaiting_confirmation');
    }
    for (let task of this.store.taskJournal.listUnfinished()) {
      if (!this.ownsScope(task.event.scopeId)) continue;
      if (task.state === 'running' && task.result) {
        const text = task.result.response || task.result.error || (task.request.locale === 'zh' ? '任务已结束' : 'Task ended');
        task = this.store.taskJournal.update(task.id, 'delivery_pending', { delivery: chunkMessage(text, this.messaging.capabilities?.maxMessageLength) });
      }
      if (task.state === 'awaiting_confirmation') await this.showRecovery(task).catch(error => this.logger.warn('orchestrator.recovery_notice_failed', { taskId: task.id, error: String(error) }));
      if (task.state === 'delivery_pending') {
        try { await this.deliverTaskChunks(task.id); this.resolveDeliveredTask(task.id); }
        catch (error) { this.logger.warn('orchestrator.delivery_retry_failed', { taskId: task.id, error: String(error) }); }
      }
      if (task.state === 'accepted') {
        const timer = setTimeout(() => {
          this.recoveryTimers.delete(timer);
          void this.scopeOperations.run(task.event.scopeId, async () => {
            if (this.stopped) return;
            const attachments = task.request.stagedAttachments ?? await stageInboundAttachments(this.messaging, task.request.cwd, task.request.threadId || 'default', task.event.attachments, this.logger);
            if (attachments.length !== task.event.attachments.length && !task.request.stagedAttachments) throw new Error('Recovery attachment staging failed');
            this.store.taskJournal.update(task.id, 'accepted', { request: { ...task.request, stagedAttachments: attachments } });
            if (this.activeTurns.has(task.event.scopeId) || this.recoveryBlocksScope(task.event.scopeId)) {
              await this.enqueuePromptTurn(task.event, task.sourcePrompt, task.request.locale, attachments, task.id);
            } else await this.executeTurn(task.event, task.sourcePrompt, task.request.locale, 0, attachments, { taskId: task.id, forcedThreadId: task.request.threadId ?? undefined });
          }).catch(async error => {
            this.logger.warn('orchestrator.accepted_recovery_failed', { taskId: task.id, error: String(error) });
            if (!this.stopped && this.store.taskJournal.get(task.id)?.state === 'accepted') {
              const waiting = this.store.taskJournal.update(task.id, 'awaiting_confirmation', { error: String(error) });
              await this.showRecovery(waiting).catch(() => {});
            }
          });
        }, 1500);
        this.recoveryTimers.add(timer); timer.unref();
      }
    }
    const scopes = new Set(this.store.listQueuedTurnInputs().filter(input => this.ownsScope(input.scopeId)).map(input => input.scopeId));
    for (const scopeId of scopes) {
      const timer = setTimeout(() => {
        this.recoveryTimers.delete(timer);
        void this.drainNextQueuedTurn(this.recoveryEvent(scopeId), this.store.getChatSettings(scopeId)?.locale ?? 'zh')
          .catch(error => this.logger.warn('orchestrator.queue_recovery_failed', { scopeId, error: String(error) }));
      }, 2000);
      this.recoveryTimers.add(timer); timer.unref();
    }
  }

  private resolveDeliveredTask(taskId: string): void {
    const task = this.store.taskJournal.get(taskId)!;
    const status = task.result?.status ?? 'SUCCESS';
    this.store.taskJournal.update(task.id, status === 'SUCCESS' ? 'completed' : status === 'INTERRUPTED' ? 'cancelled' : 'failed');
    if (task.queueId) this.store.updateQueuedTurnInputStatus(task.queueId, status === 'SUCCESS' ? 'completed' : status === 'INTERRUPTED' ? 'cancelled' : 'failed', task.result?.error ?? null);
    this.store.removeActiveTurnPreviewByMessage(task.event.scopeId, task.previewMessageId);
  }

  private async handleRecovery(scopeId: string, args: string, locale: AppLocale): Promise<void> {
    await this.scopeOperations.run(scopeId, async () => {
      const [action, id] = args.trim().split(/\s+/);
      const tasks = this.store.taskJournal.listUnfinished(scopeId).filter(task => task.state === 'awaiting_confirmation' || task.state === 'delivery_pending');
      const task = id ? tasks.find(task => task.id === id) : tasks.length === 1 ? tasks[0] : null;
      if (!task || !['continue', 'retry', 'deliver', 'cancel'].includes(action ?? '')) {
        await this.sendMessage(scopeId, tasks.length ? tasks.map(task => `\`${task.id}\` · ${task.state} · ${task.sourcePrompt}\n/recover continue|retry|deliver|cancel ${task.id}`).join('\n\n') : (locale === 'zh' ? '没有待恢复任务。' : 'No tasks to recover.'));
        return;
      }
      if (this.activeTurns.has(scopeId)) { await this.sendMessage(scopeId, locale === 'zh' ? '请先结束当前任务。' : 'Finish the active task first.'); return; }
      if (action === 'cancel') {
        this.store.taskJournal.update(task.id, 'cancelled');
        if (task.queueId) this.store.updateQueuedTurnInputStatus(task.queueId, 'cancelled');
        this.store.removeActiveTurnPreviewByMessage(scopeId, task.previewMessageId);
      } else if (task.state === 'delivery_pending') {
        await this.deliverTaskChunks(task.id);
        this.resolveDeliveredTask(task.id);
      } else if (action === 'continue' || action === 'retry') {
        if (!this.backends.has(task.backendId) || this.getBackendDescriptorForScope(scopeId).id !== task.backendId || (this.store.getBinding(scopeId)?.cwd || this.config.defaultCwd) !== task.request.cwd) {
          await this.sendMessage(scopeId, locale === 'zh' ? '原后端或目录不可用，请恢复原配置或放弃任务。' : 'Restore the original backend/directory, or cancel this task.'); return;
        }
        const prompt = action === 'continue'
          ? `${locale === 'zh' ? '服务重启前任务可能已执行部分操作。请检查当前状态，继续完成原任务，避免重复已完成的操作。' : 'This task may have partially executed before restart. Inspect current state and finish it, avoiding duplicate actions.'}\n\n${task.sourcePrompt}`
          : task.sourcePrompt;
        const stagedAttachments = task.request.stagedAttachments ?? await stageInboundAttachments(this.messaging, task.request.cwd, task.request.threadId || 'default', task.event.attachments, this.logger);
        if (stagedAttachments.length !== task.event.attachments.length && !task.request.stagedAttachments) {
          await this.sendMessage(scopeId, locale === 'zh' ? '附件恢复失败，请稍后重试或放弃任务。' : 'Attachment recovery failed. Retry later or cancel this task.'); return;
        }
        if (task.request.threadId) this.store.setBinding(scopeId, task.request.threadId, task.request.cwd);
        this.store.taskJournal.update(task.id, 'accepted', { request: { ...task.request, prompt, stagedAttachments }, result: null, delivery: [], deliveredChunks: 0, previewSettled: false, separateFinal: this.getAdapterForBackend(task.backendId).supportsCommentary === true, error: null });
        await this.executeTurn(task.event, prompt, locale, 0, stagedAttachments, { taskId: task.id, queueId: task.queueId ?? undefined, reuseMessageId: task.previewMessageId || undefined, forcedThreadId: task.request.threadId ?? undefined });
      }
    });
    if (!this.stopped) await this.drainNextQueuedTurn(this.recoveryEvent(scopeId), locale);
  }

  async stopTask(scopeId: string, taskId: string): Promise<boolean> {
    if (this.stopped || !this.ownsScope(scopeId)) return false;
    return this.scopeOperations.run(scopeId, async () => {
      const turn = this.activeTurns.get(scopeId);
      if (!turn || turn.taskId !== taskId || turn.settling) return false;
      await this.cancelActiveTurn(scopeId);
      return true;
    });
  }

  private async cancelActiveTurn(scopeId: string, preserveRecovery = false): Promise<void> {
    const turn = this.activeTurns.get(scopeId);
    if (!turn) return;
    if (turn.settling) throw new Error('任务正在收尾，请等待结果交付完成。');
    // Retain the slot until cancellation completes. A failed native cancellation must not permit overlap.
    turn.suppressQueueDrain = true;
    if (turn.flushTimer) clearTimeout(turn.flushTimer);
    if (turn.typingTimer) clearInterval(turn.typingTimer);
    await turn.execution.cancel();
    await this.messageOperations.run(`${scopeId}:preview:${turn.taskId}`, () => this.messaging.endTaskPreview?.(scopeId, turn.taskId) ?? Promise.resolve());
    if (!preserveRecovery && this.messaging.beginTaskPreview) {
      const task = this.store.taskJournal.get(turn.taskId)!;
      const folded = buildFoldedToolsSummary({ toolLines: turn.toolLines, toolCount: turn.toolCount, stepIndex: turn.stepIndex, startTime: turn.startTime, locale: task.request.locale });
      const response = `${task.request.locale === 'zh' ? '🛑 已停止任务；排队任务保留。' : '🛑 Task stopped; queued tasks kept.'}${turn.accumulatedText.trim() ? `\n\n${turn.accumulatedText.trim()}` : ''}`;
      this.store.taskJournal.update(turn.taskId, 'delivery_pending', { result: { kind: 'result', status: 'INTERRUPTED', response, conversationId: turn.threadId }, delivery: combineSummaryAndResponse(folded, response), deliveredChunks: 0, previewMessageId: turn.messageId, separateFinal: turn.separateFinal === true });
      try { await this.deliverTaskChunks(turn.taskId); this.resolveDeliveredTask(turn.taskId); }
      catch (error) { this.logger.warn('orchestrator.stop_delivery_failed', { taskId: turn.taskId, error: String(error) }); }
    }
    if (this.activeTurns.get(scopeId) === turn) this.activeTurns.delete(scopeId);
    if (!preserveRecovery) {
      this.store.removeActiveTurnPreview(turn.previewKey);
      if (turn.queueId) this.store.updateQueuedTurnInputStatus(turn.queueId, 'cancelled');
      const task = this.store.taskJournal.get(turn.taskId)!;
      if (!['cancelled', 'delivery_pending'].includes(task.state)) this.store.taskJournal.update(turn.taskId, 'cancelled');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.inboundListeners.clear();
    await this.bot.stop();
    this.removeInboundConsumer?.();
    this.removeInboundConsumer = null;
    await this.backends.stopPendingOperations();
    await this.intakeOperations.idle();
    for (const timer of this.stalePanelDeleteTimers.values()) clearTimeout(timer);
    this.stalePanelDeleteTimers.clear();
    for (const timer of this.recoveryTimers) clearTimeout(timer);
    this.recoveryTimers.clear();
    await Promise.allSettled([...this.activeTurns.keys()].map(scopeId => this.cancelActiveTurn(scopeId, true)));
    await this.scopeOperations.idle();
    await Promise.allSettled([...this.settlements]);
    await this.messageOperations.idle();
    await this.backends.stop();
  }

  isIdleForServiceUpdate(): boolean {
    return !this.store.taskJournal.listUnfinished().some(task => this.ownsScope(task.event.scopeId)) && this.activeTurns.size === 0 && this.settlements.size === 0 && this.scopeOperations.isIdle() && this.messageOperations.isIdle() && this.getPendingApprovals() === 0 &&
      this.backends.getPendingOperations() === 0 && !this.store.listQueuedTurnInputs().some(input => this.ownsScope(input.scopeId));
  }

  getPendingApprovals(): number { return this.backends.getPendingApprovals(); }

  getActiveTurnsCount(): number {
    return this.activeTurns.size;
  }

  ownsScopeId(scopeId: string): boolean { return this.ownsScope(scopeId); }
  hasExecutingTasks(): boolean { return this.activeTurns.size > 0 || !this.scopeOperations.isIdle() || this.settlements.size > 0; }

  hasActiveTurn(scopeId: string): boolean {
    return this.activeTurns.has(scopeId);
  }

  async sendMessage(scopeId: string, text: string, keyboard?: ChannelInlineKeyboard): Promise<number> {
    const chunks = chunkMessage(text, this.messaging.capabilities?.maxMessageLength);
    let lastMsgId = 0;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const kb = isLast ? keyboard : undefined;
      lastMsgId = await this.messaging.sendRichMarkdown(scopeId, chunks[i]!, kb);
    }
    return lastMsgId;
  }

  async editMessage(scopeId: string, messageId: number, text: string, keyboard?: ChannelInlineKeyboard): Promise<void> {
    if (!messageId || messageId <= 0) { await this.sendMessage(scopeId, text, keyboard); return; }
    await this.messageOperations.run(`${scopeId}:${messageId}`, () => this.messaging.editRichMarkdown(scopeId, messageId, text, keyboard));
  }

  private trackSettlement(work: () => Promise<void>): void {
    const pending = work();
    this.settlements.add(pending);
    void pending.catch(error => this.logger.warn('orchestrator.settlement_failed', { error: String(error) }))
      .finally(() => this.settlements.delete(pending));
  }

  private async deliverTaskChunks(taskId: string): Promise<void> {
    let task = this.store.taskJournal.get(taskId)!;
    while (task.deliveredChunks < task.delivery.length) {
      if (this.stopped) throw new Error('Delivery interrupted by shutdown');
      const index = task.deliveredChunks;
      const chunk = task.delivery[index]!;
      if (!task.separateFinal && index === 0 && task.previewMessageId > 0 && this.messaging.capabilities?.editableMessages !== false) {
        try { await this.editMessage(task.event.scopeId, task.previewMessageId, chunk, []); }
        catch { await this.sendMessage(task.event.scopeId, chunk); }
      } else await this.sendMessage(task.event.scopeId, chunk);
      task = this.store.taskJournal.update(task.id, 'delivery_pending', { deliveredChunks: index + 1 });
    }
    if (task.separateFinal) {
      for (let index = 0; index < (task.commentary?.length ?? 0); index++) {
        const item = task.commentary![index]!;
        if (item.folded || this.messaging.capabilities?.editableMessages === false) continue;
        try {
          if (this.messaging.foldTaskCommentary) await this.messaging.foldTaskCommentary(task.event.scopeId, item.messageId, item.text);
          else await this.editMessage(task.event.scopeId, item.messageId, `<blockquote expandable>${escapeHtml(item.text)}</blockquote>`, []);
          const commentary = [...task.commentary!]; commentary[index] = { ...item, folded: true };
          task = this.store.taskJournal.update(task.id, 'delivery_pending', { commentary });
        } catch (error) { this.logger.warn('orchestrator.commentary_fold_failed', { taskId, messageId: item.messageId, error: String(error) }); }
      }
      if (!task.previewSettled) {
        if (task.previewMessageId > 0 && this.messaging.capabilities?.editableMessages !== false) {
          if (task.finalPreviewText) await this.editMessage(task.event.scopeId, task.previewMessageId, task.finalPreviewText, []);
          else await this.messaging.deleteMessage(task.event.scopeId, task.previewMessageId).catch(() => {});
        }
        task = this.store.taskJournal.update(task.id, 'delivery_pending', { previewSettled: true });
      }
    }
  }

  private async safeDeliverChunks(scopeId: string, messageId: number, chunks: string[]): Promise<void> {
    const active = this.activeTurns.get(scopeId);
    if (!active || this.stopped || active.suppressQueueDrain) return;
    await this.messageOperations.run(`${scopeId}:preview:${active.taskId}`, () => this.messaging.endTaskPreview?.(scopeId, active.taskId) ?? Promise.resolve());
    const task = this.store.taskJournal.get(active.taskId)!;
    messageId = active.messageId;
    this.store.taskJournal.update(task.id, 'delivery_pending', { delivery: chunks, deliveredChunks: 0, previewMessageId: messageId, separateFinal: active.separateFinal === true });
    await this.deliverTaskChunks(task.id);
  }

  private async safeDeliverMessage(scopeId: string, messageId: number, text: string): Promise<void> {
    await this.safeDeliverChunks(scopeId, messageId, chunkMessage(text, this.messaging.capabilities?.maxMessageLength));
  }

  async handleText(event: ChannelTextEvent): Promise<void> {
    if (this.stopped || !this.ownsScope(event.scopeId)) return;
    const scopeId = event.scopeId;
    const locale: AppLocale = this.store.getChatSettings(scopeId)?.locale ?? 'zh';
    const sensitiveState = this.store.getServiceInteraction(scopeId, 'sensitive-input');
    if (sensitiveState && parseCommand(event.text)) {
      this.store.setServiceInteraction(scopeId, 'sensitive-input', null);
    }
    if (event.redacted) {
      await this.messaging.deleteMessage(scopeId, event.messageId).catch(() => {});
      await this.sendMessage(scopeId, locale === 'zh' ? '上次配置输入的敏感内容未保存。请重新打开配置面板并再次输入。' : 'The sensitive configuration input was not retained. Reopen its setup panel and enter it again.');
      return;
    }
    const sensitiveOwner = this.backends.sensitiveInboundOwner(event);
    if (sensitiveOwner) {
      await sensitiveOwner.handleCustomInbound?.(event, locale);
      return;
    }
    if (sensitiveState && !parseCommand(event.text)) {
      await this.messaging.deleteMessage(scopeId, event.messageId).catch(() => {});
      await this.sendMessage(scopeId, locale === 'zh' ? '对应配置入口当前不可用，此输入未交给模型。请重新打开配置面板，或发送 /cancel 取消。' : 'The configuration handler is unavailable. This input was not sent to a model. Reopen configuration or send /cancel.');
      return;
    }
    const action = this.messaging.resolveAction?.(event);
    if (action) { await this.handleCallback(action); return; }
    const parsedCommand = parseCommand(event.text);
    const addressing = this.messaging.resolveIncoming?.(event, this.config, this.bot.username) ??
      (parsedCommand ? { kind: 'command' as const, command: parsedCommand } :
        event.text.trim() || event.attachments.length ? { kind: 'prompt' as const, text: event.text } : { kind: 'ignore' as const });

    if (addressing.kind === 'ignore') return;

    const serviceInbound = this.serviceUi?.handleCustomInbound?.(event, locale);
    if (serviceInbound && await serviceInbound) return;

    if (addressing.kind === 'command') {
      const name = addressing.command.name.toLowerCase();
      const args = addressing.command.args.join(' ').trim();
      if (name === 'choose') { await this.sendMessage(scopeId, locale === 'zh' ? '选择已过期或不属于此会话，请重新打开菜单。' : 'This choice expired or belongs to another scope. Open the menu again.'); return; }
      if (name === 'recover') { await this.handleRecovery(scopeId, args, locale); return; }
      if (await this.serviceUi?.handleCustomCommand?.(scopeId, name, args, locale, event)) return;
      if (['backend', 'backends', 'engine', 'engines'].includes(name)) {
        await this.handleBackendCommand(scopeId, args, locale);
        return;
      }
    }
    const backendId = this.store.getActiveBackend(scopeId) || this.defaultBackendId;
    if (!this.backends.has(backendId)) {
      await this.sendMessage(scopeId, locale === 'zh' ? `后端 \`${backendId}\` 当前不可用。发送 /backend 切换后端，原会话和设置已保留。` : `Backend \`${backendId}\` is unavailable. Use /backend to switch; its session and settings are preserved.`);
      return;
    }
    const ui = this.backends.ui(this.getBackendDescriptorForScope(scopeId).id) ?? this.customUi;
    if (ui?.handleCustomInbound) {
      const handled = ui.handleCustomInbound(event, locale);
      if (handled && await handled) return;
    }

    if (addressing.kind === 'command') {
      const commandName = addressing.command.name.toLowerCase();
      const argsString = addressing.command.args.join(' ').trim();

      if (ui?.handleCustomCommand) {
        const handled = await ui.handleCustomCommand(scopeId, commandName, argsString, locale, event);
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
            this.store.setChatModel(scopeId, argsString === 'default' ? null : argsString);
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
      await this.sendMessage(scopeId, locale === 'zh' ? `当前后端不支持 /${commandName}。发送 /help 查看可用操作。` : `This backend does not support /${commandName}. Send /help for available commands.`);
      return;
    }

    if (addressing.kind === 'prompt') {
      await this.startPromptTurn(event, addressing.text, locale);
    }
  }

  async handleCallback(event: ChannelCallbackEvent): Promise<void> {
    if (this.stopped || !this.ownsScope(event.scopeId)) return;
    const scopeId = event.scopeId;
    const locale: AppLocale = this.store.getChatSettings(scopeId)?.locale ?? 'zh';
    const data = event.data || '';
    const messageId = event.messageId;

    if (this.serviceUi?.handleCustomCallback && await this.serviceUi.handleCustomCallback(scopeId, data, locale, messageId, event)) return;

    if (data.startsWith('engine:stop:')) {
      const status = await this.stopTask(scopeId, data.slice('engine:stop:'.length));
      await this.messaging.answerCallback(event.callbackQueryId, status ? (locale === 'zh' ? '已停止，排队任务保留' : 'Stopped; queued tasks kept') : (locale === 'zh' ? '此任务已结束' : 'This task has ended'));
      return;
    }
    if (data.startsWith('engine:recover:')) {
      const [, , action, id] = data.split(':');
      await this.handleRecovery(scopeId, `${action} ${id}`, locale);
      await this.messaging.answerCallback(event.callbackQueryId, '');
      return;
    }

    const backendId = this.store.getActiveBackend(scopeId) || this.defaultBackendId;
    const ui = this.backends.callbackOwner(data) ?? this.backends.ui(backendId) ?? (this.backends.has(backendId) ? this.customUi : undefined);
    if (ui?.handleCustomCallback) {
      const handled = await ui.handleCustomCallback(scopeId, data, locale, messageId, event);
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

    if (!this.backends.has(backendId)) {
      await this.messaging.answerCallback(event.callbackQueryId, locale === 'zh' ? '后端不可用，请发送 /backend 重新选择。' : 'Backend unavailable; select one with /backend.');
      return;
    }
    if (data.startsWith('engine:m:') || data.startsWith('setup:model:')) {
      const rawModel = data.startsWith('engine:m:')
        ? data.slice('engine:m:'.length)
        : decodeURIComponent(data.slice('setup:model:'.length));
      const model = rawModel === 'default' ? null : rawModel;
      this.store.setChatModel(scopeId, model);
      this.syncCurrentBackendSettings(scopeId);
      await this.messaging.answerCallback(event.callbackQueryId, `Model: ${rawModel}`);
      await this.sendSetupMenu(scopeId, locale, messageId);
      return;
    }

    if (data.startsWith('engine:effort:') || data.startsWith('setup:effort:')) {
      const rawEffort = data.startsWith('engine:effort:')
        ? data.slice('engine:effort:'.length)
        : data.slice('setup:effort:'.length);
      const targetEffort = rawEffort === 'default' ? null : rawEffort;
      if (targetEffort && !(await this.supportedEfforts(scopeId)).includes(targetEffort)) {
        await this.messaging.answerCallback(event.callbackQueryId, locale === 'zh' ? '当前模型不支持此推理档位。' : 'This model does not support that reasoning effort.');
        return;
      }
      const settings = this.store.getChatSettings(scopeId);
      if (targetEffort !== 'high' && settings?.serviceTier === 'boost') {
        this.store.setChatServiceTier(scopeId, null);
      }
      this.store.setChatEffort(scopeId, targetEffort);
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
        if (this.getBackendDescriptorForScope(scopeId).defaults?.boost === false) {
          await this.messaging.answerCallback(event.callbackQueryId, locale === 'zh' ? '当前后端不支持 Boost。' : 'Boost is not available on this backend.');
          return;
        }
        const isBoost = this.store.getChatSettings(scopeId)?.serviceTier === 'boost';
        const nextBoost = !isBoost;
        this.store.setChatServiceTier(scopeId, nextBoost ? 'boost' : null);
        if (nextBoost) {
          this.store.setChatEffort(scopeId, 'high');
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

  private captureTask(event: ChannelTextEvent, prompt: string, locale: AppLocale, stagedAttachments?: StagedAttachment[], queueId: string | null = null): JournalTask {
    const scopeId = event.scopeId;
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);
    const backend = this.getBackendDescriptorForScope(scopeId);
    const boost = settings?.serviceTier === 'boost' && backend.defaults?.boost !== false;
    const task: JournalTask = {
      id: randomUUID(), backendId: backend.id, state: 'accepted', event, sourcePrompt: prompt,
      request: { scopeId, prompt: boost && !prompt.startsWith('[Boost Mode:')
        ? `[Boost Mode: Proceed with deep thinking, strategic planning, multiple perspectives, and rigorous verification.]\n\n${prompt}` : prompt,
        stagedAttachments, threadId: binding?.threadId || null, cwd: binding?.cwd || this.config.defaultCwd,
        model: settings?.model || 'default', effort: boost ? 'high' : settings?.reasoningEffort ?? backend.defaults?.reasoningEffort ?? null,
        serviceTier: boost ? 'boost' : settings?.serviceTier ?? null, locale, accessPreset: settings?.accessPreset ?? 'default' },
      queueId, previewMessageId: 0, result: null, delivery: [], deliveredChunks: 0, previewSettled: false, separateFinal: this.getBackendDescriptorForScope(event.scopeId).adapter.supportsCommentary === true, error: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.store.taskJournal.insert(task);
    return task;
  }

  private recoveryBlocksScope(scopeId: string): boolean {
    return this.store.taskJournal.listUnfinished(scopeId).some(task => task.state === 'awaiting_confirmation' || task.state === 'delivery_pending');
  }

  async startPromptTurn(
    event: ChannelTextEvent, prompt: string, locale: AppLocale,
    options?: { reuseMessageId?: number | undefined; forcedThreadId?: string | undefined; taskId?: string | undefined },
  ): Promise<void> {
    if (this.stopped) return;
    if (this.store.taskJournal.findReceipt(event, prompt)) return;
    const task = this.captureTask(event, prompt, locale);
    return this.scopeOperations.run(event.scopeId, () => this.startPromptTurnNow(event, prompt, locale, { ...options, taskId: task.id }));
  }

  private async startPromptTurnNow(
    event: ChannelTextEvent,
    prompt: string,
    locale: AppLocale,
    options?: { reuseMessageId?: number | undefined; forcedThreadId?: string | undefined; taskId?: string | undefined },
  ): Promise<void> {
    if (this.stopped) return;
    const scopeId = event.scopeId;
    const binding = this.store.getBinding(scopeId);
    const effectivePrompt = prompt;
    const task = options?.taskId ? this.store.taskJournal.get(options.taskId)! : this.captureTask(event, prompt, locale);
    const cwd = task.request.cwd;
    const threadId = options?.forcedThreadId ?? binding?.threadId ?? task.request.threadId ?? 'default';
    if (options?.forcedThreadId) task.request.threadId = options.forcedThreadId;
    let stagedAttachments: StagedAttachment[] | undefined;
    try {
      if (event.attachments.length) {
        stagedAttachments = await stageInboundAttachments(this.messaging, cwd, threadId, event.attachments, this.logger);
        if (stagedAttachments.length !== event.attachments.length) throw new Error('Some attachments could not be saved; the task was not started');
      }
      task.request.stagedAttachments = stagedAttachments;
      this.store.taskJournal.update(task.id, 'accepted', { request: task.request });
    } catch (error) {
      this.store.taskJournal.update(task.id, 'failed', { error: String(error) });
      await this.sendMessage(scopeId, `⚠️ ${String(error)}`);
      return;
    }
    const taskOptions = { ...options, taskId: task.id };

    if (this.activeTurns.has(scopeId) || this.recoveryBlocksScope(scopeId)) {
      const settings = this.store.getChatSettings(scopeId);
      const mode = settings?.activeTurnMessageMode ?? 'queue';

      if (mode === 'steer' && !this.recoveryBlocksScope(scopeId)) {
        await this.cancelActiveTurn(scopeId);
        await this.sendMessage(
          scopeId,
          locale === 'zh'
            ? `⚡ **已插话中断前置任务，立即开始新指令**：\n> ${effectivePrompt}`
            : `⚡ **Interrupted previous turn, executing new instruction**:\n> ${effectivePrompt}`,
        );
        await this.executeTurn(event, effectivePrompt, locale, 0, stagedAttachments, taskOptions);
        return;
      }

      await this.enqueuePromptTurn(event, effectivePrompt, locale, stagedAttachments, task.id);
      return;
    }

    await this.executeTurn(event, effectivePrompt, locale, 0, stagedAttachments, taskOptions);
  }

  private cancelQueuedWork(scopeId: string): number {
    const count = this.store.cancelQueuedTurnInputs(scopeId);
    for (const task of this.store.taskJournal.listUnfinished(scopeId)) {
      if (task.state === 'queued' && task.queueId && this.store.getQueuedTurnInput(task.queueId)?.status === 'cancelled') this.store.taskJournal.update(task.id, 'cancelled');
    }
    return count;
  }

  private async enqueuePromptTurn(
    event: ChannelTextEvent,
    prompt: string,
    locale: AppLocale,
    stagedAttachments: StagedAttachment[] = [],
    taskId?: string,
  ): Promise<void> {
    const scopeId = event.scopeId;
    const journalTask = taskId ? this.store.taskJournal.get(taskId) : null;
    const adapter = journalTask ? this.getAdapterForBackend(journalTask.backendId) : this.getAdapterForScope(scopeId);
    const queueId = `${adapter.id}_q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const binding = this.store.getBinding(scopeId);

    this.store.taskJournal.atomic(() => {
    this.store.saveQueuedTurnInput({
      queueId,
      scopeId,
      chatId: String(event.chatId),
      chatType: event.chatType,
      topicId: event.topicId ?? null,
      threadId: binding?.threadId || '',
      inputJson: JSON.stringify({ version: 1, prompt, backendId: journalTask?.backendId ?? this.getBackendDescriptorForScope(scopeId).id, cwd: journalTask?.request.cwd ?? binding?.cwd ?? this.config.defaultCwd, stagedAttachments }),
      sourceSummary: prompt,
      messageId: event.messageId ?? null,
      status: 'queued',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
    });

    if (journalTask) this.store.taskJournal.update(journalTask.id, 'queued', { queueId, request: { ...journalTask.request, stagedAttachments } });
    });

    const queueCount = this.store.countQueuedTurnInputs(scopeId);
    await this.sendMessage(
      scopeId,
      locale === 'zh'
        ? `📥 **已加入排队队列** (当前队列: ${queueCount} 条)\n当前任务完成后将自动按序执行：\n> ${prompt}\n\n*提示：发送 /interrupt 可中断当前任务，或在 /setup 中切换为“插话”模式。*`
        : `📥 **Queued** (${queueCount} in queue)\nWill execute automatically once current turn finishes:\n> ${prompt}\n\n*Tip: send /interrupt to stop, or switch to "Steer" in /setup.*`,
    );
  }

  private async drainNextQueuedTurn(event: ChannelTextEvent, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    await this.scopeOperations.run(scopeId, async () => {
      while (!this.stopped && !this.activeTurns.has(scopeId) && !this.recoveryBlocksScope(scopeId)) {
        const queued = this.store.peekQueuedTurnInput(scopeId);
        if (!queued) return;
        this.store.updateQueuedTurnInputStatus(queued.queueId, 'processing');
        try {
          const input = decodeQueuedEngineInput(queued.inputJson, queued.sourceSummary);
          if ('backendId' in input && (input.backendId !== this.getBackendDescriptorForScope(scopeId).id || input.cwd !== (this.store.getBinding(scopeId)?.cwd || this.config.defaultCwd))) {
            throw new Error('Queued task context changed; start a new task in the selected backend/directory');
          }
          await this.sendMessage(scopeId, locale === 'zh' ? `⏭️ **开始执行排队任务**：\n> ${input.prompt}` : `⏭️ **Executing queued task**:\n> ${input.prompt}`);
          await this.executeTurn({ ...event, chatId: queued.chatId, topicId: queued.topicId, messageId: queued.messageId ?? 0, text: input.prompt, attachments: [] },
            input.prompt, locale, 0, input.stagedAttachments, { queueId: queued.queueId, taskId: this.store.taskJournal.forQueue(queued.queueId)?.id });
          return;
        } catch (error) {
          if (this.stopped) return; // Preserve processing for restart recovery.
          this.store.updateQueuedTurnInputStatus(queued.queueId, 'failed', String(error));
          const task = this.store.taskJournal.forQueue(queued.queueId);
          if (task?.state === 'queued' || task?.state === 'accepted') this.store.taskJournal.update(task.id, 'failed', { error: String(error) });
          this.logger.warn('orchestrator.drain_queue_failed', { error: String(error) });
          await this.sendMessage(scopeId, `⚠️ ${String(error)}`).catch(() => {});
        }
      }
    });
  }

  private async executeTurn(
    event: ChannelTextEvent,
    prompt: string,
    locale: AppLocale,
    retryCount = 0,
    stagedAttachments?: StagedAttachment[],
    options?: { reuseMessageId?: number | undefined; forcedThreadId?: string | undefined; queueId?: string | undefined; taskId?: string | undefined },
  ): Promise<void> {
    if (this.stopped) throw new Error('Orchestrator is stopped');
    const scopeId = event.scopeId;
    const binding = this.store.getBinding(scopeId);
    let task = options?.taskId ? this.store.taskJournal.get(options.taskId) : null;
    if (!task) task = this.captureTask(event, prompt, locale, stagedAttachments, options?.queueId ?? null);
    const adapter = this.getAdapterForBackend(task.backendId);
    const req = { ...task.request, threadId: options?.forcedThreadId ?? binding?.threadId ?? task.request.threadId,
      stagedAttachments: stagedAttachments ?? task.request.stagedAttachments };
    const { cwd, threadId } = req;
    const isBoost = req.serviceTier === 'boost';

    let initialMsgId = 0;
    if (options?.reuseMessageId) {
      initialMsgId = options.reuseMessageId;
      try {
        const text = locale === 'zh' ? `🔄 [重启恢复] ${adapter.name} 正在继续执行…` : `🔄 ${adapter.name} is continuing…`;
        if (this.messaging.beginTaskPreview) initialMsgId = await this.messaging.beginTaskPreview(scopeId, task.id, text, initialMsgId);
        else await this.editMessage(scopeId, initialMsgId, text, [[{ text: '🛑 停止 / Stop', callback_data: `engine:stop:${task.id}` }]]);
      } catch (editErr) { this.logger.warn('orchestrator.reuse_message_failed', { error: String(editErr) }); }
    } else {
      try {
        const initialText = locale === 'zh'
          ? (isBoost ? `🚀 ${adapter.name} (Boost 模式) 正在深度思考中…` : `⏳ ${adapter.name} 正在思考中…`)
          : (isBoost ? `🚀 ${adapter.name} (Boost Mode) is thinking deeply…` : `⏳ ${adapter.name} is thinking…`);
        initialMsgId = this.messaging.beginTaskPreview
          ? await this.messaging.beginTaskPreview(scopeId, task.id, initialText)
          : await this.sendMessage(scopeId, initialText, [[{ text: '🛑 停止 / Stop', callback_data: `engine:stop:${task.id}` }]]);
      } catch (sendErr) {
        this.logger.warn('orchestrator.initial_message_failed', { error: String(sendErr) });
      }
    }

    const turnKey = `${adapter.id}_${task.id}`;
    try {
      this.store.saveActiveTurnPreview({
        turnId: turnKey,
        scopeId,
        threadId: threadId || '',
        messageId: initialMsgId,
      });
    } catch {
      /* ignore */
    }

    task = this.store.taskJournal.update(task.id, task.state, { request: req, previewMessageId: initialMsgId });

    if (adapter.preflightTurn) {
      try {
        await adapter.preflightTurn(req);
      } catch (err) {
        this.logger.warn('orchestrator.preflight_failed', { error: String(err) });
      }
    }

    if (this.stopped) {
      await this.messaging.endTaskPreview?.(scopeId, task.id);
      this.store.removeActiveTurnPreview(turnKey);
      throw new Error('Orchestrator is stopped');
    }
    let execution: EngineTurnExecution;
    task = this.store.taskJournal.update(task.id, 'running', { result: null, delivery: [], deliveredChunks: 0, previewSettled: false, separateFinal: adapter.supportsCommentary === true });
    try { execution = adapter.executeTurn(req); }
    catch (error) { await this.messaging.endTaskPreview?.(scopeId, task.id); this.store.removeActiveTurnPreview(turnKey); this.store.taskJournal.update(task.id, 'failed', { error: String(error) }); throw error; }

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
      previewKey: turnKey,
      queueId: options?.queueId,
      taskId: task.id,
      separateFinal: adapter.supportsCommentary === true,
      commentaryIds: new Set(),
    };

    this.activeTurns.set(scopeId, activeTurn);

    this.messaging.sendTypingInScope(scopeId).catch(() => {});
    activeTurn.typingTimer = setInterval(() => {
      this.messaging.sendTypingInScope(scopeId).catch(() => {});
      scheduleFlush();
    }, TYPING_INTERVAL_MS);
    activeTurn.typingTimer?.unref?.();

    const ownsTurn = () => !this.stopped && !activeTurn.suppressQueueDrain && this.activeTurns.get(scopeId) === activeTurn;
    const scheduleFlush = () => {
      if (!ownsTurn() || activeTurn.settling || this.messaging.capabilities?.editableMessages === false) return;
      if (activeTurn.flushTimer) return;
      const elapsed = Date.now() - activeTurn.lastFlushTime;
      const delay = Math.max(0, STREAM_THROTTLE_MS - elapsed);
      activeTurn.flushTimer = setTimeout(() => {
        activeTurn.flushTimer = null;
        if (!ownsTurn() || activeTurn.settling) return;
        activeTurn.lastFlushTime = Date.now();
        const elapsedSeconds = Math.max(1, Math.floor((Date.now() - activeTurn.startTime) / 1000));
        const content = renderStreamPreviewContent({
          toolLines: activeTurn.toolLines,
          accumulatedText: activeTurn.separateFinal ? '' : activeTurn.accumulatedText,
          isBoost,
          engineName: adapter.name,
          stepIndex: activeTurn.stepIndex,
          toolCount: activeTurn.toolCount,
          currentTool: activeTurn.currentTool,
          elapsedSeconds,
        });
        void this.messageOperations.run(`${scopeId}:preview:${activeTurn.taskId}`, async () => {
          if (!ownsTurn() || activeTurn.settling) return;
          if (this.messaging.updateTaskPreview) {
            const messageId = await this.messaging.updateTaskPreview(scopeId, activeTurn.taskId, activeTurn.messageId, content);
            if (messageId !== activeTurn.messageId) {
              activeTurn.messageId = messageId;
              const journal = this.store.taskJournal.get(activeTurn.taskId)!;
              this.store.taskJournal.update(journal.id, journal.state, { previewMessageId: messageId });
              this.store.saveActiveTurnPreview({ turnId: activeTurn.previewKey, scopeId, threadId: activeTurn.threadId || '', messageId });
            }
          } else await this.messaging.editRichMarkdown(scopeId, activeTurn.messageId, content, [[{ text: '🛑 停止 / Stop', callback_data: `engine:stop:${activeTurn.taskId}` }]]);
        }).catch(() => {});
      }, delay);
      activeTurn.flushTimer?.unref?.();
    };

    execution.on('delta', (delta) => {
      if (!ownsTurn() || activeTurn.settling) return;
      activeTurn.accumulatedText += delta;
      scheduleFlush();
    });

    execution.on('commentary', (message: EngineCommentaryEvent) => {
      if (!ownsTurn() || activeTurn.settling || !message.text.trim() || activeTurn.commentaryIds?.has(message.messageId)) return;
      activeTurn.commentaryIds?.add(message.messageId);
      activeTurn.separateFinal = true;
      activeTurn.accumulatedText = '';
      void this.messageOperations.run(`${scopeId}:preview:${activeTurn.taskId}`, async () => {
        if (!ownsTurn()) return;
        const limit = this.messaging.sendTaskCommentary ? 30000 : Math.min(3000, this.messaging.capabilities?.maxMessageLength ?? 3000);
        for (const text of chunkMessage(message.text, limit)) {
          const messageId = this.messaging.sendTaskCommentary
            ? await this.messaging.sendTaskCommentary(scopeId, text)
            : await this.messaging.sendRichMarkdown(scopeId, text);
          const current = this.store.taskJournal.get(activeTurn.taskId)!;
          this.store.taskJournal.update(current.id, current.state, {
            commentary: [...(current.commentary ?? []), { messageId, text, folded: false }], separateFinal: true,
          });
        }
      }).catch(error => this.logger.warn('orchestrator.commentary_send_failed', { taskId: activeTurn.taskId, error: String(error) }));
      scheduleFlush();
    });

    execution.on('tool', (tool) => {
      if (!ownsTurn() || activeTurn.settling) return;
      if (tool.stepIndex && tool.stepIndex > 0) {
        activeTurn.stepIndex = tool.stepIndex;
      }
      const icon = tool.status === 'running' ? '⚙️' : tool.status === 'failed' ? '❌' : '✅';
      const summaryText = tool.summary ? ` · ${escapeHtml(tool.summary.slice(0, 180))}` : '';
      const line = `${icon} <code>${escapeHtml(tool.name.slice(0, 100))}</code>${summaryText}`;

      if (tool.status === 'running') {
        activeTurn.toolCount += 1;
        activeTurn.currentTool = tool.summary ? `${tool.name.slice(0, 100)} (${tool.summary.slice(0, 180)})` : tool.name;
        activeTurn.toolLines.push(line);
      } else {
        if (activeTurn.currentTool && activeTurn.currentTool.startsWith(tool.name)) {
          activeTurn.currentTool = null;
        }
        const lastIdx = activeTurn.toolLines.findLastIndex((l) => l.includes(`<code>${escapeHtml(tool.name.slice(0, 100))}</code>`));
        if (lastIdx !== -1) {
          activeTurn.toolLines[lastIdx] = line;
        } else {
          activeTurn.toolLines.push(line);
        }
      }
      scheduleFlush();
    });

    execution.on('conversation', (convId: string) => {
      if (!convId || !ownsTurn() || activeTurn.settling) return;
      activeTurn.threadId = convId;
      this.store.setBinding(scopeId, convId, cwd);
      this.store.saveActiveTurnPreview({
        turnId: turnKey,
        scopeId,
        threadId: convId,
        messageId: activeTurn.messageId,
      });
      this.store.taskJournal.update(activeTurn.taskId, 'running', { request: { ...req, threadId: convId } });
      this.syncCurrentBackendSettings(scopeId);
    });

    const retryTurn = async (nextRetryCount: number) => {
      await this.scopeOperations.run(scopeId, async () => {
        if (!ownsTurn() || activeTurn.suppressQueueDrain) return;
        await this.messageOperations.run(`${scopeId}:preview:${activeTurn.taskId}`, () => this.messaging.endTaskPreview?.(scopeId, activeTurn.taskId) ?? Promise.resolve());
        this.activeTurns.delete(scopeId);
        this.store.removeActiveTurnPreview(turnKey);
        try { await this.executeTurn(event, prompt, locale, nextRetryCount, stagedAttachments, { ...options, reuseMessageId: activeTurn.messageId || undefined, taskId: activeTurn.taskId }); }
        catch (error) {
          if (!this.stopped && !this.activeTurns.has(scopeId)) this.activeTurns.set(scopeId, activeTurn);
          throw error;
        }
      });
    };
    const finishTurn = async (status: EngineTurnResult['status'], error?: string) => {
      if (!ownsTurn()) return;
      this.activeTurns.delete(scopeId);
      this.store.removeActiveTurnPreview(turnKey);
      const task = this.store.taskJournal.get(activeTurn.taskId)!;
      if (task.state === 'awaiting_confirmation') return;
      if (task.state === 'delivery_pending' && task.deliveredChunks < task.delivery.length) {
        this.logger.warn('orchestrator.delivery_pending', { taskId: task.id, scopeId });
        return;
      }
      this.store.taskJournal.update(task.id, status === 'SUCCESS' ? 'completed' : status === 'INTERRUPTED' ? 'cancelled' : 'failed', { error: error ?? null });
      if (activeTurn.queueId) this.store.updateQueuedTurnInputStatus(activeTurn.queueId,
        status === 'SUCCESS' ? 'completed' : status === 'INTERRUPTED' ? 'cancelled' : 'failed', error ?? null);
      if (!activeTurn.suppressQueueDrain) await this.drainNextQueuedTurn(event, locale);
    };

    execution.on('result', (res: EngineTurnResult) => { this.trackSettlement(async () => {
      if (!ownsTurn() || activeTurn.settling) return;
      activeTurn.settling = true;
      this.store.taskJournal.update(activeTurn.taskId, 'running', { result: res, request: { ...req, threadId: res.conversationId || activeTurn.threadId } });
      try {
        if (activeTurn.flushTimer) clearTimeout(activeTurn.flushTimer);
        if (activeTurn.typingTimer) clearInterval(activeTurn.typingTimer);

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

        if (res.outcomeUnknown) {
          await this.messageOperations.run(`${scopeId}:preview:${activeTurn.taskId}`, () => this.messaging.endTaskPreview?.(scopeId, activeTurn.taskId) ?? Promise.resolve());
          const waiting = this.store.taskJournal.update(activeTurn.taskId, 'awaiting_confirmation', { result: null, error: res.error ?? null });
          if (activeTurn.messageId > 0) await this.editMessage(scopeId, activeTurn.messageId,
            locale === 'zh' ? '⚠️ 后端连接中断，任务结果尚未确认。使用 /recover 处理；排队任务已保留。' : '⚠️ Backend disconnected; task outcome unconfirmed. Use /recover; queued tasks are kept.', []).catch(() => {});
          await this.showRecovery(waiting);
          return;
        }

        if (res.status === 'SUCCESS') {
          let finalText = (res.response || '').trim();
          if (!finalText && activeTurn.accumulatedText) {
            finalText = activeTurn.accumulatedText.trim();
          }

          const foldedTools = buildFoldedToolsSummary({
            stepIndex: activeTurn.stepIndex,
            toolLines: activeTurn.toolLines,
            toolCount: activeTurn.toolCount || activeTurn.toolLines.length,
            startTime: activeTurn.startTime,
            usage: res.usage,
            locale,
          });

          if (activeTurn.separateFinal) this.store.taskJournal.update(activeTurn.taskId, 'running', { finalPreviewText: foldedTools });
          const chunks = activeTurn.separateFinal
            ? chunkMessage(finalText || '(无输出 / No output)', this.messaging.capabilities?.maxMessageLength)
            : combineSummaryAndResponse(foldedTools, finalText || '(无输出 / No output)');
          await this.safeDeliverChunks(scopeId, activeTurn.messageId, chunks);
          return;
        }

        if (res.status === 'ERROR') {
          const errorText = (res.error || res.response || (res as any).error || 'Unknown error').trim();
          if (adapter.handleTurnError) {
            try {
              const handled = await adapter.handleTurnError({
                error: errorText,
                request: req,
                retryCount,
                retryTurn,
                sendMessage: (text: string) => this.sendMessage(scopeId, text),
                editMessage: (messageId: number, text: string) => this.editMessage(scopeId, messageId, text),
              });
              if (handled) return;
            } catch (adapterErr) {
              this.logger.warn('orchestrator.adapter_handle_turn_error_failed', { error: String(adapterErr) });
            }
          }

          if (isTransientNetworkError(errorText) && retryCount < 3) {
            const backoffMs = Math.min(15000, 3000 * Math.pow(2, retryCount));
            const delaySec = Math.round(backoffMs / 1000);
            try {
              await this.sendMessage(
                scopeId,
                locale === 'zh'
                  ? `🌐 **网络波动重试 (第 ${retryCount + 1}/3 次)**: 正在等待网络稳定 (${delaySec}s) 后自动恢复任务…`
                  : `🌐 **Network Retry (${retryCount + 1}/3)**: Waiting for connection (${delaySec}s) to resume task…`,
              );
            } catch {
              /* ignore messaging error during network glitch */
            }
            await new Promise((r) => setTimeout(r, backoffMs));
            try {
              await retryTurn(retryCount + 1);
            } catch (retryErr) {
              this.logger.error('orchestrator.retry_turn_failed', { error: String(retryErr) });
            }
            return;
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
            const foldedTools = buildFoldedToolsSummary({
              stepIndex: activeTurn.stepIndex,
              toolLines: activeTurn.toolLines,
              toolCount: activeTurn.toolCount || activeTurn.toolLines.length,
              startTime: activeTurn.startTime,
              usage: res.usage,
              locale,
            });

            const warningNote =
              errorText && errorText !== 'Unknown error' && errorText !== 'Antigravity execution failed'
                ? `\n\n⚠️ <i>(注意：任务结束时伴随提示: ${escapeHtml(errorText.slice(0, 120))})</i>`
                : '';
            const chunks = combineSummaryAndResponse(foldedTools, finalText + warningNote);
            await this.safeDeliverChunks(scopeId, activeTurn.messageId, chunks);
              return;
          }

          await this.safeDeliverMessage(
            scopeId,
            activeTurn.messageId,
            `❌ **${adapter.name} 错误**:\n\`\`\`\n${errorText}\n\`\`\``,
          );
          return;
        }

        await this.safeDeliverMessage(
          scopeId,
          activeTurn.messageId,
          activeTurn.accumulatedText || '⚠️ 执行结束',
        );
      } catch (fatalErr) {
        this.logger.error('orchestrator.turn_result_unhandled', { error: String(fatalErr) });
      } finally {
        await finishTurn(res.status, res.error).catch(error => this.logger.warn('orchestrator.finish_failed', { error: String(error) }));
      }
    }); });

    execution.on('error', (err: Error) => { this.trackSettlement(async () => {
      if (!ownsTurn() || activeTurn.settling) return;
      activeTurn.settling = true;
      this.store.taskJournal.update(activeTurn.taskId, 'running', { result: { kind: 'result', status: 'ERROR', response: activeTurn.accumulatedText, error: err.message, conversationId: activeTurn.threadId } });
      try {
        if (activeTurn.flushTimer) clearTimeout(activeTurn.flushTimer);
        if (activeTurn.typingTimer) clearInterval(activeTurn.typingTimer);

        if (adapter.handleTurnError) {
          try {
            const handled = await adapter.handleTurnError({
              error: err.message,
              request: req,
              retryCount,
              retryTurn,
              sendMessage: (text: string) => this.sendMessage(scopeId, text),
              editMessage: (messageId: number, text: string) => this.editMessage(scopeId, messageId, text),
            });
            if (handled) return;
          } catch (adapterErr) {
            this.logger.warn('orchestrator.adapter_handle_error_failed', { error: String(adapterErr) });
          }
        }

        if (isTransientNetworkError(err.message) && retryCount < 3) {
          const backoffMs = Math.min(15000, 3000 * Math.pow(2, retryCount));
          const delaySec = Math.round(backoffMs / 1000);
          try {
            await this.sendMessage(
              scopeId,
              locale === 'zh'
                ? `🌐 **网络波动重试 (第 ${retryCount + 1}/3 次)**: 正在等待网络稳定 (${delaySec}s) 后自动恢复任务…`
                : `🌐 **Network Retry (${retryCount + 1}/3)**: Waiting for connection (${delaySec}s) to resume task…`,
            );
          } catch {
            /* ignore */
          }
          await new Promise((r) => setTimeout(r, backoffMs));
          try {
            await retryTurn(retryCount + 1);
          } catch (retryErr) {
            this.logger.error('orchestrator.retry_turn_failed', { error: String(retryErr) });
          }
          return;
        }

        if (activeTurn.accumulatedText && activeTurn.accumulatedText.trim().length > 20) {
          const foldedTools = buildFoldedToolsSummary({
            stepIndex: activeTurn.stepIndex,
            toolLines: activeTurn.toolLines,
            toolCount: activeTurn.toolCount || activeTurn.toolLines.length,
            startTime: activeTurn.startTime,
            locale,
          });
          const fullAnswer =
            activeTurn.accumulatedText.trim() +
            `\n\n⚠️ <i>(注意：任务执行中途异常中断: ${escapeHtml(err.message.slice(0, 120))})</i>`;
          const chunks = combineSummaryAndResponse(foldedTools, fullAnswer);
          await this.safeDeliverChunks(scopeId, activeTurn.messageId, chunks);
          return;
        }

        await this.safeDeliverMessage(
          scopeId,
          activeTurn.messageId,
          `❌ **执行异常**:\n\`\`\`\n${err.message}\n\`\`\``,
        );
      } catch (fatalErr) {
        this.logger.error('orchestrator.turn_error_unhandled', { error: String(fatalErr) });
      } finally {
        await finishTurn('ERROR', err.message).catch(error => this.logger.warn('orchestrator.finish_failed', { error: String(error) }));
      }
    }); });
  }

  private async supportedEfforts(scopeId: string): Promise<readonly string[]> {
    const backend = this.getBackendDescriptorForScope(scopeId);
    const current = this.store.getChatSettings(scopeId)?.model;
    const models = await backend.adapter.listModels(scopeId);
    const selected = models.find(model => current ? model.id === current : model.isDefault);
    return selected?.supportedReasoningEfforts ?? backend.defaults?.supportedReasoningEfforts ?? ['low', 'medium', 'high'];
  }

  private async handleEffortCommand(scopeId: string, args: string, locale: AppLocale): Promise<void> {
    const supported = await this.supportedEfforts(scopeId);
    const target = args.trim();
    if (target) {
      const effort = target === 'default' ? null : target;
      if (effort && !supported.includes(effort)) {
        await this.sendMessage(scopeId, locale === 'zh' ? `当前模型不支持推理档位 \`${effort}\`。可用：default ${supported.join(' ')}` : `Unsupported reasoning effort \`${effort}\`. Available: default ${supported.join(' ')}`);
        return;
      }
      const settings = this.store.getChatSettings(scopeId);
      if (effort !== 'high' && settings?.serviceTier === 'boost') this.store.setChatServiceTier(scopeId, null);
      this.store.setChatEffort(scopeId, effort);
      this.syncCurrentBackendSettings(scopeId);
      await this.sendMessage(scopeId, locale === 'zh' ? `✅ 思考深度已设置为: \`${effort ?? 'default'}\`` : `✅ Reasoning effort set to: \`${effort ?? 'default'}\``);
    } else {
      const current = this.store.getChatSettings(scopeId)?.reasoningEffort ?? 'default';
      await this.sendMessage(scopeId, locale === 'zh' ? `当前思考深度: \`${current}\`\n可用：default ${supported.join(' ')}` : `Current effort: \`${current}\`\nAvailable: default ${supported.join(' ')}`);
    }
  }

  private async handleBoostCommand(scopeId: string, args: string, locale: AppLocale): Promise<void> {
    if (this.getBackendDescriptorForScope(scopeId).defaults?.boost === false) {
      await this.sendMessage(scopeId, locale === 'zh' ? '当前后端不支持 Boost。' : 'Boost is not available on this backend.');
      return;
    }
    const isBoost = this.store.getChatSettings(scopeId)?.serviceTier === 'boost';
    const target = args.trim().toLowerCase();
    let nextBoost = !isBoost;
    if (target === 'on' || target === '1' || target === 'true') nextBoost = true;
    if (target === 'off' || target === '0' || target === 'false') nextBoost = false;

    this.store.setChatServiceTier(scopeId, nextBoost ? 'boost' : null);
    if (nextBoost) {
      this.store.setChatEffort(scopeId, 'high');
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

  private async handleQueueCommand(event: ChannelTextEvent, args: string, locale: AppLocale): Promise<void> {
    const prompt = args.trim();
    if (prompt && prompt.toLowerCase() !== 'clear' && this.store.taskJournal.findReceipt(event, prompt)) return;
    const task = prompt && prompt.toLowerCase() !== 'clear' ? this.captureTask(event, prompt, locale) : null;
    await this.scopeOperations.run(event.scopeId, () => this.handleQueueCommandNow(event, args, locale, task?.id));
    if (args.trim() && args.trim().toLowerCase() !== 'clear' && !this.stopped) await this.drainNextQueuedTurn(event, locale);
  }

  private async handleQueueCommandNow(event: ChannelTextEvent, args: string, locale: AppLocale, taskId?: string): Promise<void> {
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
      const cleared = this.cancelQueuedWork(scopeId);
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `🗑️ 已清空当前会话的 ${cleared} 条排队任务。`
          : `🗑️ Cleared ${cleared} queued tasks.`,
      );
      return;
    }
    const binding = this.store.getBinding(scopeId);
    try {
      const task = taskId ? this.store.taskJournal.get(taskId) : null;
      const staged = event.attachments?.length ? await stageInboundAttachments(this.messaging, task?.request.cwd || binding?.cwd || this.config.defaultCwd, task?.request.threadId || binding?.threadId || 'default', event.attachments, this.logger) : [];
      if (staged.length !== event.attachments.length) throw new Error('Some attachments could not be saved; the task was not queued');
      await this.enqueuePromptTurn(event, args.trim(), locale, staged, taskId);
    } catch (error) {
      if (taskId) this.store.taskJournal.update(taskId, 'failed', { error: String(error) });
      await this.sendMessage(scopeId, `⚠️ ${String(error)}`);
    }
  }

  private async handleSteerCommand(event: ChannelTextEvent, args: string, locale: AppLocale): Promise<void> {
    if (this.stopped || (args.trim() && this.store.taskJournal.findReceipt(event, args.trim()))) return;
    const task = args.trim() ? this.captureTask(event, args.trim(), locale) : null;
    return this.scopeOperations.run(event.scopeId, () => this.handleSteerCommandNow(event, args, locale, task?.id));
  }

  private async handleSteerCommandNow(event: ChannelTextEvent, args: string, locale: AppLocale, taskId?: string): Promise<void> {
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
      await this.cancelActiveTurn(scopeId);
      await this.sendMessage(
        scopeId,
        locale === 'zh'
          ? `⚡ 已中断前置任务，立即开始插话指令：\n> ${args.trim()}`
          : `⚡ Interrupted active turn, executing steer instruction:\n> ${args.trim()}`,
      );
    }
    await this.startPromptTurnNow(event, args.trim(), locale, { taskId });
  }

  async handleInterrupt(scopeId: string, locale: AppLocale): Promise<void> {
    return this.scopeOperations.run(scopeId, () => this.handleInterruptNow(scopeId, locale));
  }

  private async handleInterruptNow(scopeId: string, locale: AppLocale): Promise<void> {
    const active = this.activeTurns.get(scopeId);
    const queuedCount = this.store.countQueuedTurnInputs(scopeId);
    if (active) {
      await this.cancelActiveTurn(scopeId);
      if (this.messaging.beginTaskPreview) return;
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
      const cleared = this.cancelQueuedWork(scopeId);
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

  async handleNewSession(scopeId: string, locale: AppLocale, cwdArg = ''): Promise<void> {
    return this.scopeOperations.run(scopeId, () => this.handleNewSessionNow(scopeId, locale, cwdArg));
  }

  private async handleNewSessionNow(scopeId: string, locale: AppLocale, targetCwdInput?: string): Promise<void> {
    if (this.recoveryBlocksScope(scopeId)) { await this.sendMessage(scopeId, locale === 'zh' ? '先用 /recover 处理待确认或待发送的任务，再新建会话。' : 'Resolve the pending task with /recover before creating a session.'); return; }
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
    this.cancelQueuedWork(scopeId);

    await this.cancelActiveTurn(scopeId);

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
    const ui = this.backends.ui(backendDesc.id) ?? this.customUi;
    const customStatus = await ui?.renderCustomStatus?.(scopeId, locale);

    const totalUsage = this.store.getCumulativeTokenUsage();
    const tokenLine = formatTokenUsageSummary(totalUsage, locale);
    const allUsages = this.store.getAllBackendTokenUsages();
    const breakdown = formatBackendTokenUsageBreakdown(allUsages);
    const usageText = backendDesc.defaults?.tokenUsage === false
      ? (locale === 'zh' ? '• **Token 消耗**: 当前后端未提供逐轮统计\n' : '• **Token usage**: Per-turn counts are not exposed by this backend\n')
      : `${tokenLine}${breakdown}\n`;

    const text =
      locale === 'zh'
        ? `📊 **${adapter.name} 运行状态**\n\n` +
          `• **当前引擎**: \`${backendDesc.name}\` (\`${backendDesc.id}\`)${backendDesc.account ? ` · \`${backendDesc.account}\`` : ''}\n` +
          `• **状态**: ${isBusy ? '⚡ 正在执行任务' : '💤 空闲'}\n` +
          `• **当前模型**: \`${settings?.model || '默认'}\`\n` +
          usageText +
          `• **绑定会话**: \`${binding?.threadId || '(新会话)'}\`\n` +
          `• **工作目录**: \`${binding?.cwd || this.config.defaultCwd}\`` +
          (customStatus ? `\n${customStatus}` : '')
        : `📊 **${adapter.name} Status**\n\n` +
          `• **Engine**: \`${backendDesc.name}\` (\`${backendDesc.id}\`)${backendDesc.account ? ` · \`${backendDesc.account}\`` : ''}\n` +
          `• **State**: ${isBusy ? '⚡ Executing' : '💤 Idle'}\n` +
          `• **Model**: \`${settings?.model || 'default'}\`\n` +
          usageText +
          `• **Thread**: \`${binding?.threadId || '(new)'}\`\n` +
          `• **Directory**: \`${binding?.cwd || this.config.defaultCwd}\`` +
          (customStatus ? `\n${customStatus}` : '');

    const keyboard: ChannelInlineKeyboard = [
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
    const ui = this.backends.ui(this.getBackendDescriptorForScope(scopeId).id) ?? this.customUi;
    if (await ui?.renderSetupMenu?.(scopeId, locale, editMessageId)) return;
    const settings = this.store.getChatSettings(scopeId);
    const mode = settings?.activeTurnMessageMode ?? 'queue';
    const isBoost = settings?.serviceTier === 'boost' && this.getBackendDescriptorForScope(scopeId).defaults?.boost !== false;
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
          (backendDesc.defaults?.boost !== false ? `• **Boost 增强**: ${isBoost ? '🚀 已开启' : '⚪ 已关闭'}\n` : '') +
          `• **运行中消息**: ${mode === 'steer' ? '⚡ 插话 (立即中断接管)' : '⏳ 排队 (完成后自动执行)'}\n\n` +
          `请选择要配置的项目：`
        : `⚙️ **${adapter.name} Setup Panel**\n\n` +
          `• **Engine**: \`${backendDesc.name}\` (\`${backendDesc.id}\`)${backendDesc.account ? ` · \`${backendDesc.account}\`` : ''}\n` +
          `• **Model**: \`${settings?.model || 'default'}\`\n` +
          `• **Effort**: \`${currentEffort || 'default'}\`\n` +
          (backendDesc.defaults?.boost !== false ? `• **Boost**: ${isBoost ? '🚀 Enabled' : '⚪ Disabled'}\n` : '') +
          `• **Active-Turn**: ${mode === 'steer' ? '⚡ Steer' : '⏳ Queue'}\n\n` +
          `Select setting to configure:`;

    const keyboard: ChannelInlineKeyboard = [];

    // 1. Model choices (Codex style)
    const models = await adapter.listModels(scopeId);
    const modelButtons: ChannelInlineKeyboard[0] = [
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
    const selectedModel = models.find(model => currentModel ? model.id === currentModel : model.isDefault);
    const supportedEfforts = selectedModel?.supportedReasoningEfforts ?? backendDesc.defaults?.supportedReasoningEfforts ?? ['low', 'medium', 'high'];

    const effortButtons: ChannelInlineKeyboard[0] = [
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
      ...(backendDesc.defaults?.boost !== false ? [{
        text: isBoost ? (locale === 'zh' ? '🚀 Boost: 开启' : '🚀 Boost: On') : (locale === 'zh' ? '⚪ Boost: 关闭' : '⚪ Boost: Off'),
        callback_data: 'engine:setup:boost',
      }] : []),
      {
        text: mode === 'steer' ? (locale === 'zh' ? '⚡ 插话模式' : '⚡ Steer') : (locale === 'zh' ? '⏳ 排队模式' : '⏳ Queue'),
        callback_data: 'engine:setup:active_mode',
      },
    ]);

    // 4. Custom rows (Account & History)
    if (ui?.renderCustomSetupRows) {
      const customRows = await ui.renderCustomSetupRows(scopeId, locale);
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
    const ui = this.backends.ui(this.getBackendDescriptorForScope(scopeId).id) ?? this.customUi;
    if (await ui?.renderModelsMenu?.(scopeId, locale, editMessageId)) return;
    const settings = this.store.getChatSettings(scopeId);
    const currentModel = settings?.model;
    const adapter = this.getAdapterForScope(scopeId);
    const models = await adapter.listModels(scopeId);

    const keyboard: ChannelInlineKeyboard = [];
    for (let i = 0; i < models.length; i += 2) {
      const row: ChannelInlineKeyboard[0] = [];
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
    const activeId = this.store.getActiveBackend(scopeId) || this.defaultBackendId;
    const activeBackend = this.backends.get(activeId) ?? { id: activeId, name: `${activeId} (${locale === 'zh' ? '不可用' : 'unavailable'})`, engineType: activeId, adapter: this.adapter };
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

    const keyboard: ChannelInlineKeyboard = [];

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

    if (this.serviceUi?.renderBackendMenuRows) {
      keyboard.push(...await this.serviceUi.renderBackendMenuRows(scopeId, locale));
    }
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
        await this.serviceUi?.renderBackendMenuRows?.(scopeId, locale),
      );
      return;
    }

    await this.switchBackend(scopeId, targetId, locale);
    await this.sendSetupMenu(scopeId, locale);
  }
}
