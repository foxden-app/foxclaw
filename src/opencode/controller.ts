import { EventEmitter } from 'node:events';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import type { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import type { OpencodeAppClient } from './client.js';
import type { OpencodeTextDeltaEvent, OpencodeToolProgressEvent, OpencodePermissionEvent } from './client.js';
import { parseCommand } from '../controller/commands.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../telegram/addressing.js';
import { chunkTelegramStreamMessage } from '../telegram/text.js';

const STREAM_THROTTLE_MS = 800;
const TOOL_THROTTLE_MS = 600;
const MAX_TOOL_LINES = 6;
const MAX_OUTPUT_CHUNKS = 1200;
const THREADS_PAGE_SIZE = 8;

const PERMISSION_CALLBACK_PREFIX = 'opencode:perm:';
const SETUP_CALLBACK_PREFIX = 'opencode:setup:';

const HELP_LINES = [
  '⚡ opencode commands:',
  '/new — create session',
  '/threads — list sessions',
  '/open <id> — bind to a session',
  '/watch <id> — follow a session live',
  '/unwatch — stop following',
  '/status — binding + runtime info',
  '/setup — model picker',
  '/model <provider:model|default> — set model',
  '/models — model picker',
  '/history [n] — recent messages',
  '/rename <name> — rename session',
  '/fork [name] — fork current session',
  '/diff — files changed this session',
  '/where — current session cwd',
  '/files <query> — fuzzy file search',
  '/compact — summarize session',
  '/loaded — list available tools',
  '/mcp [brief] — MCP servers',
  '/provider — connected providers',
  '/config — runtime config summary',
  '/approve [id] [deny] — pending approvals',
  '/abort|/interrupt — stop current turn',
  '/help — this message',
].join('\n');

const UNSUPPORTED_HINT = 'This capability is not available on the opencode runtime.';

const UNSUPPORTED_COMMANDS = new Set([
  'goal', 'goal_pause', 'goal_resume', 'goal_done', 'goal_clear',
  'fast', 'active', 'followup',
  'mode', 'plan', 'agent',
  'permissions', 'access', 'effort',
  'archive', 'unarchive', 'thread_archive', 'thread_unarchive', 'thread_rename',
  'undo', 'rollback',
  'steer', 'takeover', 'queue', 'remote', 'review',
  'skills', 'skill', 'skill_enable', 'skill_disable',
  'hooks', 'plugins', 'plugin', 'plugin_skill',
  'apps', 'features', 'requirements',
  'mcp_reload', 'mcp_login', 'mcp_resource',
  'auth', 'auth_reload', 'codex_restart', 'login', 'login_device', 'login_cancel', 'logout',
  'account', 'quota', 'update',
  'reveal', 'focus',
  'answer', 'planimpl', 'mcpel',
  'model_list', 'model_picker',
]);

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

interface ActiveTurn {
  sessionId: string;
  chunks: Array<{ text: string; messageId: number }>;
  pending: string;
  lastFlush: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  busy: boolean;
}

interface TurnTools {
  sessionId: string;
  scopeId: string;
  lines: string[];
  messageId: number | null;
  lastFlush: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface WatchCursor {
  scopeId: string;
  sessionId: string;
  messageId: number | null;
  buffer: string;
  lastFlush: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingPermissionUi {
  permissionId: string;
  sessionId: string;
  scopeId: string;
  messageId: number;
  title: string;
}

interface SetupProviderOption {
  id: string;
  label: string;
  models: Array<{ id: string; name: string }>;
}

function permissionKeyboard(localId: string): InlineKeyboard {
  return [[
    { text: 'Allow', callback_data: `${PERMISSION_CALLBACK_PREFIX}${localId}:once` },
    { text: 'Always', callback_data: `${PERMISSION_CALLBACK_PREFIX}${localId}:always` },
    { text: 'Deny', callback_data: `${PERMISSION_CALLBACK_PREFIX}${localId}:reject` },
  ]];
}

function formatApiError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { data?: { message?: string }; message?: string };
    return candidate.data?.message ?? candidate.message ?? String(error);
  }
  return String(error);
}

function shortId(sessionId: string): string {
  return sessionId.length > 16 ? `${sessionId.slice(0, 15)}…` : sessionId;
}

/**
 * opencode↔Telegram bridge core: one Telegram bot mapped to one `opencode
 * serve` transport. Each chat scope is bound to an opencode session; streaming
 * text deltas are rendered as segmented Telegram messages with a transient
 * tool-status message; permission requests are answered via inline keyboards;
 * other sessions can be watched live from a scope.
 */
export class OpencodeBridgeCore extends EventEmitter {
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly toolStatuses = new Map<string, TurnTools>();
  private readonly watchers = new Map<string, WatchCursor>();
  private readonly permissions = new Map<string, PendingPermissionUi>();
  private readonly scopeBySession = new Map<string, Set<string>>();
  private readonly locks = new Map<string, Promise<void>>();
  private started = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: BridgeStore,
    private readonly logger: Logger,
    private readonly bot: TelegramGateway,
    private readonly app: OpencodeAppClient,
    private readonly messaging: TelegramMessagingPort,
  ) {
    super();
  }

  registerInboundHandlers(): void {
    this.bot.on('text', (event: TelegramTextEvent) => {
      void this.withLock(event.scopeId, async () => this.handleText(event)).catch((error) => {
        void this.handleAsyncError('telegram.text', error, event.scopeId);
      });
    });
    this.bot.on('callback', (event: TelegramCallbackEvent) => {
      void this.handleCallback(event).catch((error) => {
        void this.handleAsyncError('telegram.callback', error, event.scopeId);
      });
    });
  }

  async start(): Promise<void> {
    this.app.on('textDelta', (delta: OpencodeTextDeltaEvent) => this.handleTextDelta(delta));
    this.app.on('toolProgress', (tool: OpencodeToolProgressEvent) => {
      void this.handleToolProgress(tool).catch((error) => {
        this.logger.warn('opencode.tool_progress_failed', { error: error instanceof Error ? error.message : String(error) });
      });
    });
    this.app.on('permission', (permission: OpencodePermissionEvent) => {
      void this.handlePermission(permission).catch((error) => {
        this.logger.warn('opencode.permission_failed', { error: error instanceof Error ? error.message : String(error) });
      });
    });
    this.app.on('sessionIdle', ({ sessionID }) => this.finishTurnsForSession(sessionID));
    this.app.on('sessionError', ({ sessionID, error }) => {
      for (const scopeId of this.scopesForSession(sessionID)) {
        void this.sendMessage(scopeId, `⚠️ ${error}`);
      }
      this.finishTurnsForSession(sessionID);
    });
    this.app.on('disconnected', () => this.resetRuntimeState());
    await this.app.start();
    await this.bot.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.bot.stop();
    this.resetRuntimeState();
    await this.app.stop({ terminateServer: false });
    this.started = false;
  }

  get isRunning(): boolean {
    return this.started;
  }

  getServerStatus(): ReturnType<OpencodeAppClient['getServerStatus']> {
    return this.app.getServerStatus();
  }

  isSocketConnected(): boolean {
    return this.app.isConnected();
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private resetRuntimeState(): void {
    for (const turn of this.turns.values()) this.clearFlushTimer(turn);
    for (const tools of this.toolStatuses.values()) {
      if (tools.timer) clearTimeout(tools.timer);
    }
    for (const watch of this.watchers.values()) {
      if (watch.timer) clearTimeout(watch.timer);
    }
    this.turns.clear();
    this.toolStatuses.clear();
    this.watchers.clear();
    this.permissions.clear();
    this.scopeBySession.clear();
  }

  private clearFlushTimer(turn: ActiveTurn): void {
    if (turn.flushTimer) {
      clearTimeout(turn.flushTimer);
      turn.flushTimer = null;
    }
  }

  private withLock<T>(scopeId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(scopeId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(scopeId, next.then(() => undefined, () => undefined));
    return next;
  }

  private async handleAsyncError(source: string, error: unknown, scopeId?: string | null): Promise<void> {
    this.logger.error(`opencode.${source}_error`, {
      ...(scopeId ? { scopeId } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
    if (scopeId) {
      await this.sendMessage(scopeId, `⚠️ ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scopesForSession(sessionId: string): string[] {
    return [...(this.scopeBySession.get(sessionId) ?? [])];
  }

  private trackScope(sessionId: string, scopeId: string): void {
    let set = this.scopeBySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.scopeBySession.set(sessionId, set);
    }
    set.add(scopeId);
  }

  private untrackScope(sessionId: string, scopeId: string): void {
    const set = this.scopeBySession.get(sessionId);
    if (!set) return;
    set.delete(scopeId);
    if (set.size === 0) this.scopeBySession.delete(sessionId);
  }

  // --------------------------------------------------------------------------
  // Inbound Telegram
  // --------------------------------------------------------------------------

  private async handleText(event: TelegramTextEvent): Promise<void> {
    const decision = resolveTelegramAddressing({
      text: event.text,
      attachmentsCount: event.attachments.length,
      entities: event.entities,
      command: event.attachments.length === 0 ? parseCommand(event.text) : null,
      botUsername: this.bot.username,
      isDefaultTopic: isDefaultTelegramScope({
        chatType: event.chatType,
        allowedChatId: this.config.tgAllowedChatId,
        allowedTopicId: this.config.tgAllowedTopicId,
        topicId: event.topicId,
        requireExplicitGroupAddressing: this.config.tgRequireExplicitGroupAddressing,
      }),
      replyToBot: event.replyToBot,
    });
    if (decision.kind === 'ignore') return;
    if (decision.kind === 'command') {
      await this.handleCommand(event.scopeId, decision.command.name, decision.command.args);
      return;
    }
    await this.dispatchPrompt(event.scopeId, decision.text);
  }

  private async handleCommand(scopeId: string, name: string, args: string[]): Promise<void> {
    if (UNSUPPORTED_COMMANDS.has(name)) {
      await this.sendMessage(scopeId, `/${name} — ${UNSUPPORTED_HINT}`);
      return;
    }
    switch (name) {
      case 'new':
      case 'start': {
        const sessionId = await this.createSession(scopeId);
        await this.sendMessage(scopeId, `👍 Created \`${shortId(sessionId)}\` — send any message to start`);
        return;
      }
      case 'threads': {
        if (args[0]?.toLowerCase() === 'archived') {
          await this.sendMessage(scopeId, 'Archived threads are not available on the opencode runtime.');
          return;
        }
        await this.showThreads(scopeId);
        return;
      }
      case 'open': {
        const target = args[0] ?? '';
        if (!target) {
          await this.sendMessage(scopeId, 'Usage: /open <session-id>');
          return;
        }
        await this.bindSession(scopeId, target);
        return;
      }
      case 'watch': {
        const sessionId = args[0] ?? this.boundSessionId(scopeId);
        if (!sessionId) {
          await this.sendMessage(scopeId, 'No bound session. Usage: /watch <session-id>');
          return;
        }
        await this.startWatch(scopeId, sessionId);
        return;
      }
      case 'unwatch': {
        await this.stopWatch(scopeId);
        return;
      }
      case 'setup':
      case 'models': {
        await this.showSetupPanel(scopeId, undefined);
        return;
      }
      case 'model': {
        await this.handleModelCommand(scopeId, args);
        return;
      }
      case 'status': {
        await this.showStatus(scopeId);
        return;
      }
      case 'abort':
      case 'interrupt':
      case 'stop': {
        const turn = this.turns.get(scopeId);
        if (!turn) {
          await this.sendMessage(scopeId, 'No active turn to abort');
          return;
        }
        await this.app.getClient().session.abort({ path: { id: turn.sessionId } });
        this.finishTurn(scopeId, turn);
        await this.sendMessage(scopeId, '⏹️ Turn aborted');
        return;
      }
      case 'history': {
        await this.handleHistoryCommand(scopeId, args);
        return;
      }
      case 'rename': {
        await this.handleRenameCommand(scopeId, args);
        return;
      }
      case 'fork': {
        await this.handleForkCommand(scopeId, args);
        return;
      }
      case 'diff': {
        await this.handleDiffCommand(scopeId);
        return;
      }
      case 'where': {
        await this.handleWhereCommand(scopeId);
        return;
      }
      case 'files': {
        await this.handleFilesCommand(scopeId, args);
        return;
      }
      case 'compact': {
        await this.handleCompactCommand(scopeId);
        return;
      }
      case 'loaded': {
        await this.handleLoadedCommand(scopeId);
        return;
      }
      case 'mcp': {
        await this.handleMcpCommand(scopeId, args);
        return;
      }
      case 'provider': {
        await this.handleProviderCommand(scopeId);
        return;
      }
      case 'config': {
        await this.handleConfigCommand(scopeId);
        return;
      }
      case 'approve': {
        await this.handleApproveCommand(scopeId, args);
        return;
      }
      case 'help': {
        await this.sendMessage(scopeId, HELP_LINES);
        return;
      }
      default:
        await this.sendMessage(scopeId, `Unknown command: /${name}. Send /help`);
    }
  }

  private async handleModelCommand(scopeId: string, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.showSetupPanel(scopeId, undefined);
      return;
    }
    if (this.turns.get(scopeId)?.busy) {
      await this.sendMessage(scopeId, '⏳ A turn is in progress — model applies next turn.');
      return;
    }
    const raw = args.join(' ').trim();
    if (!raw || raw.toLowerCase() === 'default' || raw.toLowerCase() === 'reset') {
      this.store.setChatSettings(scopeId, null, null);
      await this.sendMessage(scopeId, 'Model reset to server default — applies next turn.');
      return;
    }
    const providers = await this.listConfiguredModels();
    const matched = providers.some((provider) =>
      provider.models.some((model) => `${provider.id}:${model.id}` === raw || model.id === raw)
    );
    if (!matched) {
      const known = providers.slice(0, 5).map((provider) => provider.id).join(', ') || 'none';
      await this.sendMessage(scopeId, `Unknown model \`${raw}\`. Connected providers: ${known}. Use /models to pick.`);
      return;
    }
    const canonical = raw.includes(':') ? undefined : providers
      .flatMap((provider) => provider.models.map((model) => ({ provider, model })))
      .find(({ model }) => model.id === raw);
    const spec = canonical
      ? `${canonical.provider.id}:${canonical.model.id}`
      : raw;
    this.store.setChatSettings(scopeId, spec, null);
    await this.sendMessage(scopeId, `Model → \`${spec}\` — applies next turn.`);
  }

  private async handleHistoryCommand(scopeId: string, args: string[]): Promise<void> {
    const sessionId = this.boundSessionId(scopeId);
    if (!sessionId) {
      await this.sendMessage(scopeId, 'No bound session. Send a message first.');
      return;
    }
    const parsed = Number.parseInt(args[0] ?? '10', 10);
    const limit = Number.isFinite(parsed) ? Math.min(30, Math.max(1, parsed)) : 10;
    const client = this.app.getClient();
    const response = await client.session.messages({ path: { id: sessionId }, query: { limit } });
    if (response.error) {
      await this.sendMessage(scopeId, `⚠️ Cannot load history: ${formatApiError(response.error)}`);
      return;
    }
    const rows = Array.isArray(response.data) ? response.data : [];
    const lines: string[] = ['History:', ''];
    for (const row of rows) {
      const role = row.info?.role === 'assistant' ? '🤖' : '🧑';
      const text = ((row.parts ?? []) as Array<{ type?: string; text?: string }>)
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const body = text.length > 120 ? `${text.slice(0, 117)}…` : text || '(non-text message)';
      const time = row.info?.time?.created ? new Date(row.info.time.created).toLocaleTimeString() : '';
      lines.push(`${role} ${time ? `\`${time}\` ` : ''}${body}`);
    }
    if (lines.length === 1) lines.push('No messages yet.');
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleRenameCommand(scopeId: string, args: string[]): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.sendMessage(scopeId, 'Usage: /rename <name>');
      return;
    }
    const sessionId = this.boundSessionId(scopeId);
    if (!sessionId) {
      await this.sendMessage(scopeId, 'No bound session. Send a message first.');
      return;
    }
    const client = this.app.getClient();
    const response = await client.session.update({ path: { id: sessionId }, body: { title: name } });
    if (response.error) {
      await this.sendMessage(scopeId, `⚠️ Rename failed: ${formatApiError(response.error)}`);
      return;
    }
    const binding = this.store.getOpencodeBinding(scopeId);
    this.store.setOpencodeBinding(scopeId, sessionId, name, binding?.cwd ?? null);
    await this.sendMessage(scopeId, `Renamed → \`${name}\``);
  }

  private async handleForkCommand(scopeId: string, args: string[]): Promise<void> {
    const sessionId = this.boundSessionId(scopeId);
    if (!sessionId) {
      await this.sendMessage(scopeId, 'No bound session. Send a message first.');
      return;
    }
    if (this.turns.get(scopeId)?.busy) {
      await this.sendMessage(scopeId, '⚠️ Wait for the current turn to finish before forking.');
      return;
    }
    const client = this.app.getClient();
    const cwd = this.store.getOpencodeBinding(scopeId)?.cwd;
    const response = await client.session.fork({
      path: { id: sessionId },
      ...(cwd ? { query: { directory: cwd } } : {}),
    });
    if (response.error) {
      await this.sendMessage(scopeId, `⚠️ Fork failed: ${formatApiError(response.error)}`);
      return;
    }
    const fork = response.data as unknown as { id: string; title?: string | null };
    const requestedName = args.join(' ').trim();
    if (requestedName) {
      await client.session.update({ path: { id: fork.id }, body: { title: requestedName } });
    }
    this.store.setOpencodeBinding(scopeId, fork.id, requestedName || fork.title || null, cwd ?? null);
    await this.sendMessage(scopeId, `🍴 Forked → \`${fork.id}\`${requestedName ? ` — \`${requestedName}\`` : ''}`);
  }

  private async handleDiffCommand(scopeId: string): Promise<void> {
    const sessionId = this.boundSessionId(scopeId);
    if (!sessionId) {
      await this.sendMessage(scopeId, 'No bound session. Send a message first.');
      return;
    }
    const client = this.app.getClient();
    const response = await client.session.diff({ path: { id: sessionId } });
    if (response.error) {
      await this.sendMessage(scopeId, `⚠️ Cannot load diff: ${formatApiError(response.error)}`);
      return;
    }
    const diffs = Array.isArray(response.data) ? response.data : [];
    if (diffs.length === 0) {
      await this.sendMessage(scopeId, 'No file changes in this session.');
      return;
    }
    const lines = ['📝 Changes:', ''];
    for (const entry of diffs.slice(0, 15)) {
      const file = entry.file ? `\`${entry.file}\`` : '(unknown)';
      const stats = `${entry.additions ?? 0}+ / ${entry.deletions ?? 0}-`;
      lines.push(`${file} — ${stats}`);
    }
    if (diffs.length > 15) lines.push(`… ${diffs.length - 15} more`);
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleWhereCommand(scopeId: string): Promise<void> {
    const binding = this.store.getOpencodeBinding(scopeId);
    if (!binding) {
      await this.sendMessage(scopeId, 'No active session.');
      return;
    }
    await this.sendMessage(scopeId, [
      `Session: \`${binding.sessionId}\``,
      `Cwd: \`${binding.cwd ?? '?'}\``,
    ].join('\n'));
  }

  private async handleFilesCommand(scopeId: string, args: string[]): Promise<void> {
    const query = args.join(' ').trim();
    if (!query) {
      await this.sendMessage(scopeId, 'Usage: /files <query>');
      return;
    }
    const binding = this.store.getOpencodeBinding(scopeId);
    const cwd = binding?.cwd ?? this.config.defaultCwd;
    const client = this.app.getClient();
    const response = await client.find.files({ query: { directory: cwd, query } });
    if (response.error) {
      await this.sendMessage(scopeId, `⚠️ Search failed: ${formatApiError(response.error)}`);
      return;
    }
    const files = Array.isArray(response.data) ? response.data : [];
    if (files.length === 0) {
      await this.sendMessage(scopeId, `No matches for \`${query}\` in \`${cwd}\`.`);
      return;
    }
    const lines = [`🔍 ${query} (${files.length}):`, ''];
    for (const file of files.slice(0, 20)) {
      lines.push(`\`${file}\``);
    }
    if (files.length > 20) lines.push(`… ${files.length - 20} more`);
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleCompactCommand(scopeId: string): Promise<void> {
    const sessionId = this.boundSessionId(scopeId);
    if (!sessionId) {
      await this.sendMessage(scopeId, 'No bound session. Send a message first.');
      return;
    }
    const model = this.resolveConfigured(scopeId) ?? await this.defaultModelSpec();
    if (!model) {
      await this.sendMessage(scopeId, '⚠️ No model available to summarize. Connect a provider first.');
      return;
    }
    const parsed = this.parseModelSpec(model);
    if (!parsed) {
      await this.sendMessage(scopeId, '⚠️ Cannot summarize: configured model is invalid.');
      return;
    }
    const client = this.app.getClient();
    const response = await client.session.summarize({
      path: { id: sessionId },
      body: { providerID: parsed.providerID, modelID: parsed.modelID },
    });
    if (response.error) {
      await this.sendMessage(scopeId, `⚠️ Summarize failed: ${formatApiError(response.error)}`);
      return;
    }
    await this.sendMessage(scopeId, '✅ Session summarized.');
  }

  private async defaultModelSpec(): Promise<string | null> {
    const providers = await this.listConfiguredModels();
    const first = providers[0];
    const model = first?.models[0];
    return first && model ? `${first.id}:${model.id}` : null;
  }

  private async handleLoadedCommand(scopeId: string): Promise<void> {
    const model = this.resolveConfigured(scopeId) ?? await this.defaultModelSpec();
    if (!model) {
      await this.sendMessage(scopeId, '⚠️ No provider/model available. Connect one via `opencode auth` first.');
      return;
    }
    const parsed = this.parseModelSpec(model);
    if (!parsed) {
      await this.sendMessage(scopeId, '⚠️ Configured model is invalid.');
      return;
    }
    const binding = this.store.getOpencodeBinding(scopeId);
    const client = this.app.getClient();
    const response = await client.tool.list({
      query: {
        directory: binding?.cwd ?? this.config.defaultCwd,
        provider: parsed.providerID,
        model: parsed.modelID,
      },
    });
    if (response.error) {
      await this.sendMessage(scopeId, `⚠️ Cannot list tools: ${formatApiError(response.error)}`);
      return;
    }
    const toolList = response.data as unknown as { tools?: Array<{ name?: string }> };
    const names = (toolList?.tools ?? []).map((tool) => tool.name ?? '?');
    if (names.length === 0) {
      await this.sendMessage(scopeId, 'No tools reported for this model.');
      return;
    }
    const lines = ['🧰 Loaded tools:', ''];
    for (const line of names.slice(0, 30)) lines.push(`\`${line}\``);
    if (names.length > 30) lines.push(`… ${names.length - 30} more`);
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleMcpCommand(scopeId: string, args: string[]): Promise<void> {
    const brief = args[0]?.toLowerCase() === 'brief';
    const client = this.app.getClient();
    const response = await client.mcp.status({});
    if (response.error) {
      await this.sendMessage(scopeId, `⚠️ Cannot load MCP status: ${String(response.error)}`);
      return;
    }
    const servers = response.data as unknown as Record<string, { status: string; error?: string; tools?: unknown }>;
    const entries = Object.entries(servers ?? {});
    if (entries.length === 0) {
      await this.sendMessage(scopeId, 'No MCP servers configured.');
      return;
    }
    const icon = (status: string): string => {
      switch (status) {
        case 'connected': return '✅';
        case 'needs_auth': return '🔑';
        case 'failed': return '❌';
        default: return '⚪';
      }
    };
    const lines = [`🧩 MCP (${entries.length}):`, ''];
    for (const [name, server] of entries.slice(0, 15)) {
      if (brief) {
        lines.push(`${icon(server.status)} \`${name}\``);
        continue;
      }
      const detail = server.status === 'failed' ? ` — ${server.error ?? 'error'}` : '';
      lines.push(`${icon(server.status)} \`${name}\` — ${server.status}${detail}`);
    }
    if (entries.length > 15) lines.push(`… ${entries.length - 15} more`);
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleProviderCommand(scopeId: string): Promise<void> {
    const providers = await this.listConfiguredModels();
    if (providers.length === 0) {
      await this.sendMessage(scopeId, 'No connected providers. Check `opencode auth`.');
      return;
    }
    const lines = ['Providers:', ''];
    for (const provider of providers) {
      lines.push(`\`${provider.id}\` — ${provider.label} (${provider.models.length} models)`);
    }
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleConfigCommand(scopeId: string): Promise<void> {
    const client = this.app.getClient();
    const response = await client.config.get({});
    if (response.error) {
      await this.sendMessage(scopeId, `⚠️ Cannot load config: ${String(response.error)}`);
      return;
    }
    const config = response.data as Record<string, unknown>;
    const keys = Object.keys(config ?? {}).filter((key) => !key.startsWith('$'));
    const lines = ['⚙️ Config:', ''];
    for (const key of keys.slice(0, 20)) {
      const value = config[key];
      const rendered = typeof value === 'object' && value !== null
        ? '…'
        : String(value);
      lines.push(`\`${key}\`: ${rendered}`);
    }
    if (keys.length > 20) lines.push(`… ${keys.length - 20} more`);
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleApproveCommand(scopeId: string, args: string[]): Promise<void> {
    const pendingByScope = [...this.permissions.values()].filter((entry) => entry.scopeId === scopeId);
    const targetId = args[0]?.trim();
    if (!targetId) {
      if (pendingByScope.length === 0) {
        await this.sendMessage(scopeId, 'No pending approvals for this chat.');
        return;
      }
      const lines = ['Pending approvals:', ''];
      for (const entry of pendingByScope) {
        lines.push(`\`${entry.permissionId}\` — ${entry.title}`);
      }
      lines.push('', 'Reply with /approve <id> to allow once, or /approve <id> deny.');
      await this.sendMessage(scopeId, lines.join('\n'));
      return;
    }
    const pending = pendingByScope.find((entry) => entry.permissionId === targetId);
    if (!pending) {
      await this.sendMessage(scopeId, `No pending approval \`${targetId}\`.`);
      return;
    }
    const action = args[1]?.toLowerCase();
    const deny = action === 'deny' || action === 'reject' || action === 'no';
    try {
      const client = this.app.getClient();
      const result = await client.postSessionIdPermissionsPermissionId({
        path: { id: pending.sessionId, permissionID: pending.permissionId },
        body: { response: deny ? 'reject' : 'once' },
      });
      if (result.error) {
        await this.sendMessage(scopeId, `⚠️ Approval reply failed: ${result.error.data?.message ?? String(result.error)}`);
        return;
      }
      await this.messaging.editPlain(scopeId, pending.messageId, `${deny ? '❌ Denied' : '✅ Allowed'} ${pending.title}`);
      this.permissions.delete(pending.permissionId);
      this.store.resolveOpencodePendingPermission(pending.permissionId);
      await this.sendMessage(scopeId, deny ? '❌ Denied.' : '✅ Allowed once.');
    } catch (error) {
      await this.sendMessage(scopeId, `⚠️ Approval reply failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async dispatchPrompt(scopeId: string, text: string): Promise<void> {
    const existing = this.turns.get(scopeId);
    if (existing?.busy) {
      await this.sendMessage(scopeId, '⏳ A turn is already in progress. Send /abort to stop it first.');
      return;
    }
    if (existing) {
      this.clearFlushTimer(existing);
      this.turns.delete(scopeId);
      this.untrackScope(existing.sessionId, scopeId);
      const tools = this.toolStatuses.get(scopeId);
      if (tools) {
        if (tools.timer) clearTimeout(tools.timer);
        this.toolStatuses.delete(scopeId);
      }
    }
    const sessionId = this.boundSessionId(scopeId) ?? await this.createSession(scopeId);
    const client = this.app.getClient();
    await this.messaging.sendTypingInScope(scopeId);
    const configured = this.resolveConfigured(scopeId);
    const model = configured ? this.parseModelSpec(configured) : undefined;
    const result = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text }],
        ...(model ? { model } : {}),
      },
    });
    if (result.error) {
      await this.sendMessage(scopeId, `⚠️ Prompt failed: ${result.error.data.message ?? String(result.error)}`);
      return;
    }
    this.turns.set(scopeId, {
      sessionId,
      chunks: [],
      pending: '',
      lastFlush: 0,
      flushTimer: null,
      busy: true,
    });
    this.trackScope(sessionId, scopeId);
  }

  private async createSession(scopeId: string): Promise<string> {
    const client = this.app.getClient();
    const created = await client.session.create({});
    if (created.error) {
      throw new Error(`session.create: ${created.error.data.message ?? String(created.error)}`);
    }
    const sessionId = created.data.id;
    this.store.setOpencodeBinding(scopeId, sessionId, null, this.config.defaultCwd);
    this.logger.info('opencode.session.created', { scopeId, sessionId });
    return sessionId;
  }

  private async bindSession(scopeId: string, sessionId: string): Promise<void> {
    const client = this.app.getClient();
    const info = await client.session.get({ path: { id: sessionId } });
    if (info.error) {
      await this.sendMessage(scopeId, `⚠️ Cannot open session: ${info.error.data.message ?? String(info.error)}`);
      return;
    }
    const title = info.data.title?.trim() || null;
    this.store.setOpencodeBinding(scopeId, sessionId, title, info.data.directory ?? this.config.defaultCwd);
    await this.sendMessage(scopeId, `✅ Bound to \`${sessionId}\`${title ? ` — ${title}` : ''}`);
  }

  private boundSessionId(scopeId: string): string | null {
    return this.store.getOpencodeBinding(scopeId)?.sessionId ?? null;
  }

  private async showStatus(scopeId: string): Promise<void> {
    const binding = this.store.getOpencodeBinding(scopeId);
    const turn = this.turns.get(scopeId);
    const lines = [
      `opencode serve: ${this.app.isConnected() ? '✅' : '❌'}`,
      binding
        ? `Session: \`${binding.sessionId}\`${binding.title ? ` — ${binding.title}` : ''}`
        : 'Session: none — send a message to create one',
    ];
    if (turn?.busy) lines.push('Turn: ⏳ in progress');
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async showThreads(scopeId: string): Promise<void> {
    const client = this.app.getClient();
    const listed = await client.session.list({});
    if (listed.error) {
      await this.sendMessage(scopeId, `⚠️ Cannot list sessions: ${String(listed.error)}`);
      return;
    }
    const sessions = listed.data as unknown as Array<{
      id: string;
      title?: string;
      directory?: string;
      time?: { updated?: number };
    }>;
    if (!sessions || sessions.length === 0) {
      await this.sendMessage(scopeId, 'No sessions yet. Send any message to create one.');
      return;
    }
    const bound = this.boundSessionId(scopeId);
    const lines: string[] = ['Sessions:', ''];
    for (const session of sessions.slice(0, THREADS_PAGE_SIZE)) {
      const name = session.title?.trim() || shortId(session.id);
      const age = typeof session.time?.updated === 'number' ? ` · ${this.formatAge(session.time.updated)}` : '';
      const mark = session.id === bound ? '▸ ' : '  ';
      lines.push(`${mark}${name}${age}`);
      lines.push(`   \`${session.id}\``);
    }
    if (sessions.length > THREADS_PAGE_SIZE) {
      lines.push(`\n… ${sessions.length - THREADS_PAGE_SIZE} more`);
    }
    lines.push('\n`/open <id>` to switch, `/new` to start fresh.');
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private formatAge(timestamp: number): string {
    const mins = Math.floor((Date.now() - timestamp) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  // --------------------------------------------------------------------------
  // Setup: model selection
  // --------------------------------------------------------------------------

  private async listConfiguredModels(): Promise<Array<SetupProviderOption>> {
    try {
      const client = this.app.getClient();
      const response = await client.config.providers({});
      if (response.error) {
        this.logger.warn('opencode.providers_failed', { error: String(response.error) });
        return [];
      }
      const data = response.data as unknown as {
        providers?: Array<{
          id: string;
          name?: string;
          options?: Record<string, unknown>;
          models?: Record<string, { id?: string; name?: string }>;
        }>;
      };
      const all = (data.providers ?? [])
        .slice()
        .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
        .map((provider) => ({
          id: provider.id,
          label: provider.name ?? provider.id,
          models: Object.values(provider.models ?? {}).map((raw) => ({
            id: raw.id ?? '',
            name: raw.name ?? raw.id ?? '',
          })).filter((model) => Boolean(model.id)),
        }))
        .filter((provider) => provider.models.length > 0);
      return all;
    } catch (error) {
      this.logger.warn('opencode.providers_error', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  private resolveConfigured(scopeId: string): string | null {
    return this.store.getChatSettings(scopeId)?.model ?? null;
  }

  private parseModelSpec(spec: string): { providerID: string; modelID: string } | null {
    const sepIndex = spec.indexOf(':');
    if (sepIndex <= 0 || sepIndex === spec.length - 1) {
      return null;
    }
    return {
      providerID: spec.slice(0, sepIndex),
      modelID: spec.slice(sepIndex + 1),
    };
  }

  private async showSetupPanel(scopeId: string, messageId?: number): Promise<void> {
    const providers = await this.listConfiguredModels();
    if (providers.length === 0) {
      const text = ['⚙️ Setup', '', 'No connected providers found — check `opencode auth` from the CLI.'].join('\n');
      if (messageId !== undefined) {
        await this.messaging.editPlain(scopeId, messageId, text);
        return;
      }
      await this.sendMessage(scopeId, text);
      return;
    }
    const configured = this.resolveConfigured(scopeId);
    const binding = this.store.getOpencodeBinding(scopeId);
    const lines = [
      '⚙️ Setup',
      '',
      `Session: ${binding ? `\`${shortId(binding.sessionId)}\`` : 'none'}`,
      `Model: ${configured ? `\`${configured}\`` : 'server default'}`,
      '',
      'Choose a provider to list its models:',
    ];
    const keyboard: InlineKeyboard = providers.slice(0, 10).map((provider, index) => [{
      text: `${configured?.startsWith(`${provider.id}:`) ? '▸ ' : ''}${provider.label} (${provider.models.length})`,
      callback_data: `${SETUP_CALLBACK_PREFIX}provider:${index}`,
    }]);
    const text = lines.join('\n');
    if (messageId !== undefined) {
      await this.messaging.editPlain(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendMessage(scopeId, text, keyboard);
  }

  private async showProviderModelsPanel(scopeId: string, providerIndex: number, messageId?: number): Promise<void> {
    const providers = await this.listConfiguredModels();
    const provider = providers[providerIndex];
    if (!provider) {
      await this.sendMessage(scopeId, '⚠️ Provider not found.');
      return;
    }
    const configured = this.resolveConfigured(scopeId);
    const lines = [
      `⚙️ ${provider.label}`,
      '',
      `Current: ${configured ? `\`${configured}\`` : 'server default'}`,
      '',
      'Choose a model:',
    ];
    const keyboard: InlineKeyboard = provider.models.slice(0, 15).map((model) => [{
      text: `${configured === `${provider.id}:${model.id}` ? '▸ ' : ''}${model.name}`,
      callback_data: `${SETUP_CALLBACK_PREFIX}model:${providerIndex}:${model.id}`,
    }]);
    keyboard.push([{ text: '← Back', callback_data: `${SETUP_CALLBACK_PREFIX}back` }]);
    const text = lines.join('\n');
    if (messageId !== undefined) {
      await this.messaging.editPlain(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendMessage(scopeId, text, keyboard);
  }

  private async handleSetupCallback(event: TelegramCallbackEvent): Promise<void> {
    const data = event.data.slice(SETUP_CALLBACK_PREFIX.length);
    const [kind, param1, param2] = data.split(':') as [string, string | undefined, string | undefined];
    if (kind === 'provider') {
      const index = Number.parseInt(param1 ?? '', 10);
      if (!Number.isFinite(index)) {
        await this.messaging.answerCallback(event.callbackQueryId, 'Invalid');
        return;
      }
      await this.showProviderModelsPanel(event.scopeId, index, event.messageId);
      await this.messaging.answerCallback(event.callbackQueryId, 'Models');
      return;
    }
    if (kind === 'model') {
      const index = Number.parseInt(param1 ?? '', 10);
      if (!Number.isFinite(index) || !param2) {
        await this.messaging.answerCallback(event.callbackQueryId, 'Invalid');
        return;
      }
      const providers = await this.listConfiguredModels();
      const provider = providers[index];
      if (!provider || !provider.models.some((model) => model.id === param2)) {
        await this.messaging.answerCallback(event.callbackQueryId, 'Not found');
        return;
      }
      const spec = `${provider.id}:${param2}`;
      this.store.setChatSettings(event.scopeId, spec, null);
      await this.messaging.answerCallback(event.callbackQueryId, `Model → ${spec}`);
      await this.showSetupPanel(event.scopeId, event.messageId);
      return;
    }
    if (kind === 'back') {
      await this.showSetupPanel(event.scopeId, event.messageId);
      await this.messaging.answerCallback(event.callbackQueryId, 'Back');
      return;
    }
    await this.messaging.answerCallback(event.callbackQueryId, 'Unknown');
  }

  // --------------------------------------------------------------------------
  // Watch: relay another session's deltas to this scope
  // --------------------------------------------------------------------------

  private async startWatch(scopeId: string, sessionId: string): Promise<void> {
    const existing = this.watchers.get(scopeId);
    if (existing) {
      await this.sendMessage(scopeId, `Already watching \`${existing.sessionId}\`. Use /unwatch to stop.`);
      return;
    }
    this.watchers.set(scopeId, {
      scopeId,
      sessionId,
      messageId: null,
      buffer: '',
      lastFlush: 0,
      timer: null,
    });
    await this.sendMessage(scopeId, `👀 Watching \`${sessionId}\`. Use /unwatch to stop.`);
  }

  private async stopWatch(scopeId: string): Promise<void> {
    const watch = this.watchers.get(scopeId);
    if (!watch) {
      await this.sendMessage(scopeId, 'Not watching any session.');
      return;
    }
    if (watch.timer) {
      clearTimeout(watch.timer);
      watch.timer = null;
    }
    this.watchers.delete(scopeId);
    await this.sendMessage(scopeId, `👋 Stopped watching \`${watch.sessionId}\``);
  }

  private handleWatchDelta(sessionId: string, delta: OpencodeTextDeltaEvent): void {
    for (const watch of this.watchers.values()) {
      if (watch.sessionId !== sessionId) continue;
      watch.buffer += delta.delta ?? delta.text;
      this.scheduleWatchFlush(watch);
    }
  }

  private scheduleWatchFlush(watch: WatchCursor): void {
    if (watch.timer) return;
    const elapsed = Date.now() - watch.lastFlush;
    const delay = Math.max(0, STREAM_THROTTLE_MS - elapsed);
    watch.timer = setTimeout(() => {
      watch.timer = null;
      void this.flushWatch(watch).catch((error) => {
        this.logger.warn('opencode.watch_flush_failed', { error: error instanceof Error ? error.message : String(error) });
      });
    }, delay);
  }

  private async flushWatch(watch: WatchCursor): Promise<void> {
    if (!watch.buffer.trim()) return;
    if (watch.messageId === null) {
      watch.messageId = await this.sendMessage(watch.scopeId, `👀 \`${watch.sessionId}\`\n${watch.buffer}`);
    } else {
      await this.messaging.editPlain(watch.scopeId, watch.messageId, watch.buffer);
    }
    watch.buffer = '';
    watch.lastFlush = Date.now();
  }

  // --------------------------------------------------------------------------
  // Rendering: text delta streaming + tool status + permission
  // --------------------------------------------------------------------------

  private handleTextDelta(delta: OpencodeTextDeltaEvent): void {
    this.handleWatchDelta(delta.sessionID, delta);
    for (const scopeId of this.scopesForSession(delta.sessionID)) {
      const turn = this.turns.get(scopeId);
      if (!turn || !turn.busy) continue;
      turn.pending += delta.delta ?? delta.text;
      this.scheduleFlush(scopeId, turn);
    }
  }

  private scheduleFlush(scopeId: string, turn: ActiveTurn): void {
    if (turn.flushTimer) return;
    const elapsed = Date.now() - turn.lastFlush;
    const delay = Math.max(0, STREAM_THROTTLE_MS - elapsed);
    turn.flushTimer = setTimeout(() => {
      turn.flushTimer = null;
      void this.flushTurn(scopeId, turn).catch((error) => {
        this.logger.warn('opencode.flush_failed', { scopeId, error: error instanceof Error ? error.message : String(error) });
      });
    }, delay);
  }

  private async flushTurn(scopeId: string, turn: ActiveTurn): Promise<void> {
    if (!turn.pending.trim()) return;
    const chunks = chunkTelegramStreamMessage(turn.pending, MAX_OUTPUT_CHUNKS);
    for (let index = 0; index < chunks.length; index++) {
      const text = chunks[index]!;
      if (index < turn.chunks.length) {
        const existing = turn.chunks[index]!;
        if (existing.text !== text) {
          await this.messaging.editPlain(scopeId, existing.messageId, text);
          existing.text = text;
        }
      } else {
        const messageId = await this.sendMessage(scopeId, text);
        turn.chunks.push({ text, messageId });
      }
    }
    turn.lastFlush = Date.now();
  }

  private async handleToolProgress(tool: OpencodeToolProgressEvent): Promise<void> {
    const scopes = this.scopesForSession(tool.sessionID);
    for (const scopeId of scopes) {
      const turn = this.turns.get(scopeId);
      if (!turn || !turn.busy) continue;
      const label = tool.status === 'completed' ? '✅' : tool.status === 'error' ? '❌' : '🔧';
      let tools = this.toolStatuses.get(scopeId);
      if (!tools) {
        tools = { sessionId: tool.sessionID, scopeId, lines: [], messageId: null, lastFlush: 0, timer: null };
        this.toolStatuses.set(scopeId, tools);
      }
      tools.lines.push(`${label} ${tool.title ?? tool.tool}`);
      if (tools.lines.length > MAX_TOOL_LINES) tools.lines.shift();
      this.scheduleToolFlush(tools);
    }
  }

  private scheduleToolFlush(tools: TurnTools): void {
    if (tools.timer) return;
    const elapsed = Date.now() - tools.lastFlush;
    const delay = Math.max(0, TOOL_THROTTLE_MS - elapsed);
    tools.timer = setTimeout(() => {
      tools.timer = null;
      void this.flushToolStatus(tools).catch((error) => {
        this.logger.warn('opencode.tool_status_failed', { scopeId: tools.scopeId, error: error instanceof Error ? error.message : String(error) });
      });
    }, delay);
  }

  private async flushToolStatus(tools: TurnTools): Promise<void> {
    if (tools.lines.length === 0) return;
    const text = `${tools.lines.join('\n')}\n\n🔄 working…`;
    if (tools.messageId === null) {
      tools.messageId = await this.sendMessage(tools.scopeId, text);
    } else {
      await this.messaging.editPlain(tools.scopeId, tools.messageId, text);
    }
    tools.lastFlush = Date.now();
  }

  private async handlePermission(permission: OpencodePermissionEvent): Promise<void> {
    for (const scopeId of this.scopesForSession(permission.sessionID)) {
      const pending = this.permissions.get(permission.id);
      const title = permission.title || permission.type || 'permission';
      const lines = [
        `🛂 Permission: ${title}`,
        ...(permission.pattern ? [`\`${Array.isArray(permission.pattern) ? permission.pattern.join(' ') : permission.pattern}\``] : []),
      ];
      if (pending) {
        await this.messaging.editHtml(scopeId, pending.messageId, lines.join('\n'), permissionKeyboard(permission.id));
        continue;
      }
      const messageId = await this.sendMessage(scopeId, lines.join('\n'), permissionKeyboard(permission.id));
      this.permissions.set(permission.id, {
        permissionId: permission.id,
        sessionId: permission.sessionID,
        scopeId,
        messageId,
        title,
      });
      this.store.saveOpencodePendingPermission({
        localId: permission.id,
        sessionId: permission.sessionID,
        permissionId: permission.id,
        scopeId,
        kind: permission.type,
        title,
        pattern: Array.isArray(permission.pattern) ? permission.pattern.join('\n') : (permission.pattern ?? null),
        metadataJson: JSON.stringify(permission.metadata ?? {}),
        messageId,
      });
    }
  }

  private async handlePermissionCallback(event: TelegramCallbackEvent): Promise<void> {
    const data = event.data;
    if (!data.startsWith(PERMISSION_CALLBACK_PREFIX)) return;
    const parts = data.slice(PERMISSION_CALLBACK_PREFIX.length).split(':');
    if (parts.length !== 2) return;
    const [localId, action] = parts as [string, string];
    const pending = this.permissions.get(localId);
    if (!pending || pending.scopeId !== event.scopeId) {
      await this.messaging.answerCallback(event.callbackQueryId, 'Expired');
      return;
    }
    try {
      const response = action === 'once' ? 'once' : action === 'always' ? 'always' : 'reject';
      const result = await this.app.getClient().postSessionIdPermissionsPermissionId({
        path: { id: pending.sessionId, permissionID: pending.permissionId },
        body: { response },
      });
      if (result.error) {
        await this.messaging.answerCallback(event.callbackQueryId, 'Failed');
        await this.sendMessage(event.scopeId, `⚠️ Permission reply failed: ${result.error.data.message ?? 'unknown error'}`);
        return;
      }
      const outcome = action === 'reject' ? '❌ Denied' : '✅ Allowed';
      await this.messaging.editPlain(event.scopeId, pending.messageId, `${outcome} ${pending.title}`);
      this.permissions.delete(localId);
      this.store.resolveOpencodePendingPermission(localId);
      await this.messaging.answerCallback(event.callbackQueryId, response === 'reject' ? 'Denied' : 'Approved');
    } catch (error) {
      await this.messaging.answerCallback(event.callbackQueryId, 'Failed');
      await this.sendMessage(event.scopeId, `⚠️ Permission reply failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleCallback(event: TelegramCallbackEvent): Promise<void> {
    if (event.data.startsWith(PERMISSION_CALLBACK_PREFIX)) {
      await this.handlePermissionCallback(event);
      return;
    }
    if (event.data.startsWith(SETUP_CALLBACK_PREFIX)) {
      await this.handleSetupCallback(event);
    }
  }

  // --------------------------------------------------------------------------
  // Turn lifecycle
  // --------------------------------------------------------------------------

  private finishTurnsForSession(sessionId: string): void {
    for (const scopeId of this.scopesForSession(sessionId)) {
      const turn = this.turns.get(scopeId);
      if (turn) {
        this.finishTurn(scopeId, turn);
      }
    }
    for (const watch of this.watchers.values()) {
      if (watch.sessionId !== sessionId) continue;
      if (watch.timer) {
        clearTimeout(watch.timer);
        watch.timer = null;
      }
      void this.flushWatch(watch).catch(() => {});
    }
  }

  private finishTurn(scopeId: string, turn: ActiveTurn): void {
    this.clearFlushTimer(turn);
    if (turn.pending.trim()) {
      void this.flushTurn(scopeId, turn).catch((error) => {
        this.logger.warn('opencode.final_flush_failed', { scopeId, error: error instanceof Error ? error.message : String(error) });
      });
      turn.pending = '';
    }
    const tools = this.toolStatuses.get(scopeId);
    if (tools) {
      if (tools.timer) {
        clearTimeout(tools.timer);
        tools.timer = null;
      }
      if (tools.messageId !== null) {
        const finalLines = tools.lines.filter((line) => line.startsWith('✅') || line.startsWith('❌'));
        const final = finalLines.length > 0 ? `🗂 ${finalLines.join('\n')}` : '✅ done';
        void this.messaging.editPlain(scopeId, tools.messageId, final).catch(() => {});
      }
      this.toolStatuses.delete(scopeId);
    }
    turn.busy = false;
  }

  private async sendMessage(scopeId: string, text: string, keyboard?: InlineKeyboard): Promise<number> {
    return this.messaging.sendPlain(scopeId, text, keyboard);
  }
}