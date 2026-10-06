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

    let promptText = request.prompt;
    if (request.stagedAttachments && request.stagedAttachments.length > 0 && !request.prompt.includes('Telegram attachments:')) {
      promptText = buildAttachmentPrompt(request.prompt, request.stagedAttachments);
    }

    let accumulatedResponse = '';
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
        const ev = normalizeTurnActivityEvent(msg);
        if (!ev) return;
        if (ev.turnId && turnId && ev.turnId !== turnId) return;

        if (ev.kind === 'agent_message_delta') {
          accumulatedResponse += ev.delta;
          emitter.emit('delta', ev.delta);
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
          finalResult = {
            kind: 'result',
            status: ev.state === 'interrupted' ? 'INTERRUPTED' : 'SUCCESS',
            response: accumulatedResponse,
            conversationId: threadId,
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
      earlyNotifications.length = 0;
    };

    this.client.on('notification', onNotification);

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

        if (cancelled) {
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
            if (cancelled) throw turnErr;
            const session = await this.client.startThread({
              cwd: request.cwd,
              model: effectiveModel,
              approvalPolicy: access.approvalPolicy,
              sandboxMode: access.sandboxMode,
            });
            threadId = session.thread.threadId;
            if (cancelled) { cleanup(); return; }
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

        turnId = turn.id;
        for (const notification of earlyNotifications.splice(0)) onNotification(notification);
      } catch (err) {
        cleanup();
        turnError = err instanceof Error ? err : new Error(String(err));
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
          finalResult = { kind: 'result', status: 'INTERRUPTED', response: accumulatedResponse, conversationId: threadId };
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
