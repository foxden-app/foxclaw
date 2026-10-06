import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { DEFAULT_ENV_PATH, type AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { ChannelPort, ChannelInlineKeyboard } from '../core/channel_port.js';
import type { AppLocale, AccessPresetValue } from '../types.js';
import type { ChannelCallbackEvent } from '../core/channel_events.js';
import type { BackendUiHost } from '../core/backend_ui.js';
import { DshClient, type RequestPermissionRequest, type RequestPermissionResponse } from './client.js';
import { DshEngineAdapter } from './adapter.js';
import { DshCredentials } from './credentials.js';
import type { ChannelTextEvent } from '../core/channel_events.js';

type Action = { scopeId: string; kind: 'model' | 'effort' | 'access' | 'open' | 'page'; value: string; cwd?: string; expires: number };

/** DSH controls shared by the unified bot and the optional dedicated bot. */
export class DshUi {
  private readonly actions = new Map<string, Action>();
  private readonly approvals = new Map<string, { scopeId: string; resolve: (value: RequestPermissionResponse) => void; options: RequestPermissionRequest['options']; messageId: number | null }>();
  readonly adapter: DshEngineAdapter;
  private readonly credentials: DshCredentials;

  get pendingApprovals(): number { return this.approvals.size; }
  get pendingOperations(): number { return this.credentials.pendingOperations; }
  stopPendingOperations(): Promise<void> { return this.credentials.stop(); }

  constructor(private readonly config: AppConfig, private readonly store: BridgeStore, private readonly logger: Logger, private readonly messaging: ChannelPort) {
    if (!config.dsh) throw new Error('DSH backend is not configured');
    const dsh = config.dsh;
    this.credentials = new DshCredentials(dsh, logger);
    this.adapter = new DshEngineAdapter({
      createClient: scopeId => {
        const client = new DshClient(dsh, scopeId, logger);
        client.permissionHandler = (request, signal) => this.requestPermission(scopeId, request, signal);
        client.cancelPermissions = () => {
          for (const pending of this.approvals.values()) if (pending.scopeId === scopeId) pending.resolve({ outcome: { outcome: 'cancelled' } });
        };
        return client;
      },
      preferences: scopeId => {
        const binding = store.getBinding(scopeId);
        const settings = store.getChatSettings(scopeId);
        return { cwd: binding?.cwd || config.defaultCwd, threadId: binding?.threadId || null, model: settings?.model ?? null, effort: settings?.reasoningEffort ?? null, access: settings?.accessPreset ?? this.defaultAccess() };
      },
      bind: (scopeId, id, cwd) => {
        store.setBinding(scopeId, id, cwd);
        const settings = store.getChatSettings(scopeId);
        store.setScopeBackendBinding(scopeId, 'dsh', id, cwd, { model: settings?.model ?? null, reasoningEffort: settings?.reasoningEffort ?? null, accessPreset: settings?.accessPreset ?? this.defaultAccess() });
      },
    });
  }

  private defaultAccess(): AccessPresetValue { return this.config.defaultSandboxMode === 'danger-full-access' ? 'full-access' : this.config.defaultSandboxMode === 'read-only' ? 'read-only' : 'default'; }
  private copy(locale: AppLocale, zh: string, en: string): string { return locale === 'zh' ? zh : en; }
  status(scopeId: string, locale: AppLocale): string {
    const settings = this.store.getChatSettings(scopeId);
    return `• **${this.copy(locale, '推理档位', 'Reasoning')}**: \`${settings?.reasoningEffort ?? 'default'}\`\n• **${this.copy(locale, 'DSH 权限', 'DSH access')}**: \`${settings?.accessPreset ?? this.defaultAccess()}\`\n• **${this.copy(locale, '配置', 'Settings')}**: \`/setup\` · \`/plugins\``;
  }
  private button(scopeId: string, kind: Action['kind'], value: string, text: string, cwd?: string) {
    for (const [key, action] of this.actions) if (action.expires < Date.now()) this.actions.delete(key);
    const key = randomBytes(6).toString('hex');
    this.actions.set(key, { scopeId, kind, value, ...(cwd ? { cwd } : {}), expires: Date.now() + Math.max(this.config.telegramPanelTtlMs, 300000) });
    return { text, callback_data: `dsh:a:${key}` };
  }

  private async panel(scopeId: string, text: string, keyboard: ChannelInlineKeyboard, orchestrator: BackendUiHost, messageId?: number): Promise<void> {
    if (messageId) await orchestrator.editMessage(scopeId, messageId, text, keyboard);
    else messageId = await orchestrator.sendMessage(scopeId, text, keyboard);
    orchestrator.scheduleStalePanelDeletion(scopeId, messageId);
  }

  async setup(scopeId: string, locale: AppLocale, orchestrator: BackendUiHost, messageId?: number): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const binding = this.store.getBinding(scopeId);
    const access = settings?.accessPreset ?? this.defaultAccess();
    const mode = settings?.activeTurnMessageMode ?? 'queue';
    const rows: ChannelInlineKeyboard = [
      [{ text: this.copy(locale, '🎯 模型', '🎯 Model'), callback_data: 'dsh:models' }, { text: this.copy(locale, '🧠 推理档位', '🧠 Reasoning'), callback_data: 'dsh:efforts' }],
      ['read-only', 'default', 'full-access'].map(value => this.button(scopeId, 'access', value, `${access === value ? '✓ ' : ''}${this.copy(locale, value === 'read-only' ? '只读' : value === 'default' ? '工作区写入' : '完全访问', value)}`)),
      [{ text: this.copy(locale, '📁 会话', '📁 Sessions'), callback_data: 'dsh:threads' }, { text: this.copy(locale, '🧩 插件配置', '🧩 Plugins'), callback_data: 'dsh:plugins' }],
      [{ text: mode === 'queue' ? this.copy(locale, '⏳ 排队', '⏳ Queue') : this.copy(locale, '⚡ 中断接管', '⚡ Interrupt & steer'), callback_data: 'engine:setup:active_mode' }],
      [{ text: this.copy(locale, '✨ 新建会话', '✨ New session'), callback_data: 'engine:setup:new' }, { text: this.copy(locale, '🔌 切换后端', '🔌 Backend'), callback_data: 'engine:setup:backend' }],
      [{ text: this.copy(locale, '🔄 刷新', '🔄 Refresh'), callback_data: 'engine:setup:main' }],
    ];
    await this.panel(scopeId, `⚙️ **DeepSeek Harness**\n\n${this.copy(locale, '模型', 'Model')}: \`${settings?.model ?? 'default'}\`\n${this.copy(locale, '推理档位', 'Reasoning')}: \`${settings?.reasoningEffort ?? 'default'}\`\n${this.copy(locale, '权限', 'Access')}: \`${access}\`\n${this.copy(locale, '会话', 'Session')}: \`${binding?.threadId || 'new'}\`\n${this.copy(locale, '工作目录', 'Directory')}: \`${binding?.cwd || this.config.defaultCwd}\``, rows, orchestrator, messageId);
  }

  async models(scopeId: string, locale: AppLocale, orchestrator: BackendUiHost, messageId?: number): Promise<void> {
    const envPath = this.config.envPath || DEFAULT_ENV_PATH;
    const guidance = this.copy(locale,
      `首次使用 DeepSeek：点击“配置 API Key”，在与 Bot 的私聊中添加密钥。保存到 DSH 原生凭据存储，已有凭据直接复用。\n\n如果 \`${envPath}\` 中已设置 DEEPSEEK_API_KEY，则优先使用该环境配置，面板不能覆盖；其他供应商沿用 DSH 原生配置。`,
      `First-time DeepSeek setup: select “Configure API Key” and add your key in a private chat with the bot. Keys are saved in DSH's native credential store; existing credentials are reused.\n\nDEEPSEEK_API_KEY in \`${envPath}\` takes precedence and cannot be overwritten here. Configure other providers through DSH.`);
    const title = this.copy(locale, '🎯 **DSH 模型**', '🎯 **DSH models**');
    const models = await this.adapter.listModels(scopeId).catch(async () => {
      await this.panel(scopeId, `${title}\n\n${this.copy(locale, '暂时无法读取模型列表，请检查 DSH 配置后重试。', 'Model list unavailable. Check DSH configuration and retry.')}\n\n${guidance}`, [
        [{ text: this.copy(locale, '🔑 配置 API Key', '🔑 Configure API Key'), callback_data: 'dsh:credentials' }],
        [{ text: this.copy(locale, '🔄 重试', '🔄 Retry'), callback_data: 'dsh:models' }],
        [{ text: this.copy(locale, '返回设置', 'Back'), callback_data: 'engine:setup:main' }],
      ], orchestrator, messageId);
      return null;
    });
    if (!models) return;
    const current = this.store.getChatSettings(scopeId)?.model;
    const buttons = [this.button(scopeId, 'model', '', this.copy(locale, '默认模型', 'Default model')), ...models.map(model => this.button(scopeId, 'model', model.id, `${model.id === current ? '✓ ' : ''}${model.name}`))];
    const rows: ChannelInlineKeyboard = [];
    for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
    rows.push([{ text: this.copy(locale, '🔑 配置 API Key', '🔑 Configure API Key'), callback_data: 'dsh:credentials' }]);
    rows.push([{ text: this.copy(locale, '返回设置', 'Back'), callback_data: 'engine:setup:main' }]);
    await this.panel(scopeId, `${title}\n\n${guidance}`, rows, orchestrator, messageId);
  }

  private async efforts(scopeId: string, locale: AppLocale, orchestrator: BackendUiHost, messageId?: number): Promise<void> {
    const choices = await this.adapter.listEfforts(scopeId);
    const rows: ChannelInlineKeyboard = [[this.button(scopeId, 'effort', '', this.copy(locale, '默认档位', 'Default effort'))]];
    for (const choice of choices) rows.push([this.button(scopeId, 'effort', choice.value, choice.name)]);
    rows.push([{ text: this.copy(locale, '返回设置', 'Back'), callback_data: 'engine:setup:main' }]);
    await this.panel(scopeId, choices.length ? this.copy(locale, '🧠 **当前模型的推理档位**', '🧠 **Reasoning for this model**') : this.copy(locale, '当前模型未提供可切换的推理档位。', 'This model exposes no reasoning selector.'), rows, orchestrator, messageId);
  }

  private async selectModel(scopeId: string, value: string, orchestrator: BackendUiHost): Promise<void> {
    await this.adapter.selectModel(scopeId, value || null);
    this.store.setChatModel(scopeId, value || null);
    this.store.setChatEffort(scopeId, null);
    this.store.setChatServiceTier(scopeId, null);
    orchestrator.syncCurrentBackendSettings(scopeId);
  }

  private async selectEffort(scopeId: string, value: string, orchestrator: BackendUiHost): Promise<void> {
    await this.adapter.selectEffort(scopeId, value || null);
    this.store.setChatEngineEffort(scopeId, value || null);
    orchestrator.syncCurrentBackendSettings(scopeId);
  }

  private async selectAccess(scopeId: string, value: string, orchestrator: BackendUiHost): Promise<void> {
    if (value !== 'read-only' && value !== 'default' && value !== 'full-access') throw new Error('Use read-only, default, or full-access');
    if (orchestrator.hasActiveTurn(scopeId)) throw new Error('Interrupt the active turn before changing DSH permissions');
    await this.adapter.setAccess(scopeId, value);
    this.store.setChatAccessPreset(scopeId, value);
    orchestrator.syncCurrentBackendSettings(scopeId);
  }

  private async threads(scopeId: string, locale: AppLocale, orchestrator: BackendUiHost, messageId?: number, cursor?: string): Promise<void> {
    const page = await this.adapter.listSessions(scopeId, cursor);
    const rows: ChannelInlineKeyboard = page.sessions.map(session => [this.button(scopeId, 'open', session.sessionId, (session.title || session.sessionId).slice(0, 60), session.cwd)]);
    if (page.nextCursor) rows.push([this.button(scopeId, 'page', page.nextCursor, this.copy(locale, '下一页', 'Next page'))]);
    rows.push([{ text: this.copy(locale, '返回设置', 'Back'), callback_data: 'engine:setup:main' }]);
    await this.panel(scopeId, this.copy(locale, '📁 **DSH 持久会话**', '📁 **Persistent DSH sessions**'), rows, orchestrator, messageId);
  }

  private async open(scopeId: string, id: string, cwd: string | undefined, orchestrator: BackendUiHost): Promise<void> {
    if (orchestrator.hasActiveTurn(scopeId)) throw new Error('Interrupt the active turn before opening another DSH session');
    if (!cwd) {
      let cursor: string | undefined;
      do {
        const page = await this.adapter.listSessions(scopeId, cursor);
        cwd = page.sessions.find(session => session.sessionId === id)?.cwd;
        cursor = page.nextCursor ?? undefined;
      } while (!cwd && cursor);
    }
    if (!cwd) throw new Error('DSH session not found');
    const previous = this.store.getBinding(scopeId);
    this.store.setBinding(scopeId, id, cwd);
    try { await this.adapter.sessionForScope(scopeId); }
    catch (error) {
      if (previous) this.store.setBinding(scopeId, previous.threadId, previous.cwd);
      else this.store.clearBinding(scopeId);
      throw error;
    }
    orchestrator.syncCurrentBackendSettings(scopeId);
  }

  private async plugins(scopeId: string, locale: AppLocale, orchestrator: BackendUiHost): Promise<void> {
    const dsh = this.config.dsh!;
    const home = dsh.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    let dependencies: Record<string, unknown> = {};
    try {
      const manifest: unknown = JSON.parse(await fs.readFile(path.join(home, 'profiles', dsh.profile, 'package.json'), 'utf8'));
      if (typeof manifest === 'object' && manifest !== null && 'dependencies' in manifest && typeof manifest.dependencies === 'object' && manifest.dependencies !== null) dependencies = manifest.dependencies as Record<string, unknown>;
    } catch (error) { this.logger.debug('dsh.plugin_manifest_unavailable', { error: String(error) }); }
    await orchestrator.sendMessage(scopeId, `🧩 **DSH ${this.copy(locale, '插件配置', 'plugin configuration')}**\n\nProfile: \`${dsh.profile}\`\n${Object.entries(dependencies).map(([name, version]) => `• ${name}: ${String(version)}`).join('\n') || this.copy(locale, 'Profile 尚未初始化或没有显式依赖。', 'Profile is not initialized or has no explicit dependencies.')}\n• foxclaw-permissions\n\n${this.copy(locale, '已配置补丁', 'Configured patches')}:\n${dsh.patches.map(patch => `• ${patch}`).join('\n') || '—'}\n\n${this.copy(locale, '安装/移除插件请在终端执行，随后重启 foxclaw', 'Install/remove plugins in a terminal, then restart foxclaw')}:\n\`dsh plugin --profile ${dsh.profile} add <package>\`\n\`dsh plugin --profile ${dsh.profile} remove <package>\``);
  }

  async command(scopeId: string, command: string, args: string, locale: AppLocale, orchestrator: BackendUiHost): Promise<boolean> {
    try {
      switch (command) {
        case 'cancel': await orchestrator.sendMessage(scopeId, this.copy(locale, '配置输入已取消。', 'Configuration input cancelled.')); return true;
        case 'setup': await this.setup(scopeId, locale, orchestrator); return true;
        case 'models': await this.models(scopeId, locale, orchestrator); return true;
        case 'model': if (args) { await this.selectModel(scopeId, args === 'default' ? '' : args, orchestrator); await this.setup(scopeId, locale, orchestrator); } else await this.models(scopeId, locale, orchestrator); return true;
        case 'effort': if (args) { await this.selectEffort(scopeId, args === 'default' ? '' : args, orchestrator); await this.setup(scopeId, locale, orchestrator); } else await this.efforts(scopeId, locale, orchestrator); return true;
        case 'access': case 'permissions': if (args) await this.selectAccess(scopeId, args, orchestrator); await this.setup(scopeId, locale, orchestrator); return true;
        case 'threads': await this.threads(scopeId, locale, orchestrator); return true;
        case 'open': if (args) { await this.open(scopeId, args, undefined, orchestrator); await this.setup(scopeId, locale, orchestrator); } else await this.threads(scopeId, locale, orchestrator); return true;
        case 'plugins': await this.plugins(scopeId, locale, orchestrator); return true;
        case 'where': case 'config': await this.setup(scopeId, locale, orchestrator); return true;
        case 'update': await orchestrator.sendMessage(scopeId, this.copy(locale, '请在终端执行 `foxclaw update` 升级此独立 DSH Bot。', 'Run `foxclaw update` in a terminal to upgrade this dedicated DSH bot.')); return true;
        case 'help': case 'start':
          await orchestrator.sendMessage(scopeId, this.copy(locale, '**DSH 命令**\n/setup · 设置\n/models · 模型\n/model <provider/model|default>\n/effort [档位|default]\n/permissions [read-only|default|full-access]\n/threads · 持久会话\n/open <会话 ID>\n/new [目录] · 新建\n/interrupt · 中断\n/active <queue|steer>\n/plugins · 插件配置\n/backend · 切换后端\n/status · 状态', '**DSH commands**\n/setup · Settings\n/models · Models\n/model <provider/model|default>\n/effort [level|default]\n/permissions [read-only|default|full-access]\n/threads · Persistent sessions\n/open <session ID>\n/new [directory]\n/interrupt\n/active <queue|steer>\n/plugins · Plugin configuration\n/backend\n/status')); return true;
        case 'backend': case 'backends': case 'engine': case 'engines': case 'status': case 'active': case 'queue': case 'steer': case 'interrupt': case 'stop': case 'abort': case 'new': case 'clear': return false;
        default: await orchestrator.sendMessage(scopeId, this.copy(locale, `DSH 的 ACP 接口未提供 /${command}。发送 /help 查看可用操作。`, `DSH ACP does not expose /${command}. Send /help for available commands.`)); return true;
      }
    } catch (error) { await orchestrator.sendMessage(scopeId, `⚠️ ${error instanceof Error ? error.message : String(error)}`); return true; }
  }

  async callback(scopeId: string, data: string, locale: AppLocale, orchestrator: BackendUiHost, event?: ChannelCallbackEvent): Promise<boolean> {
    this.clearKeyInput(scopeId);
    const answer = (text = '') => this.messaging.answerCallback(event?.callbackQueryId ?? '', text);
    if (!data.startsWith('dsh:')) {
      if (orchestrator.getBackendDescriptorForScope(scopeId).engineType === 'dsh' && data.startsWith('engine:') && !['engine:setup:main', 'engine:setup:models', 'engine:setup:active_mode', 'engine:setup:new', 'engine:setup:backend'].includes(data) && !data.startsWith('engine:backend:')) {
        await answer(this.copy(locale, '请重新打开 DSH 设置', 'Open DSH settings again'));
        return true;
      }
      return false;
    }
    if (data.startsWith('dsh:p:')) {
      const [, , key, index] = data.split(':');
      const pending = this.approvals.get(key!);
      const option = pending?.options[Number(index)];
      if (!pending || pending.scopeId !== scopeId || !option) { await answer(this.copy(locale, '审批已失效', 'Approval expired')); return true; }
      pending.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } });
      await answer(this.copy(locale, '已提交', 'Submitted'));
      return true;
    }
    if (orchestrator.getBackendDescriptorForScope(scopeId).engineType !== 'dsh') { await answer(this.copy(locale, '请先切换到 DSH', 'Switch to DSH first')); return true; }
    await answer();
    try {
      if (data === 'dsh:credentials' || data === 'dsh:credentials:add') {
        if (!event || event.chatId !== event.userId) {
          await orchestrator.sendMessage(scopeId, this.copy(locale, '请在与 Bot 的私聊中配置 API Key。', 'Configure API keys in a private chat with the bot.'));
          return true;
        }
        const info = await this.credentials.describe();
        if (data === 'dsh:credentials:add' && info.writable) {
          this.store.setServiceInteraction(scopeId, 'sensitive-input', JSON.stringify({ owner: 'dsh:api-key', expires: Date.now() + 5 * 60_000 }));
          await this.panel(scopeId, this.copy(locale, '🔑 发送 DeepSeek API Key（仅密钥本身）。\n输入消息会尝试删除，密钥不会进入模型或任务记录。保存后本机所有 DSH 会话共用；不会发起付费请求验证。\n发送 /cancel 或点击返回取消。', '🔑 Send your DeepSeek API Key only.\nWe will attempt to delete the input message; it will not enter models or task records. Local DSH sessions share the stored key. No paid validation request is made.\nSend /cancel or select Back to cancel.'), [[{ text: this.copy(locale, '返回模型', 'Back to models'), callback_data: 'dsh:models' }]], orchestrator, event.messageId);
        } else {
          const keyboard: ChannelInlineKeyboard = [];
          if (info.writable) keyboard.push([{ text: this.copy(locale, info.configured ? '更新 API Key' : '添加 API Key', info.configured ? 'Update API Key' : 'Add API Key'), callback_data: 'dsh:credentials:add' }]);
          keyboard.push([{ text: this.copy(locale, '返回模型', 'Back to models'), callback_data: 'dsh:models' }]);
          await this.panel(scopeId, `🔑 **DeepSeek API Key**\n\n${this.copy(locale, info.configured ? '状态：已配置' : '状态：未配置', info.configured ? 'Status: configured' : 'Status: not configured')}\n${info.writable ? this.copy(locale, '由 DSH 保存，可从此面板添加或更新。', 'DSH stores the key; add or update it here.') : this.copy(locale, '来自启动环境，只读。请移除对应环境变量并重启后再使用面板管理。', 'Supplied by the launch environment, read-only. Remove that variable and restart to manage the key here.')}`, keyboard, orchestrator, event.messageId);
        }
      } else if (data === 'dsh:models') await this.models(scopeId, locale, orchestrator, event?.messageId);
      else if (data === 'dsh:efforts') await this.efforts(scopeId, locale, orchestrator, event?.messageId);
      else if (data === 'dsh:threads') await this.threads(scopeId, locale, orchestrator, event?.messageId);
      else if (data === 'dsh:plugins') await this.plugins(scopeId, locale, orchestrator);
      else if (data.startsWith('dsh:a:')) {
        const action = this.actions.get(data.slice(6));
        if (!action || action.scopeId !== scopeId || action.expires < Date.now()) throw new Error(this.copy(locale, '面板已失效，请重新打开 /setup', 'Panel expired; open /setup again'));
        if (action.kind === 'model') await this.selectModel(scopeId, action.value, orchestrator);
        else if (action.kind === 'effort') await this.selectEffort(scopeId, action.value, orchestrator);
        else if (action.kind === 'access') await this.selectAccess(scopeId, action.value, orchestrator);
        else if (action.kind === 'open') await this.open(scopeId, action.value, action.cwd, orchestrator);
        else if (action.kind === 'page') { await this.threads(scopeId, locale, orchestrator, event?.messageId, action.value); return true; }
        await this.setup(scopeId, locale, orchestrator, event?.messageId);
      }
    } catch (error) { await orchestrator.sendMessage(scopeId, `⚠️ ${error instanceof Error ? error.message : String(error)}`); }
    return true;
  }

  private async requestPermission(scopeId: string, request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const key = randomBytes(6).toString('hex');
    const locale = this.store.getChatSettings(scopeId)?.locale ?? 'zh';
    let settle!: (value: RequestPermissionResponse) => void;
    const result = new Promise<RequestPermissionResponse>(resolve => { settle = resolve; });
    const pending = { scopeId, resolve: settle, options: request.options, messageId: null as number | null };
    this.approvals.set(key, pending);
    const abort = () => settle({ outcome: { outcome: 'cancelled' } });
    signal.addEventListener('abort', abort, { once: true });
    try {
      pending.messageId = await this.messaging.sendRichMarkdown(scopeId, `${this.copy(locale, '🔐 **DSH 请求审批**', '🔐 **DSH permission request**')}\n\`${request.toolCall.title || request.toolCall.toolCallId}\``, [request.options.map((option, index) => ({ text: option.kind === 'allow_once' ? this.copy(locale, '允许本次', 'Allow once') : option.kind === 'reject_once' ? this.copy(locale, '拒绝', 'Reject') : option.name, callback_data: `dsh:p:${key}:${index}` }))]);
      return await result;
    } catch (error) { this.logger.warn('dsh.approval_delivery_failed', { error: String(error) }); return { outcome: { outcome: 'cancelled' } }; }
    finally {
      this.approvals.delete(key);
      signal.removeEventListener('abort', abort);
      if (pending.messageId) await this.messaging.editRichMarkdown(scopeId, pending.messageId, this.copy(locale, '🔐 DSH 审批已结束。', '🔐 DSH permission request resolved.'), []).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    for (const pending of this.approvals.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
    this.actions.clear();
    await this.credentials.stop();
    await this.adapter.stop();
  }

  isSensitiveInbound(event: ChannelTextEvent): boolean {
    if (!this.keyInput(event.scopeId)) return false;
    if (event.text.trim().startsWith('/')) { this.clearKeyInput(event.scopeId); return false; }
    return true;
  }

  inbound(event: ChannelTextEvent, locale: AppLocale, host: BackendUiHost): boolean | Promise<boolean> {
    if (!this.isSensitiveInbound(event)) return false;
    return this.saveKey(event, locale, host);
  }

  private async saveKey(event: ChannelTextEvent, locale: AppLocale, host: BackendUiHost): Promise<boolean> {
    const saved = this.keyInput(event.scopeId);
    this.clearKeyInput(event.scopeId);
    await this.messaging.deleteMessage(event.scopeId, event.messageId).catch(() => {});
    const key = event.text.trim();
    const expires = saved?.expires ?? 0;
    if (event.chatType !== 'private' || expires < Date.now() || event.attachments.length || key.length < 8 || !/^[!-~]+$/.test(key)) {
      await host.sendMessage(event.scopeId, this.copy(locale, '输入已过期或格式不正确，请从模型面板重新添加 API Key。', 'Input expired or invalid. Reopen the model panel to add a key.'), [[{ text: this.copy(locale, '配置 API Key', 'Configure API Key'), callback_data: 'dsh:credentials' }]]);
      return true;
    }
    try {
      await this.credentials.set(key);
      await host.sendMessage(event.scopeId, this.copy(locale, '✅ API Key 已保存到 DSH。无需重启，下一次模型请求使用新凭据；尚未验证密钥是否有效。', '✅ API Key saved in DSH. No restart is needed; the next model request uses it. Key validity has not been tested.'), [[{ text: this.copy(locale, '返回模型选择', 'Choose model'), callback_data: 'dsh:models' }]]);
    } catch {
      await host.sendMessage(event.scopeId, this.copy(locale, '无法保存 API Key，请检查 DSH 凭据存储及环境覆盖后重试。', 'Cannot save the key. Check DSH credential storage and environment overrides, then retry.'), [[{ text: this.copy(locale, '配置 API Key', 'Configure API Key'), callback_data: 'dsh:credentials' }]]);
    }
    return true;
  }

  private clearKeyInput(scopeId: string): void {
    const state = this.store.getServiceInteraction(scopeId, 'sensitive-input');
    if (state) {
      try { if ((JSON.parse(state) as { owner?: string }).owner === 'dsh:api-key') this.store.setServiceInteraction(scopeId, 'sensitive-input', null); }
      catch { /* Another administrative interaction owns its own marker. */ }
    }
  }

  private keyInput(scopeId: string): { expires: number } | null {
    const text = this.store.getServiceInteraction(scopeId, 'sensitive-input');
    if (!text) return null;
    try {
      const value = JSON.parse(text) as { owner?: unknown; expires?: unknown };
      return value.owner === 'dsh:api-key' && typeof value.expires === 'number' && Number.isFinite(value.expires) ? { expires: value.expires } : null;
    } catch { return null; }
  }
}
