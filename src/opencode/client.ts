import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createOpencodeClient, type OpencodeClient, type Event, type Message, type Part, type Permission, type SessionStatus } from '@opencode-ai/sdk';
import type { Logger } from '../logger.js';

export interface OpencodeServerRuntimeStatus {
  pid: number | null;
  port: number | null;
  running: boolean;
  connected: boolean;
  url: string | null;
  statePath: string | null;
  startedAt: string | null;
}

interface OpencodeServerState {
  pid: number;
  port: number;
  url: string;
  command: string;
  logPath: string;
  bridgePid: number;
  startedAt: string;
}

export type OpencodeTextDeltaEvent = {
  sessionID: string;
  messageID: string;
  partID: string;
  text: string;
  delta?: string;
};

export type OpencodeToolProgressEvent = {
  sessionID: string;
  messageID: string;
  partID: string;
  callID: string;
  tool: string;
  status: string;
  title: string | null;
  error: string | null;
};

export type OpencodePermissionEvent = Permission;

export interface OpencodeEventMap {
  connected: [];
  disconnected: [meta: { source: string; message?: string }];
  textDelta: [event: OpencodeTextDeltaEvent];
  toolProgress: [event: OpencodeToolProgressEvent];
  permission: [event: OpencodePermissionEvent];
  sessionStatus: [event: { sessionID: string; status: SessionStatus }];
  sessionIdle: [event: { sessionID: string }];
  sessionError: [event: { sessionID: string; error: string }];
}

/**
 * Manages an `opencode serve` subprocess and wraps the official HTTP SDK with
 * a normalized SSE event stream (mirrors {@link CodexAppClient} for Codex).
 */
export class OpencodeAppClient extends EventEmitter {
  private readonly logger: Logger;
  private readonly statePath: string;
  private readonly logPath: string;
  private client: OpencodeClient | null = null;
  private child: ChildProcess | null = null;
  private serverPid: number | null = null;
  private port: number | null = null;
  private url: string | null = null;
  private connected = false;
  private startedAt: string | null = null;
  private sseAbort: AbortController | null = null;
  private sseLoop: Promise<void> | null = null;
  private readonly messageRoles = new Map<string, 'user' | 'assistant'>();

