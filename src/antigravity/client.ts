import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import type { Logger } from '../logger.js';
import {
  AntigravityEventNormalizer,
  type AgRawEvent,
  type AntigravityBridgeEvent,
} from './events.js';

export interface AntigravityTurnOptions {
  prompt: string;
  conversationId?: string | null;
  cwd?: string | null;
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
}

export interface AntigravityClientEvents {
  event: [event: AntigravityBridgeEvent];
  exit: [code: number | null, signal: NodeJS.Signals | null];
  error: [error: Error];
}

export interface AntigravityTurnExecution {
  conversationId: string | null;
  cancel(): void;
  waitForResult(): Promise<AntigravityBridgeEvent | null>;
  on<E extends keyof AntigravityClientEvents>(
    event: E,
    listener: (...args: AntigravityClientEvents[E]) => void,
  ): void;
}

export class AntigravityAppClient {
  private readonly cliBin: string;
  private readonly logger: Logger | undefined;
  private cachedModels: string[] | null = null;

  constructor(cliBin: string, logger?: Logger) {
    this.cliBin = cliBin;
    this.logger = logger;
  }

  async listModels(): Promise<string[]> {
    if (this.cachedModels && this.cachedModels.length > 0) {
      return this.cachedModels;
    }

    try {
      const child = spawn(this.cliBin, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d: Buffer) => {
        output += d.toString('utf8');
      });

      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`agy models exited with code ${code}`));
        });
        child.on('error', reject);
      });

      const lines = output.split('\n');
      const models: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('⠋') || trimmed.startsWith('Fetching')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts[0]) {
          models.push(parts[0]);
        }
      }

      if (models.length > 0) {
        this.cachedModels = models;
        return models;
      }
    } catch (err) {
      this.logger?.warn('antigravity.list_models_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Fallback to standard known models
    return [
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.7-flash-high',
      'gemini-3.1-pro-high',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
    ];
  }

  executeTurn(options: AntigravityTurnOptions): AntigravityTurnExecution {
    const emitter = new EventEmitter();
    const normalizer = new AntigravityEventNormalizer();

    const args = [
      '-p',
      '',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
    ];

    if (options.conversationId) {
      args.push('--conversation', options.conversationId);
    }
    const modelToUse = (!options.model || options.model === 'default') ? 'gemini-3.8-flash-high' : options.model;
    args.push('--model', modelToUse);
    if (options.effort) {
      args.push('--effort', options.effort);
    }
    if (options.mode) {
      args.push('--mode', options.mode);
    }

    const workingDir = options.cwd || process.cwd();

    this.logger?.info('antigravity.turn.starting', {
      cwd: workingDir,
      conversationId: options.conversationId ?? null,
      model: modelToUse,
    });

    let child: ChildProcess | null = spawn(this.cliBin, args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let activeConversationId: string | null = options.conversationId ?? null;
    let finalResultEvent: AntigravityBridgeEvent | null = null;

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create stdio pipes for Antigravity CLI process');
    }

    // Feed user prompt via stdin
    const inputMsg = JSON.stringify({
      event: 'user',
      message: {
        content: options.prompt,
      },
    });

    child.stdin.write(inputMsg + '\n');
    child.stdin.end();

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return;
      try {
        const parsed = JSON.parse(trimmed) as AgRawEvent;
        if (parsed.event === 'init') {
          activeConversationId = parsed.conversation_id;
        }
        const bridgeEvents = normalizer.accept(parsed);
        for (const ev of bridgeEvents) {
          if (ev.kind === 'result') {
            finalResultEvent = ev;
          }
          emitter.emit('event', ev);
        }
      } catch (e) {
        this.logger?.debug('antigravity.ndjson_parse_error', { line, error: String(e) });
      }
    });

    let stderrBuffer = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderrBuffer += data.toString('utf8');
    });

    child.on('error', (err) => {
      this.logger?.error('antigravity.process.error', { error: err.message });
      emitter.emit('error', err);
    });

    child.on('close', (code, signal) => {
      this.logger?.info('antigravity.process.exit', {
        code,
        signal,
        conversationId: activeConversationId,
        stderr: stderrBuffer ? stderrBuffer.slice(-200) : undefined,
      });
      if (!finalResultEvent && code !== 0) {
        const errorMsg = stderrBuffer.trim() || `Process exited with code ${code}${signal ? ` (${signal})` : ''}`;
        const errResult: AntigravityBridgeEvent = {
          kind: 'result',
          conversationId: activeConversationId || '',
          status: 'ERROR',
          response: errorMsg,
          error: errorMsg,
          durationSeconds: 0,
        };
        finalResultEvent = errResult;
        emitter.emit('event', errResult);
      }
      emitter.emit('exit', code, signal);
      child = null;
    });

    const execution: AntigravityTurnExecution = {
      get conversationId() {
        return activeConversationId;
      },
      cancel() {
        if (child && !child.killed) {
          child.kill('SIGINT');
          setTimeout(() => {
            if (child && !child.killed) {
              child.kill('SIGKILL');
            }
          }, 2000).unref();
        }
      },
      waitForResult(): Promise<AntigravityBridgeEvent | null> {
        return new Promise((resolve) => {
          if (finalResultEvent) {
            resolve(finalResultEvent);
            return;
          }
          emitter.on('event', (ev) => {
            if (ev.kind === 'result') {
              resolve(ev);
            }
          });
          emitter.on('exit', () => {
            resolve(finalResultEvent);
          });
        });
      },
      on(event, listener) {
        emitter.on(event, listener as (...args: unknown[]) => void);
      },
    };

    return execution;
  }
}
