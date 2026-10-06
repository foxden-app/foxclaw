import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { AppLocale } from '../types.js';
import type { ChannelPort, ChannelInlineKeyboard } from '../core/channel_port.js';
import type { ChannelTextEvent } from '../core/channel_events.js';
import type { BackendDescriptor } from '../core/engine_spi.js';

export interface BackendSetupHost {
  config: AppConfig;
  store: BridgeStore;
  logger: Logger;
  messaging: ChannelPort;
}
export type BackendFactory = (host: BackendSetupHost) => BackendDescriptor;
export interface BackendCandidate {
  label: string;
  location: string;
  updates: Record<string, string>;
}
export interface BackendSetupDefinition {
  id: string;
  name: string;
  discover(): Promise<BackendCandidate[]>;
  fromPath(location: string): Promise<BackendCandidate>;
  validate(candidate: BackendCandidate, signal: AbortSignal): Promise<void>;
  factory(candidate: BackendCandidate): BackendFactory;
  install?(signal: AbortSignal): Promise<BackendCandidate>;
}

/** One owner for provisioning jobs and config writes across all bots on this service. */
export class BackendSetupManager {
  readonly definitions: ReadonlyMap<string, BackendSetupDefinition>;
  private readonly targets = new Set<(factory: BackendFactory) => void>();
  private active: { controller: AbortController; done: Promise<void> } | null = null;
  private stopped = false;
  constructor(definitions: BackendSetupDefinition[], private readonly envPath: string,
    private readonly canConfigure: () => Promise<boolean> = async () => true) {
    this.definitions = new Map(definitions.map(definition => [definition.id, definition]));
  }
  get busy(): boolean { return this.active !== null; }
  attach(target: (factory: BackendFactory) => void): () => void {
    if (this.stopped) throw new Error('Backend setup is stopped');
    this.targets.add(target);
    return () => this.targets.delete(target);
  }
  async enable(id: string, candidate?: BackendCandidate): Promise<void> {
    if (this.stopped) throw new Error('Backend setup is stopped');
    if (this.active) throw new Error('Another backend is being configured');
    const definition = this.definitions.get(id);
    if (!definition) throw new Error('Unknown backend');
    const controller = new AbortController();
    // Claim before the first await: two bots cannot start overlapping installations.
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.active = { controller, done };
    try {
      if (!await this.canConfigure()) throw new Error('A service update is running; try again when it finishes');
      controller.signal.throwIfAborted();
      const selected = candidate ?? await definition.install?.(controller.signal);
      if (!selected) throw new Error('This backend requires a local installation');
      await definition.validate(selected, controller.signal);
      controller.signal.throwIfAborted();
      const factory = definition.factory(selected);
      writeBackendEnv(this.envPath, selected.updates);
      for (const target of this.targets) target(factory);
    } finally { this.active = null; finish(); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.active?.controller.abort();
    await this.active?.done;
    this.targets.clear();
  }
}

export function writeBackendEnv(envPath: string, updates: Record<string, string>): void {
  // Preserve symlink-backed configuration and every unrelated setting/comment.
  const target = fs.existsSync(envPath) ? fs.realpathSync(envPath) : envPath;
  let text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid backend configuration');
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'gm');
    if (pattern.test(text)) text = text.replace(pattern, () => line);
    else text = `${text.trimEnd()}\n${line}\n`;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, text, { mode: 0o600 }); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** Fixed executable/argument vectors only; bounded lifetime and process-tree cleanup. */
export async function runBackendCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  signal: AbortSignal, timeoutMs = 5 * 60_000): Promise<string> {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (force: boolean): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
        } else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch { /* Already exited. */ }
    };
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      kill(false);
      escalation = setTimeout(() => kill(true), 3000);
    };
    const timeout = setTimeout(cancel, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (data: Buffer) => { stdout = (stdout + data.toString()).slice(-8000); });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8000); });
    const cleanup = (): void => {
      clearTimeout(timeout); clearTimeout(escalation); signal.removeEventListener('abort', cancel);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      if (cancelled) kill(true);
      cleanup();
      if (cancelled) reject(new Error(signal.aborted ? 'Backend setup cancelled' : 'Backend setup timed out'));
      else if (code !== 0) reject(new Error(`Backend command failed (${code}): ${(stderr || stdout).slice(-2000)}`));
      else resolve(stdout.trim());
    });
  });
}

interface SetupPanelHost {
  listBackends(): Promise<BackendDescriptor[]>;
  send(scopeId: string, text: string, keyboard: ChannelInlineKeyboard, messageId?: number): Promise<void>;
  readPathState?(scopeId: string): string | null;
  writePathState?(scopeId: string, state: string | null): void;
}
interface Choice {
  scopeId: string;
  backendId: string;
  candidate?: BackendCandidate | undefined;
  expires: number;
}

