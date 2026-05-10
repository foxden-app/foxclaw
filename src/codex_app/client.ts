import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../logger.js';
import type {
  AppThread,
  AppThreadSnapshot,
  AppTurnSnapshot,
  CodexAccountInfo,
  CodexAccountRateLimits,
  CodexAppInfo,
  CodexCollaborationMode,
  CodexCollaborationModePreset,
  CodexConfigRequirements,
  CodexCreditsSnapshot,
  CodexEffectiveConfig,
  CodexExperimentalFeature,
  CodexFuzzyFileResult,
  CodexHookMetadata,
  CodexHooksListEntry,
  CodexLoginDeviceCode,
  CodexMcpResourceContent,
  CodexMcpServerStatus,
  CodexModelProviderCapabilities,
  CodexPluginDetail,
  CodexPluginMarketplace,
  CodexPluginSkillSummary,
  CodexPluginSummary,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexSkillsListEntry,
  CodexThreadGoal,
  ModelInfo,
  ReasoningEffortValue,
  ReviewTarget,
  SandboxModeValue,
  ThreadSessionState,
  ThreadGoalStatusValue,
  ThreadStatusKind,
} from '../types.js';
import { buildThreadDeepLink, openUrl } from './deeplink.js';

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: any;
}

export interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params?: any;
}

interface ListThreadsOptions {
  limit: number;
  searchTerm?: string | null;
  archived?: boolean;
}

interface StartThreadOptions {
  cwd: string | null;
  approvalPolicy: string;
  sandboxMode: SandboxModeValue;
  model: string | null;
}

interface ResumeThreadOptions {
  threadId: string;
}

export interface TextTurnInput {
  type: 'text';
  text: string;
  text_elements: [];
}

export interface LocalImageTurnInput {
  type: 'localImage';
  path: string;
}

export type TurnInput = TextTurnInput | LocalImageTurnInput;

interface StartTurnOptions {
  threadId: string;
  input: TurnInput[];
  approvalPolicy: string;
  sandboxMode: SandboxModeValue;
  cwd: string | null;
  model: string | null;
  effort: ReasoningEffortValue | null;
  serviceTier?: string | null | undefined;
  collaborationMode: CodexCollaborationMode | null;
}

interface CodexAppServerState {
  pid: number;
  port: number;
  command: string;
  logPath: string;
  bridgePid: number;
  startedAt: string;
}

interface CodexAppServerRuntimeStatus {
  pid: number | null;
  port: number | null;
  running: boolean;
  managed: boolean;
}

interface StopOptions {
  terminateServer?: boolean;
}

