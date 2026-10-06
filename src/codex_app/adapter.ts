import { EventEmitter } from 'node:events';
import type {
  IEngineAdapter,
  EngineModel,
  EngineTurnRequest,
  EngineTurnExecution,
  EngineTurnResult,
  EngineToolEvent,
} from '../core/engine_spi.js';
import type { CodexAppClient } from './client.js';
import { normalizeTurnActivityEvent } from './activity.js';
import { buildAttachmentPrompt } from '../core/attachment_files.js';
import { resolveAccessMode } from '../core/access.js';
import type { SandboxModeValue, ApprovalPolicyValue } from '../types.js';

export class CodexEngineAdapter implements IEngineAdapter {
  readonly supportsCommentary = true;
  readonly id: string;
  readonly name: string;
  private readonly defaultModel: string | undefined;
  private readonly defaultApprovalPolicy: ApprovalPolicyValue;
  private readonly defaultSandboxMode: SandboxModeValue;

  constructor(
    private readonly client: CodexAppClient,
    options: {
      id?: string;
      name?: string;
      defaultModel?: string | undefined;
      defaultApprovalPolicy?: ApprovalPolicyValue;
      defaultSandboxMode?: SandboxModeValue;
    } = {},
  ) {
    this.id = options.id ?? 'codex';
    this.name = options.name ?? 'OpenAI Codex (App Server)';
    this.defaultModel = options.defaultModel;
    this.defaultApprovalPolicy = options.defaultApprovalPolicy ?? 'on-request';
    this.defaultSandboxMode = options.defaultSandboxMode ?? 'workspace-write';
  }

  async listModels(): Promise<EngineModel[]> {
    try {
      const models = await this.client.listModels();
      const list: EngineModel[] = models.map((m) => ({
        id: m.id,
        name: m.displayName || m.id,
        description: m.description,
        isDefault: m.isDefault || m.id === this.defaultModel,
        supportedReasoningEfforts: m.supportedReasoningEfforts,
      }));
      return list;
    } catch {
      return [];
    }
  }

