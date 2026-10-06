import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ClientApp, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type SessionConfigOption, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Logger } from '../logger.js';
import type { AccessPresetValue } from '../types.js';

export interface DshClientOptions {
  cliBin: string;
  sourceDir?: string | null;
  home?: string | null;
  profile: string;
  patches: string[];
  runtimeDir: string;
  startupTimeoutMs: number;
}

/** An owned ACP process; protocol stdout stays separate from diagnostics. */
export class DshClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private optionsBySession = new Map<string, SessionConfigOption[]>();
  private capabilities: { image: boolean; resume: boolean; list: boolean } = { image: false, resume: false, list: false };
  private policyPath = '';
  private policyWrite: Promise<void> = Promise.resolve();
  private stderr = '';
  permissionHandler?: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
  cancelPermissions?: () => void;

  constructor(readonly options: DshClientOptions, readonly scopeId: string, private readonly logger: Logger) { super(); }

  setAccess(preset: AccessPresetValue): Promise<void> {
    const write = this.policyWrite.then(() => this.writeAccess(preset));
    this.policyWrite = write.catch(() => {});
    return write;
  }

  private async writeAccess(preset: AccessPresetValue): Promise<void> {
    const folder = path.join(this.options.runtimeDir, createHash('sha256').update(this.scopeId).digest('hex'));
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    this.policyPath = path.join(folder, 'permissions');
    const temporary = `${this.policyPath}.tmp`;
    await fs.writeFile(temporary, preset === 'full-access' ? 'danger-full-access' : preset === 'read-only' ? 'read-only' : 'workspace-write', { mode: 0o600 });
    await fs.rename(temporary, this.policyPath);
  }

  start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.connection && !this.connection.signal.aborted) return Promise.resolve();
    this.starting ??= this.launch(signal).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async launch(signal?: AbortSignal): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.process) await this.stop();
    if (!this.policyPath) await this.setAccess('default');
    const patchPath = path.join(path.dirname(this.policyPath), 'bridge.patch.yml');
    let pluginPath = fileURLToPath(new URL('./permissions_plugin.js', import.meta.url));
    try { await fs.access(pluginPath); } catch { pluginPath = pluginPath.replace(/\.js$/, '.ts'); }
    await fs.writeFile(patchPath, `- insert:\n    - id: foxclaw-permissions\n      name: ${JSON.stringify(pathToFileURL(pluginPath).href)}\n      config:\n        policyPath: ${JSON.stringify(this.policyPath)}\n`, { mode: 0o600 });
    const args = ['--profile', this.options.profile, ...this.options.patches.flatMap(p => ['--patch', path.resolve(p)]), '--patch', patchPath];
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.options.home ? { DSH_HOME: this.options.home } : {}) };
    let command = this.options.cliBin;
    // DSH reads .env in its launch directory. The service directory belongs to
    // FoxClaw; session/new supplies the actual workspace independently.
    const cwd = path.dirname(this.policyPath);
    if (this.options.sourceDir) {
      const sourceDir = path.resolve(this.options.sourceDir);
      const tsx = createRequire(path.join(sourceDir, 'package.json')).resolve('tsx/esm');
      env.TSX_TSCONFIG_PATH = path.join(sourceDir, 'tsconfig.json');
      command = process.execPath;
      args.unshift('--import', pathToFileURL(tsx).href, path.join(sourceDir, 'apps/cli/src/bin.ts'));
    } else if (/\.[cm]?js$/.test(command)) {
      args.unshift(path.resolve(command));
      command = process.execPath;
    } else if (command.includes('/') || command.includes('\\')) {
      command = path.resolve(command);
    }
    signal?.throwIfAborted();
    const child = spawn(command, args, { cwd, env, stdio: 'pipe', windowsHide: true });
    this.process = child;
    this.stderr = '';
    this.optionsBySession.clear();
    const app = new ClientApp({ name: 'foxclaw' })
      .onNotification('session/update', ({ params }) => {
        if (params.update.sessionUpdate === 'config_option_update') this.optionsBySession.set(params.sessionId, params.update.configOptions);
        this.emit('update', params);
      })
      .onRequest('session/request_permission', ({ params, signal }) => this.permissionHandler?.(params, signal) ?? Promise.resolve({ outcome: { outcome: 'cancelled' } }));
    const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    this.connection = connection;
    child.stdin.on('error', error => connection.close(error));
    child.stderr.on('data', (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-4000); });
    child.once('error', error => connection.close(error));
    child.once('exit', (code, signal) => {
      connection.close(new Error(`DSH exited (${code ?? signal}): ${this.stderr}`));
      if (this.process === child) this.process = null;
      this.emit('disconnected');
    });
    const controller = new AbortController();
    const abortInitialization = (): void => connection.close(new Error('DSH startup cancelled'));
    signal?.addEventListener('abort', abortInitialization, { once: true });
    if (signal?.aborted) abortInitialization();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('DSH initialization timed out')); }, this.options.startupTimeoutMs);
    });
    try {
      const cancellationSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const initialized = await Promise.race([connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'foxclaw', version: '1' } }, { cancellationSignal }), timeout]);
      this.capabilities = { image: initialized.agentCapabilities?.promptCapabilities?.image === true, resume: initialized.agentCapabilities?.sessionCapabilities?.resume != null, list: initialized.agentCapabilities?.sessionCapabilities?.list != null };
    } catch (error) {
      await this.stop();
      throw new Error(`Cannot start DSH: ${error instanceof Error ? error.message : String(error)}${this.stderr ? `\n${this.stderr}` : ''}`);
    } finally {
      clearTimeout(timer!);
      signal?.removeEventListener('abort', abortInitialization);
    }
  }

  get connected(): boolean { return this.connection !== null && !this.connection.signal.aborted; }
  get imageSupported(): boolean { return this.capabilities.image; }
  get agent() {
    if (!this.connected) throw new Error('DSH is disconnected');
    return this.connection!.agent;
  }

  async session(cwd: string, sessionId?: string | null): Promise<string> {
    await this.start();
    if (sessionId && this.optionsBySession.has(sessionId)) return sessionId;
    if (sessionId) {
      if (!this.capabilities.resume) throw new Error('This DSH profile cannot resume sessions');
      const result = await this.agent.request('session/resume', { sessionId, cwd, mcpServers: [] });
      this.optionsBySession.set(sessionId, result.configOptions ?? []);
      return sessionId;
    }
    const result = await this.agent.request('session/new', { cwd, mcpServers: [] });
    this.optionsBySession.set(result.sessionId, result.configOptions ?? []);
    return result.sessionId;
  }

  configOptions(sessionId: string): SessionConfigOption[] { return this.optionsBySession.get(sessionId) ?? []; }

  async setConfig(sessionId: string, configId: string, value: string): Promise<void> {
    const result = await this.agent.request('session/set_config_option', { sessionId, configId, value });
    this.optionsBySession.set(sessionId, result.configOptions);
  }

  async listSessions(cursor?: string) {
    await this.start();
    if (!this.capabilities.list) throw new Error('This DSH profile cannot list sessions');
    return this.agent.request('session/list', cursor ? { cursor } : {});
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.agent.request('session/close', { sessionId });
    this.optionsBySession.delete(sessionId);
  }

  stop(): Promise<void> {
    this.stopping ??= this.dispose().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async dispose(): Promise<void> {
    this.cancelPermissions?.();
    const child = this.process;
    const connection = this.connection;
    this.connection = null;
    this.optionsBySession.clear();
    if (!child || !child.pid) { connection?.close(); return; }
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 6000); })]);
    clearTimeout(timer!);
    if (child.exitCode === null && child.signalCode === null) {
      this.logger.warn('dsh.force_stop', { scopeId: this.scopeId });
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(killTimer);
    }
    connection?.close();
    if (this.process === child) this.process = null;
  }
}

export type { SessionConfigOption, SessionNotification, RequestPermissionRequest, RequestPermissionResponse };
