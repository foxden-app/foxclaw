import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createOpencodeClient,
  type Event,
  type GlobalEvent,
  type OpencodeClient,
  type PermissionRequest,
  type QuestionRequest,
  type SessionStatus,
} from '@opencode-ai/sdk/v2';
import type { Logger } from '../logger.js';
import { OpencodeEventNormalizer, type OpencodeBridgeEvent } from './events.js';

const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

interface OpencodeServerState {
  pid: number;
  port: number;
  url: string;
  username: string;
  password: string;
  command: string;
  logPath: string;
  startedAt: string;
  version: string | null;
}

export interface OpencodeServerRuntimeStatus {
  pid: number | null;
  port: number | null;
  running: boolean;
  connected: boolean;
  url: string | null;
  version: string | null;
  managed: boolean;
}

export interface OpencodeAppClientEvents {
  event: [event: OpencodeBridgeEvent];
  connected: [];
  disconnected: [detail: { source: string; message?: string }];
}

/** Owns one password-protected localhost `opencode serve` process. */
export class OpencodeAppClient extends EventEmitter<OpencodeAppClientEvents> {
  private readonly normalizer = new OpencodeEventNormalizer();
  private client: OpencodeClient | null = null;
  private child: ChildProcess | null = null;
  private serverState: OpencodeServerState | null = null;
  private connected = false;
  private sseAbort: AbortController | null = null;
  private sseLoop: Promise<void> | null = null;
  private readonly pollers = new Map<string, AbortController>();
  private desiredRunning = false;
  private starting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cliBin: string,
    private readonly configuredPassword: string | null,
    private readonly statePath: string,
    private readonly logPath: string,
    private readonly logger: Logger,
    private readonly childEnv: NodeJS.ProcessEnv | null = null,
  ) {
    super();
  }

  getClient(): OpencodeClient {
    if (!this.client) throw new Error('OpenCode client is not connected');
    return this.client;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getServerStatus(): OpencodeServerRuntimeStatus {
    return {
      pid: this.serverState?.pid ?? null,
      port: this.serverState?.port ?? null,
      running: Boolean(this.serverState && isProcessAlive(this.serverState.pid)),
      connected: this.connected,
      url: this.serverState?.url ?? null,
      version: this.serverState?.version ?? null,
      managed: this.serverState !== null,
    };
  }

  async start(): Promise<void> {
    this.desiredRunning = true;
    if (this.connected) return;
    if (!this.starting) {
      this.starting = (async () => {
        if (await this.attachPersistedServer()) return;
        await this.spawnServer();
      })().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  async stop(options: { terminateServer?: boolean } = {}): Promise<void> {
    this.desiredRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    for (const controller of this.pollers.values()) controller.abort();
    this.pollers.clear();
    this.sseAbort?.abort();
    if (this.sseLoop) {
      await Promise.race([this.sseLoop.catch(() => {}), sleep(2_000)]);
    }
    this.sseAbort = null;
    this.sseLoop = null;

    const state = this.serverState;
    if (options.terminateServer && state && isProcessAlive(state.pid)) {
      await terminateProcessGroup(state.pid);
      this.clearStateForPid(state.pid);
    }
    this.child = null;
    this.client = null;
    this.serverState = null;
    this.connected = false;
    this.normalizer.reset();
  }

  async restart(): Promise<void> {
    await this.stop({ terminateServer: true });
    await this.start();
  }

  watchSessionUntilIdle(sessionId: string, directory: string): void {
    this.pollers.get(sessionId)?.abort();
    const controller = new AbortController();
    this.pollers.set(sessionId, controller);
    void this.pollSession(sessionId, directory, controller).finally(() => {
      if (this.pollers.get(sessionId) === controller) this.pollers.delete(sessionId);
    });
  }

  async recoverPendingRequests(directories: readonly string[]): Promise<void> {
    const unique = [...new Set(directories.filter(Boolean))];
    await Promise.all(unique.map((directory) => this.recoverPendingForDirectory(directory)));
  }

  private async pollSession(sessionId: string, directory: string, controller: AbortController): Promise<void> {
    let observedBusy = false;
    while (!controller.signal.aborted && this.connected) {
      try {
        const response = await this.getClient().session.status({ directory });
        if (response.error) throw new Error(formatSdkError(response.error));
        const status = response.data?.[sessionId] as SessionStatus | undefined;
        if (status?.type === 'busy' || status?.type === 'retry') observedBusy = true;
        if (status?.type === 'idle' || (observedBusy && status === undefined)) {
          this.emit('event', { kind: 'idle', sessionId });
          return;
        }
      } catch (error) {
        this.logger.warn('opencode.session.poll_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(POLL_INTERVAL_MS, controller.signal);
    }
  }

  private async attachPersistedServer(): Promise<boolean> {
    const state = this.readState();
    if (!state) return false;
    if (!isProcessAlive(state.pid)) {
      this.clearStateForPid(state.pid);
      return false;
    }
    try {
      const health = await probeHealth(state.url, state.username, state.password);
      await this.adoptServer({ ...state, version: health.version ?? state.version });
      this.logger.info('opencode.serve.attached', { pid: state.pid, port: state.port, version: health.version });
      return true;
    } catch (error) {
      throw new Error(
        `A managed opencode serve process (${state.pid}) is still running but cannot be attached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async spawnServer(): Promise<void> {
    const port = await reservePort();
    const username = 'opencode';
    const password = this.configuredPassword || crypto.randomBytes(32).toString('base64url');
    const url = `http://127.0.0.1:${port}`;
    const args = ['serve', '--hostname=127.0.0.1', `--port=${port}`, '--print-logs'];
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
    const stdoutFd = fs.openSync(this.logPath, 'a', 0o600);
    const stderrFd = fs.openSync(this.logPath, 'a', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(this.cliBin, args, {
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: {
          ...process.env,
          ...(this.childEnv ?? {}),
          OPENCODE_SERVER_USERNAME: username,
          OPENCODE_SERVER_PASSWORD: password,
        },
      });
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
    try {
      await waitForSpawn(child);
    } catch (error) {
      throw new Error(`Failed to start opencode serve: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!child.pid) throw new Error('Failed to start opencode serve: child PID is unavailable');
    child.unref();
    this.child = child;
    const state: OpencodeServerState = {
      pid: child.pid,
      port,
      url,
      username,
      password,
      command: [this.cliBin, ...args].join(' '),
      logPath: this.logPath,
      startedAt: new Date().toISOString(),
      version: null,
    };
    this.writeState(state);
    this.serverState = state;

    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearStateForPid(child.pid!);
      this.handleDisconnect({ source: 'process-exit', message: `code=${code ?? 'null'} signal=${signal ?? 'null'}` });
    });
    child.once('error', (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearStateForPid(child.pid!);
      this.handleDisconnect({ source: 'process-error', message: error.message });
    });

    try {
      const health = await waitForHealth(url, username, password, child);
      this.logger.debug('opencode.serve.ready', { pid: child.pid, port, version: health.version });
      await this.adoptServer({ ...state, version: health.version ?? null });
      this.writeState(this.serverState!);
      this.logger.info('opencode.serve.started', { pid: child.pid, port, version: health.version });
    } catch (error) {
      await terminateProcessGroup(child.pid);
      this.clearStateForPid(child.pid);
      throw error;
    }
  }

  private async adoptServer(state: OpencodeServerState): Promise<void> {
    this.logger.debug('opencode.serve.adopting', { pid: state.pid, port: state.port });
    this.serverState = state;
    this.client = createOpencodeClient({
      baseUrl: state.url,
      headers: authHeaders(state.username, state.password),
    });
    this.connected = true;
    this.emit('connected');
    this.startSseLoop();
    this.logger.debug('opencode.serve.adopted', { pid: state.pid, port: state.port });
  }

  private startSseLoop(): void {
    const controller = new AbortController();
    this.sseAbort = controller;
    this.sseLoop = this.runSseLoop(controller).catch((error) => {
      if (controller.signal.aborted) return;
      this.logger.error('opencode.sse.failed', { error: error instanceof Error ? error.message : String(error) });
      this.handleDisconnect({ source: 'sse', message: error instanceof Error ? error.message : String(error) });
    });
  }

  private async runSseLoop(controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        const subscribed = await this.getClient().global.event({ signal: controller.signal });
        this.logger.info('opencode.sse.connected');
        for await (const globalEvent of subscribed.stream) {
          const event = unwrapGlobalEvent(globalEvent);
          if (event) this.acceptEvent(event);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const state = this.serverState;
        if (state && !isProcessAlive(state.pid)) {
          this.clearStateForPid(state.pid);
          this.handleDisconnect({ source: 'sse-process-exit', message: error instanceof Error ? error.message : String(error) });
          return;
        }
        this.logger.warn('opencode.sse.reconnect', { error: error instanceof Error ? error.message : String(error) });
      }
      if (!controller.signal.aborted) await sleep(1_000, controller.signal);
    }
  }

  private acceptEvent(event: Event): void {
    for (const normalized of this.normalizer.accept(event)) {
      if (normalized.kind === 'idle') this.pollers.get(normalized.sessionId)?.abort();
      this.emit('event', normalized);
    }
  }

  private async recoverPendingForDirectory(directory?: string): Promise<void> {
    if (!this.client) return;
    this.logger.debug('opencode.pending.recover_start', { directory: directory ?? null });
    const [permissions, questions] = await Promise.all([
      this.client.permission.list({ ...(directory ? { directory } : {}) }),
      this.client.question.list({ ...(directory ? { directory } : {}) }),
    ]);
    if (!permissions.error) {
      for (const request of permissions.data ?? []) {
        this.emit('event', { kind: 'permission', request: request as PermissionRequest });
      }
    }
    if (!questions.error) {
      for (const request of questions.data ?? []) {
        this.emit('event', { kind: 'question', request: request as QuestionRequest });
      }
    }
    this.logger.debug('opencode.pending.recover_done', { directory: directory ?? null });
  }

  private handleDisconnect(detail: { source: string; message?: string }): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.sseAbort?.abort();
    this.client = null;
    this.normalizer.reset();
    if (wasConnected) {
      this.emit('disconnected', detail);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.desiredRunning || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.desiredRunning || this.connected) return;
      void this.start().catch((error) => {
        this.logger.error('opencode.serve.reconnect_failed', { error: error instanceof Error ? error.message : String(error) });
        this.scheduleReconnect();
      });
    }, 1_000);
  }

  private writeState(state: OpencodeServerState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
  }

  private readState(): OpencodeServerState | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<OpencodeServerState>;
      if (
        !Number.isInteger(value.pid) || !Number.isInteger(value.port)
        || typeof value.url !== 'string' || value.url !== `http://127.0.0.1:${value.port}`
        || typeof value.username !== 'string' || typeof value.password !== 'string'
        || typeof value.startedAt !== 'string'
      ) return null;
      return value as OpencodeServerState;
    } catch {
      return null;
    }
  }

  private clearStateForPid(pid: number): void {
    const current = this.readState();
    if (current && current.pid !== pid) return;
    try {
      fs.unlinkSync(this.statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('opencode.serve.state_clear_failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

function unwrapGlobalEvent(value: GlobalEvent): Event | null {
  const payload = value.payload as { type?: unknown; properties?: unknown };
  return typeof payload.type === 'string' && payload.properties && typeof payload.properties === 'object'
    ? payload as Event
    : null;
}

async function waitForHealth(
  url: string,
  username: string,
  password: string,
  child: ChildProcess,
): Promise<{ healthy: boolean; version?: string }> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`opencode serve exited before becoming ready (code=${child.exitCode ?? 'null'}, signal=${child.signalCode ?? 'null'})`);
    }
    try {
      return await probeHealth(url, username, password);
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Timed out waiting for opencode serve at ${url}`);
}

async function probeHealth(url: string, username: string, password: string): Promise<{ healthy: boolean; version?: string }> {
  const response = await fetch(`${url}/global/health`, {
    headers: authHeaders(username, password),
    signal: AbortSignal.timeout(1_000),
  });
  if (response.status === 401) throw new Error('OpenCode server rejected its stored credentials');
  if (!response.ok) throw new Error(`OpenCode health check returned HTTP ${response.status}`);
  const value = await response.json() as { healthy?: unknown; version?: unknown };
  if (value.healthy !== true) throw new Error('OpenCode health check did not report healthy=true');
  return { healthy: true, ...(typeof value.version === 'string' ? { version: value.version } : {}) };
}

function authHeaders(username: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve a local TCP port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function terminateProcessGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isProcessAlive(pid)) await sleep(100);
  if (!isProcessAlive(pid)) return;
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function formatSdkError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const value = error as { data?: { message?: unknown }; message?: unknown; _tag?: unknown; name?: unknown };
    if (typeof value.data?.message === 'string') return value.data.message;
    if (typeof value.message === 'string') return value.message;
    if (typeof value._tag === 'string') return value._tag;
    if (typeof value.name === 'string') return value.name;
  }
  return String(error);
}