/** Per-bot, per-scope menus. Choices never select an execution backend implicitly. */
export class BackendSetupUi {
  private readonly choices = new Map<string, Choice>();
  private readonly pendingPaths = new Map<string, { backendId: string; expires: number }>();
  constructor(private readonly manager: BackendSetupManager, private readonly host: SetupPanelHost) {}
  private clearScope(scopeId: string): void {
    this.pendingPaths.delete(scopeId);
    this.host.writePathState?.(scopeId, null);
    for (const [key, choice] of this.choices) if (choice.scopeId === scopeId) this.choices.delete(key);
  }
  private choice(scopeId: string, backendId: string, candidate?: BackendCandidate): string {
    for (const [key, choice] of this.choices) if (choice.expires < Date.now()) this.choices.delete(key);
    const key = randomUUID();
    this.choices.set(key, { scopeId, backendId, candidate, expires: Date.now() + 5 * 60_000 });
    return key;
  }
  rows(locale: AppLocale): ChannelInlineKeyboard {
    return [[{ text: locale === 'zh' ? '➕ 添加后端' : '➕ Add backend', callback_data: 'backend-setup:list' }]];
  }
  async menu(scopeId: string, locale: AppLocale, messageId?: number): Promise<void> {
    this.clearScope(scopeId);
    const installed = new Set((await this.host.listBackends()).map(backend => backend.engineType));
    const definitions = [...this.manager.definitions.values()].filter(definition => !installed.has(definition.id));
    const keyboard = definitions.map(definition => [{ text: definition.name, callback_data: `backend-setup:select:${definition.id}` }]);
    keyboard.push([{ text: locale === 'zh' ? '◀️ 返回后端列表' : '◀️ Back to backends', callback_data: 'engine:setup:backend' }]);
    await this.host.send(scopeId, locale === 'zh'
      ? `➕ **添加后端**\n\n${definitions.length ? '选择要接入的后端。会保留当前会话，接入后可自行切换。' : '支持从面板接入的后端均已添加。'}`
      : `➕ **Add backend**\n\n${definitions.length ? 'Choose a backend. Your current session stays selected; switch after setup.' : 'All backends supported by this setup panel are already added.'}`, keyboard, messageId);
  }
  async select(scopeId: string, id: string, locale: AppLocale, messageId?: number): Promise<void> {
    const definition = this.manager.definitions.get(id);
    if (!definition) throw new Error('Unknown backend');
    this.clearScope(scopeId);
    const candidates = await definition.discover();
    const keyboard: ChannelInlineKeyboard = candidates.map(candidate => [{
      text: `${locale === 'zh' ? '接入' : 'Use'} · ${candidate.label}`,
      callback_data: `backend-setup:use:${this.choice(scopeId, id, candidate)}`,
    }]);
    if (definition.install) keyboard.push([{ text: locale === 'zh' ? '下载官方 CLI 并接入' : 'Install official CLI and enable',
      callback_data: `backend-setup:install:${this.choice(scopeId, id)}` }]);
    keyboard.push([{ text: locale === 'zh' ? '指定 CLI / 源码路径' : 'Specify CLI / source path', callback_data: `backend-setup:path:${id}` }]);
    keyboard.push(...this.rows(locale));
    const locations = candidates.map(candidate => `• ${candidate.label}: \`${candidate.location}\``).join('\n');
    await this.host.send(scopeId, `➕ **${definition.name}**\n\n${locations || (locale === 'zh' ? '尚未找到本机安装。' : 'No local installation found.')}\n\n${locale === 'zh' ? '接入前检查启动能力；官方 CLI 安装在 FoxClaw 的独立目录，沿用该后端的本机凭据。无需新增 Bot，也不会自动切换当前会话。' : 'Startup is checked before enabling. Official CLIs use a dedicated FoxClaw directory and existing backend credentials. No extra bot or automatic session switch.'}`, keyboard, messageId);
  }
  async callback(scopeId: string, data: string, locale: AppLocale, messageId?: number): Promise<boolean> {
    if (!data.startsWith('backend-setup:')) { this.clearScope(scopeId); return false; }
    const [, action, value] = data.split(':');
    if (action === 'list') await this.menu(scopeId, locale, messageId);
    else if (action === 'select') await this.select(scopeId, value!, locale, messageId);
    else if (action === 'path') {
      if (!this.manager.definitions.has(value!)) throw new Error('Unknown backend');
      this.clearScope(scopeId);
      const pending = { backendId: value!, expires: Date.now() + 5 * 60_000 };
      this.pendingPaths.set(scopeId, pending);
      this.host.writePathState?.(scopeId, JSON.stringify(pending));
      await this.host.send(scopeId, locale === 'zh' ? '发送本机 CLI 文件或源码目录的绝对路径。\n/backend cancel 取消' : 'Send an absolute local CLI or source path.\n/backend cancel to cancel.', this.rows(locale), messageId);
    } else if (action === 'use' || action === 'install') {
      const choice = this.choices.get(value!);
      if (!choice || choice.scopeId !== scopeId || choice.expires < Date.now() || (action === 'use') !== Boolean(choice.candidate)) {
        await this.host.send(scopeId, locale === 'zh' ? '此操作已过期，请重新选择后端。' : 'This choice expired. Select the backend again.', this.rows(locale));
        return true;
      }
      this.clearScope(scopeId);
      await this.enable(scopeId, choice.backendId, choice.candidate, locale, messageId);
    }
    return true;
  }
  async command(scopeId: string, command: string, args: string, locale: AppLocale): Promise<boolean> {
    this.clearScope(scopeId);
    if (!['backend', 'backends', 'engine', 'engines'].includes(command)) return false;
    if (args === 'cancel') {
      this.pendingPaths.delete(scopeId);
      await this.menu(scopeId, locale);
      return true;
    }
    const match = /^add(?:\s+([a-z][a-z0-9-]*))?$/.exec(args);
    if (!match) return false;
    try {
      if (match[1]) await this.select(scopeId, match[1], locale);
      else await this.menu(scopeId, locale);
    } catch (error) { await this.host.send(scopeId, `❌ ${safeSetupError(error)}`, this.rows(locale)); }
    return true;
  }
  inbound(event: ChannelTextEvent, locale: AppLocale): boolean | Promise<boolean> {
    let pending = this.pendingPaths.get(event.scopeId);
    if (!pending) {
      const saved = this.host.readPathState?.(event.scopeId);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { backendId?: unknown; expires?: unknown };
          if (typeof parsed.backendId === 'string' && typeof parsed.expires === 'number' && this.manager.definitions.has(parsed.backendId)) {
            pending = { backendId: parsed.backendId, expires: parsed.expires };
            this.pendingPaths.set(event.scopeId, pending);
          }
        } catch { /* Invalid saved interaction is not used as an executable choice. */ }
      }
    }
    if (!pending) return false;
    // POSIX paths resemble slash commands. Consume them before command dispatch,
    // while actual commands such as /new and /backend cancel still work normally.
    if (/^\/[\w]+(?:@[\w]+)?(?:\s|$)/.test(event.text.trim())) { this.clearScope(event.scopeId); return false; }
    return this.consumePath(event, pending, locale);
  }
  private async consumePath(event: ChannelTextEvent, pending: { backendId: string; expires: number }, locale: AppLocale): Promise<boolean> {
    if (pending.expires < Date.now()) {
      await this.host.send(event.scopeId, locale === 'zh' ? '路径输入已过期，请重新打开添加面板，或发送 /backend cancel 返回聊天。' : 'Path input expired. Reopen setup or send /backend cancel to return to chat.', this.rows(locale));
      return true;
    }
    try {
      const definition = this.manager.definitions.get(pending.backendId)!;
      const candidate = await definition.fromPath(event.text.trim());
      if (this.pendingPaths.get(event.scopeId) !== pending) return true;
      const key = this.choice(event.scopeId, pending.backendId, candidate);
      await this.host.send(event.scopeId, `${definition.name}\n\`${candidate.location}\``, [[{
        text: locale === 'zh' ? '检查并接入' : 'Validate and enable', callback_data: `backend-setup:use:${key}`,
      }], ...this.rows(locale)]);
    } catch (error) { await this.host.send(event.scopeId, safeSetupError(error), this.rows(locale)); }
    return true;
  }
  private async enable(scopeId: string, id: string, candidate: BackendCandidate | undefined, locale: AppLocale, messageId?: number): Promise<void> {
    if ((await this.host.listBackends()).some(backend => backend.engineType === id)) {
      await this.menu(scopeId, locale, messageId);
      return;
    }
    await this.host.send(scopeId, locale === 'zh' ? '⏳ 正在准备后端并检查启动能力…' : '⏳ Preparing backend and checking startup…', [], messageId);
    try {
      await this.manager.enable(id, candidate);
      await this.host.send(scopeId, locale === 'zh' ? '✅ 后端已接入，配置已保存。当前会话继续使用原后端。' : '✅ Backend enabled and configuration saved. Your current session keeps its backend.', [[{
        text: locale === 'zh' ? '切换至新后端' : 'Switch to this backend', callback_data: `engine:backend:${id}`,
      }], ...this.rows(locale)], messageId);
    } catch (error) { await this.host.send(scopeId, `❌ ${safeSetupError(error)}`, this.rows(locale), messageId); }
  }
  stop(): void { this.choices.clear(); this.pendingPaths.clear(); }
}

export function safeSetupError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD/.test(key)) message = message.split(value).join('[redacted]');
  }
  return message.slice(-1800);
}