  constructor(
    private readonly opencodeCliBin: string,
    private readonly serverPassword: string | null,
    private readonly serverStatePath: string,
    private readonly serverLogPath: string,
    logger: Logger,
    private readonly childEnv: NodeJS.ProcessEnv | null = null,
    private readonly configContent: Record<string, unknown> | null = null,
  ) {
    super();
    this.logger = logger;
    this.statePath = serverStatePath;
    this.logPath = serverLogPath;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getClient(): OpencodeClient {
    if (!this.client) {
      throw new Error('Opencode client is not initialized');
    }
    return this.client;
  }

  getServerStatus(): OpencodeServerRuntimeStatus {
    return {
      pid: this.serverPid,
      port: this.port,
      running: this.serverPid !== null && this.serverPid > 0,
      connected: this.connected,
      url: this.url,
      statePath: this.statePath,
      startedAt: this.startedAt,
    };
  }

  async start(): Promise<void> {
    if (await this.attachPersistedServer()) {
      return;
    }
    await this.startServer();
  }

  async stop(options: { terminateServer?: boolean } = {}): Promise<void> {
    if (options.terminateServer && this.child?.pid) {
      const pid = this.child.pid;
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        this.child.kill('SIGTERM');
      }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && isProcessAlive(pid)) {
        await sleep(100);
      }
      if (isProcessAlive(pid)) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      this.clearServerStateForPid(pid);
    }
    this.sseAbort?.abort();
    if (this.sseLoop) {
      await Promise.race([
        this.sseLoop.catch(() => {}),
        sleep(2000),
      ]);
    }
    this.sseAbort = null;
    this.sseLoop = null;
    this.child = null;
    this.serverPid = null;
    this.port = null;
    this.url = null;
    this.client = null;
    this.connected = false;
  }

  async restart(): Promise<void> {
    await this.stop({ terminateServer: true });
    await this.start();
  }

  private async startServer(): Promise<void> {
    const port = await reservePort();
    this.port = port;
    const args = [`serve`, `--hostname=127.0.0.1`, `--port=${port}`];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.childEnv ?? {}),
    };
    if (this.configContent) {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(this.configContent);
    }
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    const [stdoutFd, stderrFd] = [fs.openSync(this.logPath, 'a'), fs.openSync(this.logPath, 'a')];
    let child: ChildProcess;
    try {
      child = spawn(this.opencodeCliBin, args, {
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env,
      });
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
    child.unref();
    this.child = child;
    if (!child.pid) {
      this.child = null;
      throw new Error('Failed to start opencode serve: child pid is unavailable');
    }
    this.serverPid = child.pid;
    this.writeServerState({
      pid: child.pid,
      port,
      url: `http://127.0.0.1:${port}`,
      command: [this.opencodeCliBin, ...args].join(' '),
      logPath: this.logPath,
      bridgePid: process.pid,
      startedAt: new Date().toISOString(),
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      if (child.pid) {
        this.clearServerStateForPid(child.pid);
      }
      this.handleDisconnect({ source: 'process-exit', message: `code=${code ?? 'null'} signal=${signal ?? 'null'}` });
    });
    child.on('error', (error) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      if (child.pid) {
        this.clearServerStateForPid(child.pid);
      }
      this.handleDisconnect({ source: 'process-error', message: error.message });
    });
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        reject(new Error(`opencode serve exited before SSE connection: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      });
    });
    await Promise.race([this.probeServer(port), spawnFailed]);
    this.connectSse();
  }

  private async probeServer(port: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/app`, this.fetchOptions());
        if (response.ok) {
          this.url = `http://127.0.0.1:${port}`;
          this.client = createOpencodeClient({
            baseUrl: this.url,
            ...(this.serverPassword ? { headers: this.authHeaders()! } : {}),
          });
          this.connected = true;
          this.startedAt = new Date().toISOString();
          this.emit('connected');
          return;
        }
        if (response.status === 401) {
          throw new Error('opencode serve rejected credentials (OPENCODE_SERVER_PASSWORD mismatch)');
        }
      } catch {
        // not up yet; retry
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for opencode serve on port ${port}`);
  }

  private authHeaders(): Record<string, string> | null {
    if (!this.serverPassword) {
      return null;
    }
    const token = Buffer.from(`opencode:${this.serverPassword}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  private fetchOptions(): RequestInit {
    const headers = this.authHeaders();
    return headers ? { headers } : {};
  }

  private async attachPersistedServer(): Promise<boolean> {
    const state = this.readServerState();
    if (!state) {
      return false;
    }
    if (!isProcessAlive(state.pid)) {
      this.clearServerState();
      return false;
    }
    this.port = state.port;
    this.url = state.url;
    this.serverPid = state.pid;
    try {
      const response = await fetch(`${state.url}/app`, this.fetchOptions());
      if (!response.ok) {
        throw new Error(`GET /app failed with ${response.status}`);
      }
      this.client = createOpencodeClient({
        baseUrl: state.url,
        ...(this.serverPassword ? { headers: this.authHeaders()! } : {}),
      });
      this.connected = true;
      this.startedAt = state.startedAt;
      this.logger.info('opencode.serve.attached', { pid: state.pid, port: state.port });
      this.emit('connected');
      this.connectSse();
      return true;
    } catch (error) {
      this.logger.warn('opencode.serve.attach_failed', {
        pid: state.pid,
        port: state.port,
        error: error instanceof Error ? error.message : String(error),
      });
      this.clearServerStateForPid(state.pid);
      return false;
    }
  }

  private connectSse(): void {
    const controller = new AbortController();
    this.sseAbort = controller;
    const loop = this.runSseLoop(controller);
    this.sseLoop = loop;
    loop.catch((error) => {
      if (controller.signal.aborted) {
        return;
      }
      this.logger.error('opencode.sse.loop_failed', { error: error instanceof Error ? error.message : String(error) });
      this.handleDisconnect({ source: 'sse-error', message: error instanceof Error ? error.message : String(error) });
    });
  }

  private async runSseLoop(controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        const subscribed = await this.getClient().event.subscribe({ signal: controller.signal });
        this.logger.info('opencode.sse.connected');
        for await (const event of subscribed.stream) {
          this.handleSseEvent(event);
        }
        if (controller.signal.aborted) {
          return;
        }
        this.logger.warn('opencode.sse.stream_closed, reconnecting');
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        this.logger.warn('opencode.sse.reconnect', { error: error instanceof Error ? error.message : String(error) });
        await sleep(1500);
      }
    }
  }

  private handleSseEvent(event: Event): void {
    switch (event.type) {
      case 'message.updated': {
        const info = event.properties.info as Message;
        this.messageRoles.set(info.id, info.role);
        break;
      }
      case 'message.part.updated': {
        const part = event.properties.part as Part;
        if (part.type === 'text' && this.messageRoles.get(part.messageID) !== 'user') {
          this.emit('textDelta', {
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            text: part.text,
            ...(event.properties.delta !== undefined ? { delta: event.properties.delta } : {}),
          });
        } else if (part.type === 'tool') {
          const status = part.state.status;
          this.emit('toolProgress', {
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            callID: part.callID,
            tool: part.tool,
            status,
            title: 'title' in part.state ? part.state.title : null,
            error: status === 'error' ? part.state.error : null,
          });
        }
        break;
      }
      case 'permission.updated': {
        this.emit('permission', event.properties);
        break;
      }
      case 'session.status': {
        this.emit('sessionStatus', {
          sessionID: event.properties.sessionID,
          status: event.properties.status,
        });
        break;
      }
      case 'session.idle': {
        this.emit('sessionIdle', { sessionID: event.properties.sessionID });
        break;
      }
      case 'session.error': {
        this.emit('sessionError', {
          sessionID: event.properties.sessionID,
          error: event.properties.error,
        });
        break;
      }
      default:
        break;
    }
  }

  private handleDisconnect(meta: { source: string; message?: string }): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.messageRoles.clear();
    this.emit('disconnected', meta);
  }

  private writeServerState(state: OpencodeServerState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.statePath);
  }

  private readServerState(): OpencodeServerState | null {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<OpencodeServerState>;
      if (
        typeof parsed.pid !== 'number' ||
        typeof parsed.port !== 'number' ||
        typeof parsed.url !== 'string' ||
        typeof parsed.startedAt !== 'string'
      ) {
        return null;
      }
      return parsed as OpencodeServerState;
    } catch {
      return null;
    }
  }

  private clearServerState(): void {
    try {
      fs.unlinkSync(this.statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('opencode.serve.state_clear_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private clearServerStateForPid(pid: number): void {
    const state = this.readServerState();
    if (!state || state.pid !== pid) {
      return;
    }
    this.clearServerState();
  }
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve TCP port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