export class CodexAppClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private desiredRunning = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private port: number | null = null;
  private connected = false;
  private userAgent: string | null = null;

  constructor(
    private readonly codexCliBin: string,
    private readonly launchCommand: string,
    private readonly autolaunch: boolean,
    private readonly serverStatePath: string,
    private readonly serverLogPath: string,
    private readonly logger: Logger,
  ) {
    super();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getUserAgent(): string | null {
    return this.userAgent;
  }

  getServerStatus(): CodexAppServerRuntimeStatus {
    const state = this.readServerState();
    const pid = this.child?.pid ?? state?.pid ?? null;
    const port = this.port ?? state?.port ?? null;
    return {
      pid,
      port,
      running: pid !== null && isProcessAlive(pid),
      managed: state !== null,
    };
  }

  async start(): Promise<void> {
    this.desiredRunning = true;
    if (this.connected) return;
    if (!this.starting) {
      this.starting = this.startServer().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  async stop(options: StopOptions = {}): Promise<void> {
    this.desiredRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    socket?.close();
    if (options.terminateServer ?? true) {
      await this.terminateServer();
    } else {
      this.child = null;
    }
    this.rejectPending(new Error('Codex app bridge stopped'));
  }

  async restart(): Promise<void> {
    await this.stop({ terminateServer: true });
    await this.start();
  }

  async listThreads(options: ListThreadsOptions): Promise<AppThread[]> {
    const result = await this.request('thread/list', {
      limit: options.limit,
      sortKey: 'updated_at',
      searchTerm: options.searchTerm ?? null,
      archived: options.archived ?? false,
    });
    const rows = Array.isArray((result as any).data) ? (result as any).data : [];
    return rows.map(mapThread);
  }

  async listLoadedThreads(): Promise<string[]> {
    const threadIds: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request('thread/loaded/list', { cursor, limit: 100 });
      const rows = Array.isArray((result as any)?.data) ? (result as any).data : [];
      threadIds.push(...rows.filter((value: unknown): value is string => typeof value === 'string'));
      cursor = typeof (result as any)?.nextCursor === 'string' ? (result as any).nextCursor : null;
    } while (cursor);
    return threadIds;
  }

  async readThread(threadId: string, includeTurns = false): Promise<AppThread | null> {
    const result = await this.request('thread/read', { threadId, includeTurns });
    const thread = (result as any).thread;
    return thread ? mapThread(thread) : null;
  }

  async readThreadSnapshot(threadId: string): Promise<AppThreadSnapshot | null> {
    const result = await this.request('thread/read', { threadId, includeTurns: true });
    const thread = (result as any).thread;
    return thread ? mapThreadSnapshot(thread) : null;
  }

  async startThread(options: StartThreadOptions): Promise<ThreadSessionState> {
    const result = await this.request('thread/start', {
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      model: options.model,
      modelProvider: null,
      sandbox: options.sandboxMode,
      config: null,
      serviceName: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral: null,
      experimentalRawEvents: true,
      persistExtendedHistory: false,
    });
    return mapThreadSessionState(result);
  }

  async resumeThread(options: ResumeThreadOptions): Promise<ThreadSessionState> {
    const result = await this.request('thread/resume', {
      threadId: options.threadId,
      cwd: null,
      approvalPolicy: null,
      baseInstructions: null,
      developerInstructions: null,
      config: null,
      sandbox: null,
      model: null,
      modelProvider: null,
      personality: null,
      experimentalRawEvents: true,
      persistExtendedHistory: false,
    });
    return mapThreadSessionState(result);
  }

  async startTurn(options: StartTurnOptions): Promise<{ id: string; status: string }> {
    const params: Record<string, unknown> = {
      threadId: options.threadId,
      input: options.input,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandboxPolicy: mapSandboxPolicy(options.sandboxMode),
      model: options.model,
      effort: options.effort,
      summary: null,
      personality: null,
      outputSchema: null,
    };
    if (options.serviceTier !== undefined) {
      params.serviceTier = options.serviceTier;
    }
    if (options.collaborationMode) {
      params.collaborationMode = options.collaborationMode;
    }
    const result = await this.request('turn/start', params);
    return (result as any).turn;
  }

  async steerTurn(threadId: string, expectedTurnId: string, input: TurnInput[]): Promise<{ turnId: string }> {
    const result = await this.request('turn/steer', { threadId, expectedTurnId, input });
    return { turnId: String((result as any)?.turnId ?? expectedTurnId) };
  }

  async forkThread(options: {
    threadId: string;
    cwd: string | null;
    approvalPolicy: string;
    sandboxMode: SandboxModeValue;
    model: string | null;
    serviceTier?: string | null;
  }): Promise<ThreadSessionState> {
    const params: Record<string, unknown> = {
      threadId: options.threadId,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandboxMode,
      model: options.model,
      modelProvider: null,
      threadSource: null,
      ephemeral: false,
    };
    if (options.serviceTier !== undefined) {
      params.serviceTier = options.serviceTier;
    }
    const result = await this.request('thread/fork', params);
    return mapThreadSessionState(result);
  }

  async rollbackThread(threadId: string, numTurns: number): Promise<AppThreadSnapshot | null> {
    const result = await this.request('thread/rollback', { threadId, numTurns });
    const thread = (result as any)?.thread;
    return thread ? mapThreadSnapshot(thread) : null;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.request('thread/name/set', { threadId, name });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.request('thread/compact/start', { threadId });
  }

  async getThreadGoal(threadId: string): Promise<CodexThreadGoal | null> {
    const result = await this.request('thread/goal/get', { threadId });
    return mapThreadGoal((result as any)?.goal);
  }

  async setThreadGoal(options: {
    threadId: string;
    objective?: string | null;
    status?: ThreadGoalStatusValue | null;
    tokenBudget?: number | null | undefined;
  }): Promise<CodexThreadGoal> {
    const params: Record<string, unknown> = { threadId: options.threadId };
    if (options.objective !== undefined) {
      params.objective = options.objective;
    }
    if (options.status !== undefined) {
      params.status = options.status;
    }
    if (options.tokenBudget !== undefined) {
      params.tokenBudget = options.tokenBudget;
    }
    const result = await this.request('thread/goal/set', params);
    const goal = mapThreadGoal((result as any)?.goal);
    if (!goal) {
      throw new Error('thread/goal/set returned no goal');
    }
    return goal;
  }

  async clearThreadGoal(threadId: string): Promise<boolean> {
    const result = await this.request('thread/goal/clear', { threadId });
    return Boolean((result as any)?.cleared);
  }

  async listThreadTurns(threadId: string, limit = 10): Promise<AppTurnSnapshot[]> {
    const result = await this.request('thread/turns/list', {
      threadId,
      cursor: null,
      limit,
      sortDirection: 'desc',
      itemsView: 'summary',
    });
    const turns = Array.isArray((result as any)?.data) ? (result as any).data : [];
    return turns.map(mapTurnSnapshot);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request('thread/archive', { threadId });
  }

  async unarchiveThread(threadId: string): Promise<AppThread | null> {
    const result = await this.request('thread/unarchive', { threadId });
    const thread = (result as any)?.thread;
    return thread ? mapThread(thread) : null;
  }

  async startReview(threadId: string, target: ReviewTarget, delivery: 'inline' | 'detached' = 'inline'): Promise<{ turnId: string; reviewThreadId: string }> {
    const result = await this.request('review/start', { threadId, target, delivery });
    return {
      turnId: String((result as any)?.turn?.id ?? ''),
      reviewThreadId: String((result as any)?.reviewThreadId ?? threadId),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request('model/list', { cursor, limit: 100, includeHidden: false });
      const rows = Array.isArray((result as any).data) ? (result as any).data : [];
      models.push(...rows.map(mapModel));
      cursor = typeof (result as any).nextCursor === 'string' ? (result as any).nextCursor : null;
    } while (cursor);
    return models;
  }

  async readAccount(): Promise<CodexAccountInfo | null> {
    const result = await this.request('account/read', { refreshToken: false });
    const account = (result as any)?.account;
    if (!account || typeof account !== 'object') {
      return null;
    }
    return {
      type: typeof account.type === 'string' ? account.type : 'unknown',
      email: typeof account.email === 'string' ? account.email : null,
      planType: typeof account.planType === 'string' ? account.planType : null,
      requiresOpenaiAuth: Boolean((result as any)?.requiresOpenaiAuth),
    };
  }

  async startDeviceLogin(): Promise<CodexLoginDeviceCode> {
    const result = await this.request('account/login/start', { type: 'chatgptDeviceCode' });
    if ((result as any)?.type !== 'chatgptDeviceCode') {
      throw new Error(`Unexpected login response: ${JSON.stringify(result)}`);
    }
    return {
      type: 'chatgptDeviceCode',
      loginId: String((result as any).loginId),
      verificationUrl: String((result as any).verificationUrl),
      userCode: String((result as any).userCode),
    };
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.request('account/login/cancel', { loginId });
  }

  async logoutAccount(): Promise<void> {
    await this.request('account/logout', undefined);
  }

  async sendAddCreditsNudgeEmail(creditType: 'credits' | 'usage_limit'): Promise<void> {
    await this.request('account/sendAddCreditsNudgeEmail', { creditType });
  }

  async readAccountRateLimits(): Promise<CodexAccountRateLimits | null> {
    const result = await this.request('account/rateLimits/read', undefined);
    if (!result || typeof result !== 'object') {
      return null;
    }
    return {
      rateLimits: mapRateLimitSnapshot((result as any).rateLimits),
      rateLimitsByLimitId: mapRateLimitsByLimitId((result as any).rateLimitsByLimitId),
    };
  }

  async readEffectiveConfig(cwd: string | null): Promise<CodexEffectiveConfig> {
    const result = await this.request('config/read', {
      includeLayers: false,
      cwd,
    });
    const config = (result as any)?.config ?? {};
    return {
      model: typeof config.model === 'string' ? config.model : null,
      modelReasoningEffort: normalizeReasoningEffort(config.model_reasoning_effort),
      planModeReasoningEffort: normalizeReasoningEffort(config.plan_mode_reasoning_effort),
      developerInstructions: typeof config.developer_instructions === 'string' && config.developer_instructions.trim()
        ? config.developer_instructions
        : null,
    };
  }

  async listCollaborationModes(): Promise<CodexCollaborationModePreset[]> {
    const result = await this.request('collaborationMode/list', {});
    const rows = Array.isArray((result as any)?.data) ? (result as any).data : [];
    return rows.map(mapCollaborationModePreset);
  }

  async listSkills(cwd: string | null, forceReload = false): Promise<CodexSkillsListEntry[]> {
    const result = await this.request('skills/list', {
      cwds: cwd ? [cwd] : [],
      forceReload,
    });
    const rows = Array.isArray((result as any)?.data) ? (result as any).data : [];
    return rows.map(mapSkillsListEntry);
  }

  async writeSkillConfig(selector: { name?: string | null; path?: string | null }, enabled: boolean): Promise<void> {
    await this.request('skills/config/write', {
      name: selector.name ?? null,
      path: selector.path ?? null,
      enabled,
    });
  }

  async listHooks(cwd: string | null): Promise<CodexHooksListEntry[]> {
    const result = await this.request('hooks/list', { cwds: cwd ? [cwd] : [] });
    const rows = Array.isArray((result as any)?.data) ? (result as any).data : [];
    return rows.map(mapHooksListEntry);
  }

  async listPlugins(cwd: string | null): Promise<CodexPluginMarketplace[]> {
    const result = await this.request('plugin/list', {
      cwds: cwd ? [cwd] : null,
      marketplaceKinds: null,
    });
    const rows = Array.isArray((result as any)?.marketplaces) ? (result as any).marketplaces : [];
    return rows.map(mapPluginMarketplace);
  }

  async readPlugin(pluginName: string, options: { marketplacePath?: string | null; remoteMarketplaceName?: string | null } = {}): Promise<CodexPluginDetail | null> {
    const result = await this.request('plugin/read', {
      pluginName,
      marketplacePath: options.marketplacePath ?? null,
      remoteMarketplaceName: options.remoteMarketplaceName ?? null,
    });
    const plugin = (result as any)?.plugin;
    return plugin && typeof plugin === 'object' ? mapPluginDetail(plugin) : null;
  }

  async readPluginSkill(remoteMarketplaceName: string, remotePluginId: string, skillName: string): Promise<string | null> {
    const result = await this.request('plugin/skill/read', { remoteMarketplaceName, remotePluginId, skillName });
    return typeof (result as any)?.contents === 'string' ? (result as any).contents : null;
  }

  async listApps(threadId?: string | null, forceRefetch = false): Promise<CodexAppInfo[]> {
    const apps: CodexAppInfo[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request('app/list', { cursor, limit: 100, threadId: threadId ?? null, forceRefetch });
      const rows = Array.isArray((result as any)?.data) ? (result as any).data : [];
      apps.push(...rows.map(mapAppInfo));
      cursor = typeof (result as any)?.nextCursor === 'string' ? (result as any).nextCursor : null;
    } while (cursor);
    return apps;
  }

  async readConfig(cwd: string | null, includeLayers = true): Promise<Record<string, unknown>> {
    const result = await this.request('config/read', { cwd, includeLayers });
    return result && typeof result === 'object' ? result as Record<string, unknown> : {};
  }

  async readConfigRequirements(): Promise<CodexConfigRequirements | null> {
    const result = await this.request('configRequirements/read', undefined);
    const requirements = (result as any)?.requirements;
    return requirements && typeof requirements === 'object' ? mapConfigRequirements(requirements) : null;
  }

  async listExperimentalFeatures(): Promise<CodexExperimentalFeature[]> {
    const features: CodexExperimentalFeature[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request('experimentalFeature/list', { cursor, limit: 100 });
      const rows = Array.isArray((result as any)?.data) ? (result as any).data : [];
      features.push(...rows.map(mapExperimentalFeature));
      cursor = typeof (result as any)?.nextCursor === 'string' ? (result as any).nextCursor : null;
    } while (cursor);
    return features;
  }

  async readModelProviderCapabilities(): Promise<CodexModelProviderCapabilities> {
    const result = await this.request('modelProvider/capabilities/read', {});
    return {
      webSearch: Boolean((result as any)?.webSearch),
      imageGeneration: Boolean((result as any)?.imageGeneration),
      namespaceTools: Boolean((result as any)?.namespaceTools),
    };
  }

  async fuzzyFileSearch(query: string, roots: string[]): Promise<CodexFuzzyFileResult[]> {
    const result = await this.request('fuzzyFileSearch', {
      query,
      roots,
      cancellationToken: null,
    });
    const files = Array.isArray((result as any)?.files) ? (result as any).files : [];
    return files.map(mapFuzzyFileResult);
  }

  async listMcpServerStatus(detail: 'full' | 'toolsAndAuthOnly' = 'full'): Promise<CodexMcpServerStatus[]> {
    const rows: CodexMcpServerStatus[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request('mcpServerStatus/list', { cursor, limit: 100, detail });
      const data = Array.isArray((result as any)?.data) ? (result as any).data : [];
      rows.push(...data.map(mapMcpServerStatus));
      cursor = typeof (result as any)?.nextCursor === 'string' ? (result as any).nextCursor : null;
    } while (cursor);
    return rows;
  }

  async reloadMcpServers(): Promise<void> {
    await this.request('config/mcpServer/reload', undefined);
  }

  async loginMcpServer(name: string): Promise<string> {
    const result = await this.request('mcpServer/oauth/login', { name });
    return String((result as any)?.authorizationUrl ?? (result as any)?.authorization_url ?? '');
  }

  async readMcpResource(server: string, uri: string, threadId?: string | null): Promise<CodexMcpResourceContent[]> {
    const result = await this.request('mcpServer/resource/read', {
      server,
      uri,
      threadId: threadId ?? null,
    });
    const contents = Array.isArray((result as any)?.contents) ? (result as any).contents : [];
    return contents.map(mapMcpResourceContent);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async revealThread(threadId: string): Promise<void> {
    const url = buildThreadDeepLink(threadId);
    await openUrl(url);
  }

  async respond(requestId: string | number, result: unknown): Promise<void> {
    this.send({ jsonrpc: '2.0', id: requestId, result });
  }

  async respondError(requestId: string | number, message: string): Promise<void> {
    this.send({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message } });
  }

  private async startServer(): Promise<void> {
    if (await this.attachPersistedServer()) {
      return;
    }

    if (this.autolaunch) {
      const launcher = spawn(this.launchCommand, { shell: true, detached: true, stdio: 'ignore' });
      launcher.unref();
    }
    this.port = await reservePort();
    const [stdoutFd, stderrFd] = this.openServerLogFiles();
    let child: ChildProcess;
    try {
      child = spawn(this.codexCliBin, ['app-server', '--listen', `ws://127.0.0.1:${this.port}`], {
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
    child.unref();
    this.child = child;
    if (!child.pid) {
      this.child = null;
      throw new Error('Failed to start codex app-server: child pid is unavailable');
    }
    this.writeServerState({
      pid: child.pid,
      port: this.port,
      command: `${this.codexCliBin} app-server --listen ws://127.0.0.1:${this.port}`,
      logPath: this.serverLogPath,
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
      this.handleDisconnect({ code, signal, source: 'process-exit' });
    });
    child.on('error', (error) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      if (child.pid) {
        this.clearServerStateForPid(child.pid);
      }
      this.handleDisconnect({ error: error.message, source: 'process-error' });
    });
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        reject(new Error(`codex app-server exited before WebSocket connection: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      });
    });
    await Promise.race([this.connectWebSocket(), spawnFailed]);
    await this.initialize();
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
    try {
      await this.connectWebSocket();
      await this.initialize();
      this.logger.info('codex.app-server.attached', { pid: state.pid, port: state.port });
      return true;
    } catch (error) {
      const socket = this.socket;
      this.socket = null;
      this.connected = false;
      socket?.close();
      this.logger.warn('codex.app-server.attach_failed', {
        pid: state.pid,
        port: state.port,
        error: error instanceof Error ? error.message : String(error),
      });
      this.clearServerStateForPid(state.pid);
      return false;
    }
  }

  private async connectWebSocket(): Promise<void> {
    const url = `ws://127.0.0.1:${this.port}`;
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(url);
          const onError = (event: Event) => {
            ws.close();
            reject(new Error(`WebSocket connect failed: ${String(event.type)}`));
          };
          ws.addEventListener('open', () => {
            this.socket = ws;
            this.connected = true;
            ws.addEventListener('message', message => this.handleMessage(String(message.data)));
            ws.addEventListener('close', () => {
              if (this.socket !== ws) {
                return;
              }
              this.socket = null;
              this.handleDisconnect({ code: 'ws-close', source: 'websocket-close' });
            });
            ws.addEventListener('error', err => {
              this.logger.warn('codex.ws.error', String((err as ErrorEvent).message ?? 'unknown'));
            });
            resolve();
          }, { once: true });
          ws.addEventListener('error', onError, { once: true });
        });
        this.emit('connected');
        return;
      } catch {
        await sleep(250);
      }
    }
    throw new Error(`Timed out connecting to ${url}`);
  }

  private async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'telegram-codex-app-bridge',
        title: 'Telegram Codex App Bridge',
        version: '0.2.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'codex/event/agent_reasoning_delta',
          'codex/event/reasoning_content_delta',
          'codex/event/reasoning_raw_content_delta',
          'codex/event/exec_command_output_delta',
        ]
      }
    });
    this.userAgent = (result as any).userAgent ?? null;
    this.send({ jsonrpc: '2.0', method: 'initialized' });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.socket || !this.connected) {
      await this.start();
    }
    const id = String(++this.requestId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('codex app-server socket is not open');
    }
    this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.logger.warn('codex.message.parse_failed', { raw, error: String(error) });
      return;
    }

    if ('id' in message && !('method' in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message || 'JSON-RPC error'));
      } else {
        pending.resolve((message as JsonRpcResponse).result);
      }
      return;
    }

    if ('id' in message && 'method' in message) {
      this.emit('serverRequest', message satisfies JsonRpcServerRequest);
      return;
    }

    if ('method' in message) {
      this.emit('notification', message satisfies JsonRpcNotification);
    }
  }

  private handleDisconnect(meta: Record<string, unknown>): void {
    if (this.connected) {
      this.connected = false;
    }
    this.rejectPending(new Error(`codex app-server disconnected: ${JSON.stringify(meta)}`));
    this.emit('disconnected', meta);
    if (this.desiredRunning) {
      this.scheduleReconnect();
    }
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.desiredRunning) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.startServer();
      } catch (error) {
        this.logger.error('codex.reconnect_failed', { error: String(error) });
        this.scheduleReconnect();
      }
    }, 1500);
  }

  private async terminateServer(): Promise<void> {
    const child = this.child;
    const state = this.readServerState();
    const pid = child?.pid ?? state?.pid ?? null;
    this.child = null;
    this.clearServerState();
    if (pid === null || !isProcessAlive(pid)) {
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      this.logger.warn('codex.app-server.kill_failed', {
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const exited = await waitForProcessExit(pid, 3000);
    if (!exited) {
      this.logger.warn('codex.app-server.kill_timeout', { pid });
    }
  }

  private openServerLogFiles(): [number, number] {
    fs.mkdirSync(path.dirname(this.serverLogPath), { recursive: true });
    const stdoutFd = fs.openSync(this.serverLogPath, 'a');
    try {
      return [stdoutFd, fs.openSync(this.serverLogPath, 'a')];
    } catch (error) {
      fs.closeSync(stdoutFd);
      throw error;
    }
  }

  private readServerState(): CodexAppServerState | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.serverStatePath, 'utf8')) as Partial<CodexAppServerState>;
      if (
        typeof parsed.pid === 'number'
        && Number.isInteger(parsed.pid)
        && parsed.pid > 0
        && typeof parsed.port === 'number'
        && Number.isInteger(parsed.port)
        && parsed.port > 0
        && parsed.port <= 65535
      ) {
        return {
          pid: parsed.pid,
          port: parsed.port,
          command: typeof parsed.command === 'string' ? parsed.command : '',
          logPath: typeof parsed.logPath === 'string' ? parsed.logPath : this.serverLogPath,
          bridgePid: typeof parsed.bridgePid === 'number' ? parsed.bridgePid : 0,
          startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  private writeServerState(state: CodexAppServerState): void {
    fs.mkdirSync(path.dirname(this.serverStatePath), { recursive: true });
    const tmp = `${this.serverStatePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.serverStatePath);
  }

  private clearServerState(): void {
    try {
      fs.unlinkSync(this.serverStatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('codex.app-server.state_clear_failed', {
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

async function reservePort(): Promise<number> {
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
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

function mapThread(raw: any): AppThread {
  return {
    threadId: String(raw.id),
    name: raw.name ? String(raw.name) : null,
    preview: String(raw.preview || '(empty)'),
    cwd: raw.cwd ? String(raw.cwd) : null,
    modelProvider: raw.modelProvider ? String(raw.modelProvider) : null,
    source: raw.source ? String(raw.source) : null,
    path: raw.path ? String(raw.path) : null,
    status: mapThreadStatus(raw.status),
    updatedAt: Number(raw.updatedAt || 0),
  };
}

function mapThreadSnapshot(raw: any): AppThreadSnapshot {
  const base = mapThread(raw);
  const activeFlags = Array.isArray(raw?.status?.activeFlags)
    ? raw.status.activeFlags
        .filter((entry: unknown): entry is string => typeof entry === 'string')
    : [];
  const turns = Array.isArray(raw?.turns)
    ? raw.turns.map(mapTurnSnapshot)
    : [];
  return {
    ...base,
    activeFlags,
    turns,
  };
}

function mapThreadStatus(raw: any): ThreadStatusKind {
  const type = raw?.type;
  if (type === 'active' || type === 'idle' || type === 'notLoaded' || type === 'systemError') {
    return type;
  }
  return 'idle';
}

function mapThreadSessionState(raw: any): ThreadSessionState {
  return {
    thread: mapThread(raw.thread),
    model: String(raw.model ?? ''),
    modelProvider: String(raw.modelProvider ?? ''),
    reasoningEffort: raw.reasoningEffort === null ? null : String(raw.reasoningEffort) as ReasoningEffortValue,
    cwd: String(raw.cwd ?? ''),
  };
}

function mapTurnSnapshot(raw: any) {
  return {
    turnId: String(raw?.id || ''),
    status: String(raw?.status || 'unknown'),
    error: raw?.error ? String(raw.error) : null,
    items: Array.isArray(raw?.items) ? raw.items.map(mapTurnItemSnapshot) : [],
    itemsView: typeof raw?.itemsView === 'string' ? raw.itemsView : null,
    startedAt: numberOrNull(raw?.startedAt),
    completedAt: numberOrNull(raw?.completedAt),
    durationMs: numberOrNull(raw?.durationMs),
  };
}

function mapTurnItemSnapshot(raw: any) {
  return {
    itemId: String(raw?.id || ''),
    type: String(raw?.type || ''),
    phase: raw?.phase ? String(raw.phase) : null,
    text: raw?.text ? String(raw.text) : null,
    command: raw?.command ? String(raw.command) : null,
    status: raw?.status ? String(raw.status) : null,
    aggregatedOutput: raw?.aggregatedOutput ? String(raw.aggregatedOutput) : null,
  };
}

function mapModel(raw: any): ModelInfo {
  const efforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
        .map((entry: any) => entry?.reasoningEffort)
        .filter((value: unknown): value is ReasoningEffortValue => typeof value === 'string')
    : [];
  const rawServiceTiers = Array.isArray(raw.serviceTiers)
    ? raw.serviceTiers
    : Array.isArray(raw.service_tiers)
      ? raw.service_tiers
      : [];
  const serviceTiers = rawServiceTiers.length > 0
    ? rawServiceTiers
        .map((entry: any) => ({
          id: typeof entry?.id === 'string' ? entry.id : '',
          name: typeof entry?.name === 'string' ? entry.name : '',
          description: typeof entry?.description === 'string' ? entry.description : '',
        }))
        .filter((entry: { id: string }) => entry.id.length > 0)
    : [];
  return {
    id: String(raw.id),
    model: String(raw.model),
    displayName: String(raw.displayName || raw.model),
    description: String(raw.description || ''),
    isDefault: Boolean(raw.isDefault),
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: String(raw.defaultReasoningEffort) as ReasoningEffortValue,
    serviceTiers,
  };
}

function mapThreadGoal(raw: any): CodexThreadGoal | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const status = normalizeThreadGoalStatus(raw.status);
  return {
    threadId: String(raw.threadId ?? raw.thread_id ?? ''),
    objective: String(raw.objective ?? ''),
    status,
    tokenBudget: numberOrNull(raw.tokenBudget ?? raw.token_budget),
    tokensUsed: numberOrNull(raw.tokensUsed ?? raw.tokens_used) ?? 0,
    timeUsedSeconds: numberOrNull(raw.timeUsedSeconds ?? raw.time_used_seconds) ?? 0,
    createdAt: numberOrNull(raw.createdAt ?? raw.created_at) ?? 0,
    updatedAt: numberOrNull(raw.updatedAt ?? raw.updated_at) ?? 0,
  };
}

function mapFuzzyFileResult(raw: any): CodexFuzzyFileResult {
  return {
    root: String(raw?.root ?? ''),
    path: String(raw?.path ?? ''),
    matchType: formatRawLabel(raw?.match_type ?? raw?.matchType),
    fileName: String(raw?.file_name ?? raw?.fileName ?? ''),
    score: numberOrNull(raw?.score) ?? 0,
  };
}

function mapRateLimitsByLimitId(raw: any): Record<string, CodexRateLimitSnapshot> | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entries = Object.entries(raw)
    .map(([key, value]) => [key, mapRateLimitSnapshot(value)] as const)
    .filter((entry): entry is readonly [string, CodexRateLimitSnapshot] => entry[1] !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function mapCollaborationModePreset(raw: any): CodexCollaborationModePreset {
  return {
    name: String(raw?.name ?? ''),
    mode: normalizeCollaborationMode(raw?.mode),
    model: typeof raw?.model === 'string' ? raw.model : null,
    reasoningEffort: normalizeReasoningEffort(raw?.reasoning_effort),
  };
}

function mapSkillsListEntry(raw: any): CodexSkillsListEntry {
  const skills = Array.isArray(raw?.skills) ? raw.skills : [];
  const errors = Array.isArray(raw?.errors) ? raw.errors : [];
  return {
    cwd: String(raw?.cwd ?? ''),
    skills: skills.map(mapSkillMetadata),
    errors: errors.map((entry: unknown) => formatRawError(entry)),
  };
}

function mapSkillMetadata(raw: any) {
  const iface = raw?.interface && typeof raw.interface === 'object' ? raw.interface : {};
  return {
    name: String(raw?.name ?? ''),
    description: String(raw?.description ?? ''),
    shortDescription: typeof raw?.shortDescription === 'string' ? raw.shortDescription : null,
    path: String(raw?.path ?? ''),
    scope: String(raw?.scope ?? ''),
    enabled: Boolean(raw?.enabled),
    displayName: typeof iface.displayName === 'string' ? iface.displayName : null,
    defaultPrompt: typeof iface.defaultPrompt === 'string' ? iface.defaultPrompt : null,
  };
}

function mapHooksListEntry(raw: any): CodexHooksListEntry {
  const hooks = Array.isArray(raw?.hooks) ? raw.hooks : [];
  const errors = Array.isArray(raw?.errors) ? raw.errors : [];
  const warnings = Array.isArray(raw?.warnings) ? raw.warnings : [];
  return {
    cwd: String(raw?.cwd ?? ''),
    hooks: hooks.map(mapHookMetadata),
    errors: errors.map((entry: any) => ({
      path: String(entry?.path ?? ''),
      message: String(entry?.message ?? formatRawError(entry)),
    })),
    warnings: warnings.map((entry: unknown) => String(entry)),
  };
}

function mapHookMetadata(raw: any): CodexHookMetadata {
  return {
    key: String(raw?.key ?? ''),
    eventName: formatRawLabel(raw?.eventName),
    handlerType: formatRawLabel(raw?.handlerType),
    enabled: Boolean(raw?.enabled),
    trustStatus: formatRawLabel(raw?.trustStatus),
    sourcePath: String(raw?.sourcePath ?? ''),
    pluginId: typeof raw?.pluginId === 'string' ? raw.pluginId : null,
    command: typeof raw?.command === 'string' ? raw.command : null,
    statusMessage: typeof raw?.statusMessage === 'string' ? raw.statusMessage : null,
  };
}

function mapPluginMarketplace(raw: any): CodexPluginMarketplace {
  const iface = raw?.interface && typeof raw.interface === 'object' ? raw.interface : {};
  const plugins = Array.isArray(raw?.plugins) ? raw.plugins : [];
  return {
    name: String(raw?.name ?? ''),
    displayName: typeof iface.displayName === 'string' ? iface.displayName : null,
    path: typeof raw?.path === 'string' ? raw.path : null,
    plugins: plugins.map(mapPluginSummary),
  };
}

function mapPluginSummary(raw: any): CodexPluginSummary {
  const keywords = Array.isArray(raw?.keywords) ? raw.keywords : [];
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? raw?.id ?? ''),
    enabled: Boolean(raw?.enabled),
    installed: Boolean(raw?.installed),
    source: formatRawLabel(raw?.source),
    availability: formatRawLabel(raw?.availability),
    authPolicy: formatRawLabel(raw?.authPolicy),
    installPolicy: formatRawLabel(raw?.installPolicy),
    keywords: keywords.map((entry: unknown) => String(entry)),
  };
}

function mapPluginSkillSummary(raw: any): CodexPluginSkillSummary {
  return {
    name: String(raw?.name ?? ''),
    description: String(raw?.description ?? ''),
    shortDescription: typeof raw?.shortDescription === 'string' ? raw.shortDescription : null,
    enabled: Boolean(raw?.enabled),
    path: typeof raw?.path === 'string' ? raw.path : null,
  };
}

function mapPluginDetail(raw: any): CodexPluginDetail {
  const skills = Array.isArray(raw?.skills) ? raw.skills : [];
  const hooks = Array.isArray(raw?.hooks) ? raw.hooks : [];
  const apps = Array.isArray(raw?.apps) ? raw.apps : [];
  const mcpServers = Array.isArray(raw?.mcpServers) ? raw.mcpServers : [];
  return {
    marketplaceName: String(raw?.marketplaceName ?? ''),
    marketplacePath: typeof raw?.marketplacePath === 'string' ? raw.marketplacePath : null,
    summary: mapPluginSummary(raw?.summary),
    description: typeof raw?.description === 'string' ? raw.description : null,
    skills: skills.map(mapPluginSkillSummary),
    hooks: hooks.map((entry: any) => ({ key: String(entry?.key ?? ''), eventName: formatRawLabel(entry?.eventName) })),
    apps: apps.map((entry: any) => ({
      id: String(entry?.id ?? ''),
      name: String(entry?.name ?? ''),
      description: typeof entry?.description === 'string' ? entry.description : null,
      needsAuth: Boolean(entry?.needsAuth),
    })),
    mcpServers: mcpServers.map((entry: unknown) => String(entry)),
  };
}

function mapAppInfo(raw: any): CodexAppInfo {
  const plugins = Array.isArray(raw?.pluginDisplayNames) ? raw.pluginDisplayNames : [];
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? raw?.id ?? ''),
    description: typeof raw?.description === 'string' ? raw.description : null,
    isEnabled: raw?.isEnabled !== false,
    isAccessible: Boolean(raw?.isAccessible),
    installUrl: typeof raw?.installUrl === 'string' ? raw.installUrl : null,
    distributionChannel: typeof raw?.distributionChannel === 'string' ? raw.distributionChannel : null,
    pluginDisplayNames: plugins.map((entry: unknown) => String(entry)),
  };
}

function mapExperimentalFeature(raw: any): CodexExperimentalFeature {
  return {
    name: String(raw?.name ?? ''),
    displayName: typeof raw?.displayName === 'string' ? raw.displayName : null,
    enabled: Boolean(raw?.enabled),
    defaultEnabled: Boolean(raw?.defaultEnabled),
    stage: formatRawLabel(raw?.stage),
    description: typeof raw?.description === 'string' ? raw.description : null,
  };
}

function mapConfigRequirements(raw: any): CodexConfigRequirements {
  return {
    allowedApprovalPolicies: stringArrayOrNull(raw?.allowedApprovalPolicies),
    allowedSandboxModes: stringArrayOrNull(raw?.allowedSandboxModes),
    allowedWebSearchModes: stringArrayOrNull(raw?.allowedWebSearchModes),
    enforceResidency: raw?.enforceResidency === null || raw?.enforceResidency === undefined ? null : formatRawLabel(raw.enforceResidency),
    featureRequirements: raw?.featureRequirements && typeof raw.featureRequirements === 'object'
      ? Object.fromEntries(Object.entries(raw.featureRequirements).map(([key, value]) => [key, Boolean(value)]))
      : null,
  };
}

function mapMcpServerStatus(raw: any): CodexMcpServerStatus {
  const tools = raw?.tools && typeof raw.tools === 'object' ? Object.keys(raw.tools) : [];
  const resources = Array.isArray(raw?.resources) ? raw.resources : [];
  const templates = Array.isArray(raw?.resourceTemplates) ? raw.resourceTemplates : [];
  return {
    name: String(raw?.name ?? ''),
    authStatus: formatMcpAuthStatus(raw?.authStatus),
    toolNames: tools.sort((left, right) => left.localeCompare(right)),
    resourceUris: resources
      .map((entry: any) => typeof entry?.uri === 'string' ? entry.uri : null)
      .filter((entry: string | null): entry is string => entry !== null),
    resourceTemplateUris: templates
      .map((entry: any) => typeof entry?.uriTemplate === 'string'
        ? entry.uriTemplate
        : typeof entry?.uri_template === 'string'
          ? entry.uri_template
          : null)
      .filter((entry: string | null): entry is string => entry !== null),
  };
}

function mapMcpResourceContent(raw: any): CodexMcpResourceContent {
  return {
    type: typeof raw?.text === 'string' ? 'text' : typeof raw?.blob === 'string' ? 'blob' : 'unknown',
    text: typeof raw?.text === 'string' ? raw.text : null,
    blob: typeof raw?.blob === 'string' ? raw.blob : null,
    mimeType: typeof raw?.mimeType === 'string' ? raw.mimeType : null,
    uri: typeof raw?.uri === 'string' ? raw.uri : null,
  };
}

function formatMcpAuthStatus(raw: any): string {
  if (raw === null || raw === undefined) {
    return 'unknown';
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw?.status === 'string') {
    return raw.status;
  }
  if (typeof raw?.type === 'string') {
    return raw.type;
  }
  return JSON.stringify(raw);
}

function formatRawError(raw: unknown): string {
  if (raw instanceof Error) {
    return raw.message;
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw && typeof raw === 'object' && 'message' in raw && typeof (raw as any).message === 'string') {
    return (raw as any).message;
  }
  return JSON.stringify(raw);
}

function stringArrayOrNull(raw: unknown): string[] | null {
  return Array.isArray(raw) ? raw.map((entry: unknown) => formatRawLabel(entry)) : null;
}

function formatRawLabel(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return 'unknown';
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw);
  }
  if (typeof raw === 'object') {
    const keys = Object.keys(raw);
    if (keys.length === 1) {
      return keys[0]!;
    }
  }
  return JSON.stringify(raw);
}

function normalizeCollaborationMode(value: unknown): 'default' | 'plan' | null {
  return value === 'default' || value === 'plan' ? value : null;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffortValue | null {
  return typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)
    ? value as ReasoningEffortValue
    : null;
}

function normalizeThreadGoalStatus(value: unknown): ThreadGoalStatusValue {
  return value === 'paused' || value === 'budgetLimited' || value === 'complete'
    ? value
    : 'active';
}

function mapRateLimitSnapshot(raw: any): CodexRateLimitSnapshot | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return {
    limitId: typeof raw.limitId === 'string' ? raw.limitId : null,
    limitName: typeof raw.limitName === 'string' ? raw.limitName : null,
    primary: mapRateLimitWindow(raw.primary),
    secondary: mapRateLimitWindow(raw.secondary),
    credits: mapCreditsSnapshot(raw.credits),
    planType: typeof raw.planType === 'string' ? raw.planType : null,
    rateLimitReachedType: typeof raw.rateLimitReachedType === 'string' ? raw.rateLimitReachedType : null,
  };
}

function mapRateLimitWindow(raw: any): CodexRateLimitWindow | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const usedPercent = Number(raw.usedPercent);
  return {
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : 0,
    windowDurationMins: numberOrNull(raw.windowDurationMins),
    resetsAt: numberOrNull(raw.resetsAt),
  };
}

function mapCreditsSnapshot(raw: any): CodexCreditsSnapshot | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return {
    hasCredits: Boolean(raw.hasCredits),
    unlimited: Boolean(raw.unlimited),
    balance: raw.balance === null || raw.balance === undefined ? null : String(raw.balance),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function mapSandboxPolicy(mode: SandboxModeValue): { type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' } {
  if (mode === 'read-only') {
    return { type: 'readOnly' };
  }
  if (mode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }
  return { type: 'workspaceWrite' };
}