  executeTurn(request: EngineTurnRequest): EngineTurnExecution {
    const emitter = new EventEmitter();
    const access = resolveAccessMode({ defaultApprovalPolicy: this.defaultApprovalPolicy, defaultSandboxMode: this.defaultSandboxMode }, { accessPreset: request.accessPreset ?? 'default' });
    let threadId = request.threadId;
    let turnId: string | null = null;
    let cancelled = false;
    const earlyNotifications: any[] = [];
    let usage: EngineTurnResult['usage'];
    let lastUsageTotal: string | undefined;

    let promptText = request.prompt;
    if (request.stagedAttachments && request.stagedAttachments.length > 0 && !request.prompt.includes('Telegram attachments:')) {
      promptText = buildAttachmentPrompt(request.prompt, request.stagedAttachments);
    }

    let accumulatedResponse = '';
    const messages = new Map<string, { text: string; kind: string; sent: boolean }>();
    const responseText = () => [...messages.values()].filter(message => message.kind !== 'commentary' && message.kind !== 'tool_summary').map(message => message.text).join('\n\n');

    let finalResult: EngineTurnResult | null = null;
    let turnError: Error | null = null;
    const resultWaiters: Array<(res: EngineTurnResult | null) => void> = [];

    const resolveWaiters = (res: EngineTurnResult | null) => {
      while (resultWaiters.length > 0) {
        resultWaiters.shift()!(res);
      }
    };

    const onNotification = (msg: any) => {
      if (cancelled || finalResult || turnError) return;
      if (threadId && msg.params?.threadId && msg.params.threadId !== threadId) return;
      if (!turnId) {
        earlyNotifications.push(msg);
        if (earlyNotifications.length > 1000) earlyNotifications.shift();
        return;
      }
      try {
        if (msg.method === 'thread/tokenUsage/updated') {
          if (msg.params?.turnId && msg.params.turnId !== turnId) return;
          const native = msg.params?.tokenUsage;
          const current = native?.last;
          if (!current) return;
          // `last` is one model request; `total` is cumulative for the thread.
          // Repeated notifications with the same cumulative counters are not new usage.
          const signature = native.total ? JSON.stringify(native.total) : undefined;
          if (signature && signature === lastUsageTotal) return;
          lastUsageTotal = signature;
          usage ??= {};
          for (const [key, nativeKey] of [['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['cachedTokens', 'cachedInputTokens'], ['totalTokens', 'totalTokens']] as const) {
            const value = current[nativeKey];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[key] = (usage[key] ?? 0) + value;
          }
          return;
        }
        const ev = normalizeTurnActivityEvent(msg);
        if (!ev) return;
        if (ev.turnId && turnId && ev.turnId !== turnId) return;

        if (ev.kind === 'agent_message_started' || ev.kind === 'agent_message_delta' || ev.kind === 'agent_message_completed') {
          const phase = ev.kind === 'agent_message_delta' ? msg.params?.phase ?? msg.params?.item?.phase : ev.phase;
          const knownKind = Boolean(phase) || ev.isPlan;
          let message = messages.get(ev.itemId);
          if (!message) {
            message = { text: '', kind: knownKind || ev.kind === 'agent_message_completed' ? ev.outputKind : 'unknown', sent: false };
            messages.set(ev.itemId, message);
          }
          // Deltas often omit phase; started/completed items carry the authoritative phase.
          if (knownKind || (ev.kind === 'agent_message_completed' && message.kind === 'unknown')) message.kind = ev.outputKind;
          if (ev.kind === 'agent_message_delta') {
            message.text += ev.delta;
            if (message.kind !== 'commentary' && message.kind !== 'tool_summary') emitter.emit('delta', ev.delta);
          } else if (ev.kind === 'agent_message_completed') {
            if (ev.text !== null) message.text = ev.text;
            if ((message.kind === 'commentary' || message.kind === 'tool_summary') && !message.sent && message.text.trim()) {
              message.sent = true;
              emitter.emit('commentary', { messageId: ev.itemId, text: message.text });
            }
          }
          accumulatedResponse = responseText();
        } else if (ev.kind === 'tool_started') {
          const cmdName = Array.isArray(ev.exec?.command) ? ev.exec.command.join(' ') : 'command';
          emitter.emit('tool', {
            name: cmdName,
            status: 'running',
          } satisfies EngineToolEvent);
        } else if (ev.kind === 'tool_completed') {
          const cmdName = Array.isArray(ev.exec?.command) ? ev.exec.command.join(' ') : 'command';
          emitter.emit('tool', {
            name: cmdName,
            status: 'completed',
          } satisfies EngineToolEvent);
        } else if (ev.kind === 'turn_completed') {
          cleanup();
          const nativeTurn = msg.params?.turn;
          const failure = nativeTurn?.error?.message ?? (nativeTurn?.status === 'failed' ? 'Codex turn failed' : undefined);
          finalResult = {
            kind: 'result',
            status: failure ? 'ERROR' : nativeTurn?.status === 'interrupted' || ev.state === 'interrupted' ? 'INTERRUPTED' : 'SUCCESS',
            ...(failure ? { error: String(failure) } : {}),
            response: accumulatedResponse,
            conversationId: threadId,
            usage,
          };
          emitter.emit('result', finalResult);
          resolveWaiters(finalResult);
        }
      } catch {
        // Ignore parsing errors for unrelated notifications
      }
    };

    const cleanup = () => {
      this.client.off('notification', onNotification);
      this.client.off('disconnected', onDisconnected);
      earlyNotifications.length = 0;
    };

    const onDisconnected = () => {
      if (finalResult || turnError) return;
      cleanup();
      finalResult = { kind: 'result', status: 'ERROR', response: responseText(),
        error: 'Codex connection closed before the task outcome was confirmed.', outcomeUnknown: true, conversationId: threadId, usage };
      emitter.emit('result', finalResult);
      resolveWaiters(finalResult);
    };
    this.client.on('notification', onNotification);
    this.client.on('disconnected', onDisconnected);

    const effectiveModel =
      request.model && request.model !== 'default'
        ? request.model
        : (this.defaultModel && this.defaultModel !== 'default' ? this.defaultModel : null);

    const run = async () => {
      try {
        if (!threadId) {
          const session = await this.client.startThread({
            cwd: request.cwd,
            model: effectiveModel,
            approvalPolicy: access.approvalPolicy,
            sandboxMode: access.sandboxMode,
          });
          threadId = session.thread.threadId;
        } else {
          try {
            await this.client.resumeThread({
              threadId,
              cwd: request.cwd,
              approvalPolicy: access.approvalPolicy,
              sandboxMode: access.sandboxMode,
            });
          } catch {
            // thread might already be active on server
          }
        }

        if (cancelled || finalResult) {
          cleanup();
          return;
        }

        if (!threadId) {
          throw new Error('Failed to resolve or create Codex thread for turn');
        }

        emitter.emit('conversation', threadId);
        let turn: { id: string };
        try {
          turn = await this.client.startTurn({
            threadId,
            input: [{ type: 'text', text: promptText, text_elements: [] }],
            cwd: request.cwd,
            model: effectiveModel,
            effort: (request.effort as any) ?? null,
            serviceTier: request.serviceTier ?? undefined,
            collaborationMode: null,
            approvalPolicy: access.approvalPolicy,
            sandboxMode: access.sandboxMode,
          });
        } catch (turnErr) {
          const errMsg = String(turnErr);
          if (
            errMsg.includes('not found') ||
            errMsg.includes('No thread') ||
            errMsg.includes('stale') ||
            errMsg.includes('invalid thread')
          ) {
            if (cancelled || finalResult) throw turnErr;
            const session = await this.client.startThread({
              cwd: request.cwd,
              model: effectiveModel,
              approvalPolicy: access.approvalPolicy,
              sandboxMode: access.sandboxMode,
            });
            threadId = session.thread.threadId;
            if (cancelled || finalResult) { cleanup(); return; }
            emitter.emit('conversation', threadId);
            turn = await this.client.startTurn({
              threadId,
              input: [{ type: 'text', text: promptText, text_elements: [] }],
              cwd: request.cwd,
              model: effectiveModel,
              effort: (request.effort as any) ?? null,
              serviceTier: request.serviceTier ?? undefined,
              collaborationMode: null,
              approvalPolicy: access.approvalPolicy,
              sandboxMode: access.sandboxMode,
            });
          } else {
            throw turnErr;
          }
        }

        if (finalResult) return;
        turnId = turn.id;
        for (const notification of earlyNotifications.splice(0)) onNotification(notification);
      } catch (err) {
        cleanup();
        if (finalResult) return;
        const failure = err instanceof Error ? err : new Error(String(err));
        if (failure.message.includes('result is unknown')) {
          finalResult = { kind: 'result', status: 'ERROR', response: responseText(), error: failure.message,
            outcomeUnknown: true, conversationId: threadId };
          emitter.emit('result', finalResult); resolveWaiters(finalResult); return;
        }
        turnError = failure;
        emitter.emit('error', turnError);
        resolveWaiters(null);
      }
    };

    const running = run();
    let cancelling: Promise<void> | undefined;

    return {
      get turnId() { return turnId ?? undefined; },
      cancel: () => {
        if (finalResult) return Promise.resolve();
        cancelling ??= (async () => {
          cancelled = true;
          await running;
          if (finalResult) return;
          if (threadId && turnId) await this.client.interruptTurn(threadId, turnId);
          cleanup();
          finalResult = { kind: 'result', status: 'INTERRUPTED', response: accumulatedResponse, conversationId: threadId, usage };
          emitter.emit('result', finalResult);
          resolveWaiters(finalResult);
        })();
        return cancelling.catch(error => { cancelling = undefined; throw error; });
      },
      waitForResult: async () => {
        if (finalResult) return finalResult;
        if (turnError) return null;
        return new Promise<EngineTurnResult | null>((resolve) => {
          resultWaiters.push(resolve);
        });
      },
      on: (event: string, listener: (...args: any[]) => void) => {
        emitter.on(event, listener);
      },
    };
  }
}
