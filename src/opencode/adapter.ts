import { EventEmitter } from 'node:events';
import type {
  IEngineAdapter,
  EngineModel,
  EngineTurnRequest,
  EngineTurnExecution,
  EngineTurnResult,
  EngineToolEvent,
} from '../core/engine_spi.js';
import type { OpencodeAppClient } from './client.js';
import { formatSdkError } from './client.js';
import type { OpencodeBridgeEvent } from './events.js';
import { buildAttachmentPrompt } from '../telegram/media.js';

export class OpencodeEngineAdapter implements IEngineAdapter {
  readonly id = 'opencode';
  readonly name = 'OpenCode (SDK)';

  constructor(
    private readonly client: OpencodeAppClient,
    private readonly defaultModel?: string,
  ) {}

  async listModels(): Promise<EngineModel[]> {
    if (!this.client.isConnected()) return [];
    try {
      const response = await this.client.getClient().provider.list();
      if (response.error || !response.data) return [];
      const { all, connected, default: defaultMap } = response.data;
      const models: EngineModel[] = [];
      for (const providerId of connected) {
        const provider = all.find((p) => p.id === providerId);
        if (!provider) continue;
        const defaultForProvider = defaultMap[providerId];
        for (const m of Object.values(provider.models)) {
          const modelFullId = `${providerId}/${m.id}`;
          models.push({
            id: modelFullId,
            name: `${provider.name} - ${m.name}`,
            isDefault: m.id === defaultForProvider,
          });
        }
      }
      return models;
    } catch {
      return [];
    }
  }

  executeTurn(request: EngineTurnRequest): EngineTurnExecution {
    const emitter = new EventEmitter();
    let sessionId = request.threadId;
    let cancelled = false;

    let promptText = request.prompt;
    if (request.stagedAttachments && request.stagedAttachments.length > 0 && !request.prompt.includes('Telegram attachments:')) {
      promptText = buildAttachmentPrompt(request.prompt, request.stagedAttachments);
    }

    let finalResult: EngineTurnResult | null = null;
    let turnError: Error | null = null;
    const resultWaiters: Array<(res: EngineTurnResult | null) => void> = [];

    const resolveWaiters = (res: EngineTurnResult | null) => {
      while (resultWaiters.length > 0) {
        resultWaiters.shift()!(res);
      }
    };

    const run = async () => {
      try {
        const sdk = this.client.getClient();
        if (!sessionId) {
          const createRes = await sdk.session.create({ directory: request.cwd });
          if (createRes.error || !createRes.data) {
            throw new Error(`Failed to create OpenCode session: ${formatSdkError(createRes.error)}`);
          }
          sessionId = createRes.data.id;
        }

        if (cancelled) return;

        let accumulatedResponse = '';

        const onEvent = (ev: OpencodeBridgeEvent) => {
          if ('sessionId' in ev && ev.sessionId === sessionId) {
            if (ev.kind === 'text') {
              if (ev.delta) {
                accumulatedResponse += ev.delta;
                emitter.emit('delta', ev.delta);
              }
            } else if (ev.kind === 'tool') {
              emitter.emit('tool', {
                name: ev.tool,
                args: undefined,
                output: undefined,
                status: ev.status === 'running' ? 'running' : ev.status === 'error' ? 'failed' : 'completed',
              } satisfies EngineToolEvent);
            } else if (ev.kind === 'idle') {
              cleanup();
              finalResult = {
                kind: 'result',
                status: 'SUCCESS',
                response: accumulatedResponse,
                conversationId: sessionId,
              };
              emitter.emit('result', finalResult);
              resolveWaiters(finalResult);
            } else if (ev.kind === 'error') {
              cleanup();
              turnError = new Error(ev.message);
              finalResult = {
                kind: 'result',
                status: 'ERROR',
                response: ev.message,
                conversationId: sessionId,
              };
              emitter.emit('result', finalResult);
              emitter.emit('error', turnError);
              resolveWaiters(finalResult);
            }
          }
        };

        const cleanup = () => {
          this.client.off('event', onEvent);
        };

        this.client.on('event', onEvent);

        let modelParam: { providerID: string; modelID: string } | undefined;
        const targetModel = request.model || this.defaultModel;
        if (targetModel && targetModel.includes('/')) {
          const [pId, ...mRest] = targetModel.split('/');
          modelParam = { providerID: pId!, modelID: mRest.join('/') };
        }

        const promptRes = await sdk.session.promptAsync({
          sessionID: sessionId,
          directory: request.cwd,
          parts: [{ type: 'text', text: promptText }],
          ...(modelParam ? { model: modelParam } : {}),
        });

        if (promptRes.error) {
          cleanup();
          turnError = new Error(formatSdkError(promptRes.error));
          emitter.emit('error', turnError);
          resolveWaiters(null);
        } else {
          this.client.watchSessionUntilIdle(sessionId, request.cwd);
        }
      } catch (err) {
        turnError = err instanceof Error ? err : new Error(String(err));
        emitter.emit('error', turnError);
        resolveWaiters(null);
      }
    };

    void run();

    return {
      turnId: sessionId ?? undefined,
      cancel: () => {
        cancelled = true;
        if (sessionId) {
          void this.client.getClient().session.abort({ sessionID: sessionId }).catch(() => {});
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
