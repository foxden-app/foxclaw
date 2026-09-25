import { EventEmitter } from 'node:events';
import type {
  IEngineAdapter,
  EngineModel,
  EngineTurnRequest,
  EngineTurnExecution,
  EngineTurnResult,
  EngineToolEvent,
  EngineTurnErrorContext,
} from '../core/engine_spi.js';
import type { AntigravityAppClient, AntigravityTurnExecution } from './client.js';
import type { AntigravityAuthManager } from './auth.js';
import { isCapacityOrUnavailableError } from './events.js';
import { buildAttachmentPrompt } from '../telegram/media.js';
import type { Logger } from '../logger.js';

export class AntigravityEngineAdapter implements IEngineAdapter {
  readonly id = 'antigravity';
  readonly name = 'Google Antigravity (AGY)';

  private readonly client: AntigravityAppClient;
  private readonly defaultModel: string;
  private readonly auth: AntigravityAuthManager | undefined;
  private readonly logger: Logger | undefined;

  constructor(
    client: AntigravityAppClient,
    defaultModel = 'gemini-3.8-flash-high',
    auth?: AntigravityAuthManager,
    logger?: Logger,
  ) {
    this.client = client;
    this.defaultModel = defaultModel;
    this.auth = auth;
    this.logger = logger;
  }

  async listModels(): Promise<EngineModel[]> {
    const rawModels = await this.client.listModels();
    return rawModels.map((m) => ({
      id: m,
      name: m.replace(/^gemini-/, '').replace(/^claude-/, 'Claude '),
      description: m.includes('flash')
        ? 'Fast, high-throughput model'
        : m.includes('pro')
          ? 'Deep reasoning & complex tasks'
          : undefined,
      isDefault: m === this.defaultModel,
    }));
  }

  executeTurn(request: EngineTurnRequest): EngineTurnExecution {
    const emitter = new EventEmitter();

    let prompt = request.prompt;
    if (request.stagedAttachments && request.stagedAttachments.length > 0 && !request.prompt.includes('Telegram attachments:')) {
      prompt = buildAttachmentPrompt(request.prompt, request.stagedAttachments);
    }

    const targetModel = (!request.model || request.model === 'default') ? this.defaultModel : request.model;

    const agTurn: AntigravityTurnExecution = this.client.executeTurn({
      prompt,
      conversationId: request.threadId,
      cwd: request.cwd,
      model: targetModel,
      effort: request.effort ?? null,
    });

    agTurn.on('event', (ev) => {
      switch (ev.kind) {
        case 'text':
          emitter.emit('delta', ev.delta);
          break;
        case 'tool':
          emitter.emit('tool', {
            name: ev.toolName,
            args: ev.parameters,
            output: ev.output,
            status: ev.state === 'ACTIVE' ? 'running' : ev.state === 'ERROR' ? 'failed' : 'completed',
          } satisfies EngineToolEvent);
          break;
        case 'result': {
          const res: EngineTurnResult = {
            kind: 'result',
            status: ev.status === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
            response: ev.response || ev.error || (ev.status === 'ERROR' ? 'Antigravity execution failed' : ''),
            conversationId: ev.conversationId,
          };
          emitter.emit('result', res);
          break;
        }
      }
    });

    agTurn.on('error', (err) => {
      emitter.emit('error', err);
    });

    agTurn.on('exit', (code) => {
      emitter.emit('exit', code);
    });

    return {
      turnId: agTurn.conversationId ?? undefined,
      cancel: () => agTurn.cancel(),
      waitForResult: async () => {
        const ev = await agTurn.waitForResult();
        if (!ev || ev.kind !== 'result') return null;
        return {
          kind: 'result',
          status: ev.status === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
          response: ev.response || ev.error || (ev.status === 'ERROR' ? 'Antigravity execution failed' : ''),
          conversationId: ev.conversationId,
        };
      },
      on: (event: string, listener: (...args: any[]) => void) => {
        emitter.on(event, listener);
      },
    };
  }

  async preflightTurn(_request: EngineTurnRequest): Promise<void> {
    if (this.auth) {
      try {
        await this.auth.ensureActiveTokenFresh(300);
      } catch (err) {
        this.logger?.warn('antigravity.preflight_refresh_failed', { error: String(err) });
      }
    }
  }

  async handleTurnError(ctx: EngineTurnErrorContext): Promise<boolean> {
    const isQuota =
      ctx.error.includes('ResourceExhausted') ||
      ctx.error.includes('RESOURCE_EXHAUSTED') ||
      ctx.error.includes('429') ||
      ctx.error.includes('quota') ||
      ctx.error.includes('Quota');

    if (isQuota && this.auth && ctx.retryCount < 3) {
      try {
        const active = await this.auth.getActiveAccount();
        if (active) {
          this.auth.markCooldown(active.name, 30 * 60 * 1000);
        }
        const rotated = await this.auth.rotateNextCandidate();
        await ctx.sendMessage(
          ctx.request.locale === 'zh'
            ? `⚠️ 检测到当前账号配额超限，已标记进入 30 分钟冷却，自动切换到账号 \`${rotated.account.email || rotated.account.name}\` 并重试…`
            : `⚠️ Quota limit detected. Marked account into 30m cooldown, switched to \`${rotated.account.email || rotated.account.name}\` and retrying…`,
        );
        await ctx.retryTurn(ctx.retryCount + 1);
        return true;
      } catch (rotateErr) {
        this.logger?.warn('antigravity.rotation_failed', {
          error: rotateErr instanceof Error ? rotateErr.message : String(rotateErr),
        });
      }
    }

    const isCapacity = isCapacityOrUnavailableError(ctx.error);
    if (isCapacity && ctx.retryCount < 2) {
      await ctx.sendMessage(
        ctx.request.locale === 'zh'
          ? `⏳ Google 模型服务临时繁忙 (503 Unavailable)，等待 2 秒后自动重试 (第 ${ctx.retryCount + 1}/2 次)…`
          : `⏳ Google model temporarily unavailable (503), retrying in 2s (attempt ${ctx.retryCount + 1}/2)…`,
      );
      await new Promise((r) => setTimeout(r, 2000));
      await ctx.retryTurn(ctx.retryCount + 1);
      return true;
    }

    if (isCapacity) {
      await ctx.sendMessage(
        ctx.request.locale === 'zh'
          ? `⚠️ **Google 模型容量繁忙 (503 UNAVAILABLE)**\n\nGoogle 服务端当前模型 (\`${ctx.request.model}\`) 暂时无可用容量。\n\n💡 **建议方案**：\n• 稍等 1 分钟后重试\n• 发送 /setup 或 /models 切换为 \`gemini-3.1-pro-high\` 继续`
          : `⚠️ **Model Capacity Unavailable (503)**\n\nGoogle servers have no capacity for \`${ctx.request.model}\` right now.\n\n💡 Tip: Wait 1 minute or switch model via /setup or /models.`,
      );
      return true;
    }

    return false;
  }
}
