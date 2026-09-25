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
import { normalizeTurnActivityEvent } from '../controller/activity.js';
import { buildAttachmentPrompt } from '../telegram/media.js';
import type { SandboxModeValue } from '../types.js';

export class CodexEngineAdapter implements IEngineAdapter {
  readonly id: string;
  readonly name: string;
  private readonly defaultModel: string | undefined;
  private readonly defaultApprovalPolicy: string;
  private readonly defaultSandboxMode: SandboxModeValue;

  constructor(
    private readonly client: CodexAppClient,
    options: {
      id?: string;
      name?: string;
      defaultModel?: string | undefined;
      defaultApprovalPolicy?: string;
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
      }));
      if (!list.some((m) => m.id === 'gpt-6-sol')) {
        list.push({
          id: 'gpt-6-sol',
          name: 'GPT-6-Sol',
          description: 'Next-generation flagship model with deep reasoning',
          isDefault: false,
        });
      }
      return list;
    } catch {
      return [];
    }
  }

  executeTurn(request: EngineTurnRequest): EngineTurnExecution {
    const emitter = new EventEmitter();
    let threadId = request.threadId;
    let turnId: string | null = null;
    let cancelled = false;

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
            approvalPolicy: this.defaultApprovalPolicy,
            sandboxMode: this.defaultSandboxMode,
          });
          threadId = session.thread.threadId;
        } else {
          try {
            await this.client.resumeThread({
              threadId,
              cwd: request.cwd,
              approvalPolicy: this.defaultApprovalPolicy,
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
            approvalPolicy: this.defaultApprovalPolicy,
            sandboxMode: this.defaultSandboxMode,
          });
        } catch (turnErr) {
          const errMsg = String(turnErr);
          if (
            errMsg.includes('not found') ||
            errMsg.includes('No thread') ||
            errMsg.includes('stale') ||
            errMsg.includes('invalid thread')
          ) {
            const session = await this.client.startThread({
              cwd: request.cwd,
              model: effectiveModel,
              approvalPolicy: this.defaultApprovalPolicy,
              sandboxMode: this.defaultSandboxMode,
            });
            threadId = session.thread.threadId;
            turn = await this.client.startTurn({
              threadId,
              input: [{ type: 'text', text: promptText, text_elements: [] }],
              cwd: request.cwd,
              model: effectiveModel,
              effort: (request.effort as any) ?? null,
              serviceTier: request.serviceTier ?? undefined,
              collaborationMode: null,
              approvalPolicy: this.defaultApprovalPolicy,
              sandboxMode: this.defaultSandboxMode,
            });
          } else {
            throw turnErr;
          }
        }

        turnId = turn.id;
      } catch (err) {
        cleanup();
        turnError = err instanceof Error ? err : new Error(String(err));
        emitter.emit('error', turnError);
        resolveWaiters(null);
      }
    };

    void run();

    return {
      turnId: turnId ?? undefined,
      cancel: () => {
        cancelled = true;
        if (threadId && turnId) {
          void this.client.interruptTurn(threadId, turnId).catch(() => {});
        }
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
