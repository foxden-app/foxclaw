import { EventEmitter } from 'node:events';
import path from 'node:path';
import type {
  IEngineAdapter,
  EngineModel,
  EngineTurnRequest,
  EngineTurnExecution,
  EngineTurnResult,
  EngineToolEvent,
  EngineTurnErrorContext,
} from '../core/engine_spi.js';
import { normalizeAgyModelId, type AntigravityAppClient, type AntigravityTurnExecution } from './client.js';
import type { AntigravityAuthManager } from './auth.js';
import {
  isCapacityOrUnavailableError,
  isVerificationError,
  isQuotaOrAuthError,
} from './events.js';
import { buildAttachmentPrompt } from '../telegram/media.js';
import type { Logger } from '../logger.js';

function extractToolSummary(name: string, parameters?: Record<string, unknown>): string | undefined {
  if (!parameters) return undefined;
  if (typeof parameters.CommandLine === 'string') {
    return `$ ${parameters.CommandLine.slice(0, 70)}`;
  }
  if (typeof parameters.TargetFile === 'string') {
    return path.basename(parameters.TargetFile);
  }
  if (typeof parameters.AbsolutePath === 'string') {
    return path.basename(parameters.AbsolutePath);
  }
  if (typeof parameters.path === 'string') {
    return path.basename(parameters.path);
  }
  if (typeof parameters.query === 'string') {
    return parameters.query.slice(0, 60);
  }
  if (typeof parameters.Url === 'string') {
    return parameters.Url.slice(0, 60);
  }
  if (typeof parameters.toolSummary === 'string') {
    return parameters.toolSummary.slice(0, 60);
  }
  if (typeof parameters.toolAction === 'string') {
    return parameters.toolAction.slice(0, 60);
  }
  return undefined;
}

export class AntigravityEngineAdapter implements IEngineAdapter {
  readonly id = 'antigravity';
  readonly name = 'Google Antigravity (AGY)';

  private readonly client: AntigravityAppClient;
  private readonly defaultModel: string;
  private readonly auth: AntigravityAuthManager | undefined;
  private readonly logger: Logger | undefined;

  constructor(
    client: AntigravityAppClient,
    defaultModel = 'gemini-3.8-flash',
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
    const seen = new Set<string>();
    const result: EngineModel[] = [];

    for (const raw of rawModels) {
      const m = normalizeAgyModelId(raw);
      if (seen.has(m)) continue;
      seen.add(m);

      let displayName = m;
      if (m === 'gemini-3.8-flash') displayName = 'Gemini 3.8 Flash';
      else if (m === 'gemini-3.7-flash') displayName = 'Gemini 3.7 Flash';
      else if (m === 'gemini-3.6-flash') displayName = 'Gemini 3.6 Flash';
      else if (m === 'gemini-3.1-pro') displayName = 'Gemini 3.1 Pro';
      else if (m === 'claude-sonnet-4-6') displayName = 'Claude Sonnet 4.6';
      else if (m === 'claude-opus-4-6') displayName = 'Claude Opus 4.6';
      else if (m === 'gpt-oss-120b') displayName = 'GPT-OSS 120B';
      else displayName = m.replace(/^gemini-/, 'Gemini ').replace(/^claude-/, 'Claude ');

      result.push({
        id: m,
        name: displayName,
        description: m.includes('flash')
          ? 'Fast, high-throughput model'
          : m.includes('pro')
            ? 'Deep reasoning & complex tasks'
            : undefined,
        isDefault: m === this.defaultModel || (this.defaultModel.startsWith(m) && !m.includes('-')),
      });
    }

    return result;
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
            stepIndex: ev.stepIndex,
            summary: extractToolSummary(ev.toolName, ev.parameters),
          } satisfies EngineToolEvent);
          break;
        case 'result': {
          const res: EngineTurnResult = {
            kind: 'result',
            status: ev.status === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
            response: ev.response || ev.error || (ev.status === 'ERROR' ? 'Antigravity execution failed' : ''),
            error: ev.error || (ev.status === 'ERROR' ? 'Antigravity execution failed' : undefined),
            conversationId: ev.conversationId,
            usage: ev.usage
              ? {
                  inputTokens: ev.usage.input_tokens,
                  outputTokens: ev.usage.output_tokens,
                  cachedTokens: ev.usage.cache_read_tokens,
                  totalTokens: ev.usage.total_tokens,
                }
              : undefined,
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
          error: ev.error || (ev.status === 'ERROR' ? 'Antigravity execution failed' : undefined),
          conversationId: ev.conversationId,
          usage: ev.usage
            ? {
                inputTokens: ev.usage.input_tokens,
                outputTokens: ev.usage.output_tokens,
                cachedTokens: ev.usage.cache_read_tokens,
                totalTokens: ev.usage.total_tokens,
              }
            : undefined,
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
    const isVerification = isVerificationError(ctx.error);
    const isQuota = !isVerification && isQuotaOrAuthError(ctx.error);

    if (isVerification && this.auth && ctx.retryCount < 3) {
      try {
        const active = await this.auth.getActiveAccount();
        const failingName = active?.name || 'unknown';
        const failingEmail = active?.email || failingName;

        this.auth.pauseAccount(failingName);
        this.auth.markCooldown(failingName, 60 * 60 * 1000);
        if (active?.email) {
          this.auth.pauseAccount(active.email);
          this.auth.markCooldown(active.email, 60 * 60 * 1000);
        }

        const rotated = await this.auth.rotateNextCandidate(failingName);
        const nextAccountName = rotated.account.email || rotated.account.name;

        await ctx.sendMessage(
          ctx.request.locale === 'zh'
            ? `🛡️ **检测到 Google 安全验证风控 (Verification Required)**\n\n` +
              `• **受限账号**: \`${failingEmail}\` (已自动暂停并冷却)\n` +
              `• **故障恢复**: 已无感切换至备用账号 \`${nextAccountName}\`，正在继续执行您的任务…\n\n` +
              `💡 **如何人工解除该账号风控**：\n` +
              `1. 可在终端/CLI 执行 \`agy -p "hi"\`，在弹出的浏览器完成人机验证；\n` +
              `2. 或在 Telegram 发送 \`/login\` 重新授权该账号后即可恢复。`
            : `🛡️ **Google Security Verification Triggered (Verification Required)**\n\n` +
              `• **Affected**: \`${failingEmail}\` (paused & cooling)\n` +
              `• **Failover**: Switched to \`${nextAccountName}\`, continuing your task…\n\n` +
              `💡 **How to resolve**: Complete verification via \`agy -p "hi"\` in browser or run \`/login\` in Telegram.`,
        );

        await ctx.retryTurn(ctx.retryCount + 1);
        return true;
      } catch (err) {
        this.logger?.warn('antigravity.verification_rotation_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (isQuota && this.auth && ctx.retryCount < 3) {
      try {
        const active = await this.auth.getActiveAccount();
        if (active) {
          this.auth.markCooldown(active.name, 30 * 60 * 1000);
          if (active.email) this.auth.markCooldown(active.email, 30 * 60 * 1000);
        }
        const rotated = await this.auth.rotateNextCandidate(active?.name);
        await ctx.sendMessage(
          ctx.request.locale === 'zh'
            ? `⚠️ 检测到当前账号配额超限或凭据失效，已标记进入 30 分钟冷却，自动切换到账号 \`${rotated.account.email || rotated.account.name}\` 并重试…`
            : `⚠️ Quota or auth issue detected. Marked account into 30m cooldown, switched to \`${rotated.account.email || rotated.account.name}\` and retrying…`,
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
