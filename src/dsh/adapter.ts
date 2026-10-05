import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { ContentBlock, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import type { IEngineAdapter, EngineModel, EngineTurnRequest, EngineTurnExecution, EngineTurnResult, EngineToolEvent } from '../core/engine_spi.js';
import type { AccessPresetValue } from '../types.js';
import { buildAttachmentPrompt, isNativeImageAttachment } from '../telegram/media.js';
import { DshClient, type SessionConfigOption, type SessionNotification } from './client.js';

export function optionChoices(option?: SessionConfigOption): SessionConfigSelectOption[] {
  if (option?.type !== 'select') return [];
  return option.options.flatMap(item => 'options' in item ? item.options : [item]);
}

export function modelId(value: string): string {
  const route: unknown = JSON.parse(value);
  if (!Array.isArray(route) || route.length !== 2 || !route.every(part => typeof part === 'string' && part.length > 0)) throw new Error('Invalid DSH model route');
  return `${route[0]}/${route[1]}`;
}

interface ScopePreferences {
  cwd: string;
  threadId: string | null;
  model: string | null;
  effort: string | null;
  access: AccessPresetValue;
}
interface ScopeSession { client: DshClient; sessionId: string; cwd: string; defaultModel: string; defaultEffort: string | null; }

/** Persistent DSH sessions over the shipped ACP profile. */
export class DshEngineAdapter implements IEngineAdapter {
  readonly id = 'dsh';
  readonly name = 'DeepSeek Harness (DSH)';
  private readonly clients = new Map<string, DshClient>();
  private readonly sessions = new Map<string, ScopeSession>();
  private readonly pending = new Map<string, Promise<ScopeSession>>();
  private readonly busy = new Set<string>();
  private closed = false;

  constructor(private readonly options: {
    createClient: (scopeId: string) => DshClient;
    preferences: (scopeId: string) => ScopePreferences;
    bind: (scopeId: string, sessionId: string, cwd: string) => void;
  }) {}

  async sessionForScope(scopeId: string): Promise<ScopeSession> {
    if (this.closed) throw new Error('DSH backend is stopped');
    const existing = this.pending.get(scopeId);
    if (existing) return existing;
    const task = this.openSession(scopeId).finally(() => this.pending.delete(scopeId));
    this.pending.set(scopeId, task);
    return task;
  }

  private async openSession(scopeId: string): Promise<ScopeSession> {
    const prefs = this.options.preferences(scopeId);
    let client = this.clients.get(scopeId);
    if (!client) { client = this.options.createClient(scopeId); this.clients.set(scopeId, client); }
    await client.setAccess(prefs.access);
    const previous = this.sessions.get(scopeId);
    if (client.connected && previous && previous.sessionId === prefs.threadId && previous.cwd === prefs.cwd) return previous;
    if (previous && this.busy.has(scopeId)) throw new Error('DSH session is busy');
    if (previous && client.connected) await client.closeSession(previous.sessionId);
    const sessionId = await client.session(prefs.cwd, prefs.threadId);
    const config = client.configOptions(sessionId);
    const model = config.find(item => item.id === 'model');
    const effort = config.find(item => item.id === 'reasoning_effort');
    const state: ScopeSession = { client, sessionId, cwd: prefs.cwd, defaultModel: String(model?.currentValue ?? ''), defaultEffort: effort?.type === 'select' ? effort.currentValue : null };
    this.sessions.set(scopeId, state);
    this.options.bind(scopeId, sessionId, prefs.cwd);
    return state;
  }

  async listModels(scopeId = 'dsh:catalog'): Promise<EngineModel[]> {
    const state = await this.sessionForScope(scopeId);
    return optionChoices(state.client.configOptions(state.sessionId).find(option => option.id === 'model')).map(choice => ({ id: modelId(choice.value), name: choice.name, description: choice.description ?? undefined, isDefault: choice.value === state.defaultModel }));
  }

  async selectModel(scopeId: string, id: string | null): Promise<void> {
    const state = await this.sessionForScope(scopeId);
    const model = state.client.configOptions(state.sessionId).find(option => option.id === 'model');
    const choice = optionChoices(model).find(choice => id === null ? choice.value === state.defaultModel : modelId(choice.value) === id);
    if (!choice) throw new Error(`DSH model unavailable: ${id}`);
    await state.client.setConfig(state.sessionId, 'model', choice.value);
    const effort = state.client.configOptions(state.sessionId).find(option => option.id === 'reasoning_effort');
    state.defaultEffort = effort?.type === 'select' ? effort.currentValue : null;
  }

  async listEfforts(scopeId: string) {
    const state = await this.sessionForScope(scopeId);
    return optionChoices(state.client.configOptions(state.sessionId).find(option => option.id === 'reasoning_effort'));
  }

  async selectEffort(scopeId: string, effort: string | null): Promise<void> {
    const state = await this.sessionForScope(scopeId);
    const choices = await this.listEfforts(scopeId);
    if (choices.length === 0 && effort === null) return;
    const value = effort ?? state.defaultEffort;
    if (value === null || !choices.some(choice => choice.value === value)) throw new Error(`DSH reasoning effort unavailable: ${effort}`);
    await state.client.setConfig(state.sessionId, 'reasoning_effort', value);
  }

  async setAccess(scopeId: string, access: AccessPresetValue): Promise<void> {
    const state = await this.sessionForScope(scopeId);
    await state.client.setAccess(access);
  }

  async listSessions(scopeId: string, cursor?: string) { return (await this.sessionForScope(scopeId)).client.listSessions(cursor); }

  isBusy(scopeId: string): boolean { return this.busy.has(scopeId); }

  executeTurn(request: EngineTurnRequest): EngineTurnExecution {
    const emitter = new EventEmitter();
    let cancelled = false;
    let state: ScopeSession | undefined;
    let finished = false;
    let ownsSlot = false;
    let result: EngineTurnResult | null = null;
    let resolveResult!: (value: EngineTurnResult) => void;
    const promise = new Promise<EngineTurnResult>(resolve => { resolveResult = resolve; });
    let response = '';
    let finalMessage = '';
    let finalMessageId: string | undefined;
    const tools = new Map<string, string>();
    const onUpdate = (notification: SessionNotification): void => {
      if (notification.sessionId !== state?.sessionId) return;
      const update = notification.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        if (update.messageId && update.messageId !== finalMessageId) { finalMessageId = update.messageId; finalMessage = ''; }
        finalMessage += update.content.text;
        response += update.content.text;
        emitter.emit('delta', update.content.text);
      } else if (update.sessionUpdate === 'tool_call') {
        tools.set(update.toolCallId, update.title);
        emitter.emit('tool', { name: update.title, args: update.rawInput == null ? undefined : JSON.stringify(update.rawInput), status: 'running' } satisfies EngineToolEvent);
      } else if (update.sessionUpdate === 'tool_call_update') {
        emitter.emit('tool', { name: tools.get(update.toolCallId) ?? update.toolCallId, status: update.status === 'failed' ? 'failed' : update.status === 'completed' ? 'completed' : 'running' } satisfies EngineToolEvent);
      }
    };
    const run = async (): Promise<void> => {
      try {
        if (this.busy.has(request.scopeId)) throw new Error('DSH already has an active turn in this scope');
        state = await this.sessionForScope(request.scopeId);
        if (cancelled) return;
        if (this.busy.has(request.scopeId)) throw new Error('DSH already has an active turn in this scope');
        this.busy.add(request.scopeId);
        ownsSlot = true;
        emitter.emit('conversation', state.sessionId);
        await this.selectModel(request.scopeId, request.model === 'default' ? null : request.model);
        await this.selectEffort(request.scopeId, request.effort ?? null);
        if (cancelled) return;
        const attachments = request.stagedAttachments ?? [];
        const images = state.client.imageSupported ? attachments.filter(isNativeImageAttachment) : [];
        const files = attachments.filter(attachment => !images.includes(attachment));
        const content: ContentBlock[] = [{ type: 'text', text: files.length ? buildAttachmentPrompt(request.prompt, files) : request.prompt }];
        for (const attachment of images) content.push({ type: 'image', data: (await fs.readFile(attachment.localPath)).toString('base64'), mimeType: attachment.mimeType || 'image/jpeg' });
        state.client.on('update', onUpdate);
        if (cancelled) return;
        const value = await state.client.agent.request('session/prompt', { sessionId: state.sessionId, prompt: content });
        result = { kind: 'result', status: cancelled || value.stopReason === 'cancelled' ? 'INTERRUPTED' : 'SUCCESS', response: finalMessage || response, conversationId: state.sessionId };
      } catch (error) {
        result = { kind: 'result', status: cancelled ? 'INTERRUPTED' : 'ERROR', response: finalMessage || response, error: error instanceof Error ? error.message : String(error), conversationId: state?.sessionId ?? request.threadId };
      } finally {
        state?.client.off('update', onUpdate);
        if (ownsSlot) this.busy.delete(request.scopeId);
        result ??= { kind: 'result', status: 'INTERRUPTED', response: finalMessage || response, conversationId: state?.sessionId ?? request.threadId };
        finished = true;
        resolveResult(result);
        emitter.emit('result', result);
      }
    };
    queueMicrotask(() => { void run(); });
    return {
      cancel: () => {
        if (finished || cancelled) return;
        cancelled = true;
        state?.client.cancelPermissions?.();
        if (state?.client.connected) void state.client.agent.notify('session/cancel', { sessionId: state.sessionId }).catch(() => {});
      },
      waitForResult: () => promise,
      on: (event: string, listener: (...args: any[]) => void) => { emitter.on(event, listener); },
    };
  }

  async stop(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.clients.values()].map(client => client.stop()));
    this.clients.clear();
    this.sessions.clear();
  }
}
