import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DshClient, type DshClientOptions } from './client.js';
import type { Logger } from '../logger.js';

export interface DshCredentialInfo { configured: boolean; writable: boolean; }

/** Owns ephemeral native credential control processes; no model/session requests. */
export class DshCredentials {
  private readonly jobs = new Set<{ controller: AbortController; done: Promise<DshCredentialInfo> }>();
  private stopped = false;
  constructor(private readonly options: DshClientOptions, private readonly logger: Logger) {}
  get pendingOperations(): number { return this.jobs.size; }
  describe(): Promise<DshCredentialInfo> { return this.run('describe'); }
  set(value: string): Promise<DshCredentialInfo> { return this.run('set', value); }
  private run(operation: string, value?: string): Promise<DshCredentialInfo> {
    if (this.stopped) return Promise.reject(new Error('DSH credentials stopped'));
    const controller = new AbortController();
    const done = this.execute(operation, value, controller.signal);
    const job = { controller, done };
    this.jobs.add(job);
    void done.finally(() => this.jobs.delete(job)).catch(() => {});
    return done;
  }
  private async execute(operation: string, value: string | undefined, signal: AbortSignal): Promise<DshCredentialInfo> {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-dsh-credential-'));
    const control = { requestPath: path.join(runtimeDir, 'request.json'), resultPath: path.join(runtimeDir, 'result.json') };
    const client = new DshClient({ ...this.options, runtimeDir, credentialControl: control }, 'credentials', this.logger);
    try {
      signal.throwIfAborted();
      await fs.writeFile(control.requestPath, JSON.stringify({ operation, value }), { mode: 0o600, flag: 'wx' });
      await client.setAccess('read-only');
      await client.start(signal);
      signal.throwIfAborted();
      const deadline = Date.now() + this.options.startupTimeoutMs;
      let text: string;
      for (;;) {
        signal.throwIfAborted();
        try { text = await fs.readFile(control.resultPath, 'utf8'); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error;
          await delay(25, undefined, { signal });
        }
      }
      const result = JSON.parse(text) as { ok: boolean; info?: DshCredentialInfo; error?: string };
      if (!result.ok || !result.info) throw new Error(result.error || 'DSH credential operation unavailable');
      return result.info;
    } catch {
      throw new Error('DSH 凭据操作未完成，请检查本机凭据配置、权限及环境覆盖后重试。 / DSH credential operation failed; check configuration, permissions and environment overrides.');
    } finally { await client.stop(); await fs.rm(runtimeDir, { recursive: true, force: true }); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const job of this.jobs) job.controller.abort();
    await Promise.allSettled([...this.jobs].map(job => job.done));
  }
}
