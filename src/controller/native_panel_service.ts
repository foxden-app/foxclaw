import type { AppLocale, CodexSkillsListEntry } from '../types.js';
import {
  formatLoadedThreadsMessage,
  formatSkillsMessage,
  findSkill,
  formatSkillDetailMessage,
  formatHooksMessage,
  formatPluginsMessage,
  formatPluginDetailMessage,
  formatPluginSkillMessage,
  formatAppsMessage,
  formatFeaturesMessage,
  parseConfigBooleanArg,
  formatConfigMessage,
  configKeyboard,
  writeEnvBoolean,
  formatRequirementsMessage,
  formatProviderMessage,
  formatMcpStatusMessage,
  formatMcpResourceMessage,
} from './native_panels.js';
import { t } from '../i18n.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import { toErrorMeta, formatUserError } from './shared_helpers.js';
import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { CodexAppClient } from '../codex_app/client.js';
import type { ChannelInlineKeyboard } from '../core/channel_port.js';
export interface NativePanelUi { sendMessage(scopeId: string, text: string, keyboard?: ChannelInlineKeyboard): Promise<number>; editMessage(scopeId: string, messageId: number, text: string, keyboard?: ChannelInlineKeyboard): Promise<void>; scheduleStalePanelDeletion(scopeId: string, messageId: number): void; answerCallback(id: string, text: string): Promise<void>; }

export class CodexNativePanelService {

  constructor(private readonly config: AppConfig, private readonly store: BridgeStore, private readonly logger: Logger, private readonly app: CodexAppClient, private readonly ui: NativePanelUi) {}

  async handleLoadedCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const threadIds = await this.app.listLoadedThreads();
    await this.ui.sendMessage(scopeId, formatLoadedThreadsMessage(locale, threadIds));
  }

  async handleSkillsCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const forceReload = args[0]?.toLowerCase() === 'reload';
    const query = (forceReload ? args.slice(1) : args).join(' ').trim();
    const entries = await this.listSkillsForScope(scopeId, forceReload);
    await this.ui.sendMessage(scopeId, formatSkillsMessage(locale, entries, query || null, forceReload));
  }

  async handleSkillCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.ui.sendMessage(scopeId, t(locale, 'usage_skill'));
      return;
    }
    const skill = findSkill(await this.listSkillsForScope(scopeId, false), name);
    if (!skill) {
      await this.ui.sendMessage(scopeId, t(locale, 'skill_not_found', { name }));
      return;
    }
    await this.ui.sendMessage(scopeId, formatSkillDetailMessage(locale, skill));
  }

  async handleSkillConfigCommand(scopeId: string, locale: AppLocale, args: string[], enabled: boolean): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.ui.sendMessage(scopeId, enabled ? t(locale, 'usage_skill_enable') : t(locale, 'usage_skill_disable'));
      return;
    }
    await this.app.writeSkillConfig({ name }, enabled);
    await this.ui.sendMessage(scopeId, t(locale, enabled ? 'skill_enabled' : 'skill_disabled', { name }));
  }

  async handleHooksCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const entries = await this.app.listHooks(binding?.cwd ?? this.config.defaultCwd);
    await this.ui.sendMessage(scopeId, formatHooksMessage(locale, entries));
  }

  async handlePluginsCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const query = args.join(' ').trim() || null;
    const binding = this.store.getBinding(scopeId);
    const marketplaces = await this.app.listPlugins(binding?.cwd ?? this.config.defaultCwd);
    await this.ui.sendMessage(scopeId, formatPluginsMessage(locale, marketplaces, query));
  }

  async handlePluginCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.ui.sendMessage(scopeId, t(locale, 'usage_plugin'));
      return;
    }
    const plugin = await this.app.readPlugin(name);
    if (!plugin) {
      await this.ui.sendMessage(scopeId, t(locale, 'plugin_not_found', { name }));
      return;
    }
    await this.ui.sendMessage(scopeId, formatPluginDetailMessage(locale, plugin));
  }

  async handlePluginSkillCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const [marketplace, plugin, ...skillParts] = args;
    const skill = skillParts.join(' ').trim();
    if (!marketplace || !plugin || !skill) {
      await this.ui.sendMessage(scopeId, t(locale, 'usage_plugin_skill'));
      return;
    }
    const contents = await this.app.readPluginSkill(marketplace, plugin, skill);
    await this.ui.sendMessage(scopeId, formatPluginSkillMessage(locale, marketplace, plugin, skill, contents));
  }

  async handleAppsCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const forceRefetch = args[0]?.toLowerCase() === 'reload';
    const binding = this.store.getBinding(scopeId);
    const apps = await this.app.listApps(binding?.threadId ?? null, forceRefetch);
    await this.ui.sendMessage(scopeId, formatAppsMessage(locale, apps, forceRefetch));
  }

  async handleFeaturesCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const features = await this.app.listExperimentalFeatures();
    await this.ui.sendMessage(scopeId, formatFeaturesMessage(locale, features));
  }

  async handleConfigCommand(scopeId: string, locale: AppLocale, args: string[] = []): Promise<void> {
    const action = args[0]?.toLowerCase() ?? '';
    if (['auth_auto_delete', 'auth-auto-delete', 'auto_delete_needs_repair', 'auto-delete-needs-repair'].includes(action)) {
      const enabled = parseConfigBooleanArg(args[1]);
      if (enabled === null) {
        await this.ui.sendMessage(scopeId, t(locale, 'config_auth_auto_delete_usage'));
        return;
      }
      const update = await this.setFoxClawBooleanConfig('auth_auto_delete', enabled);
      const binding = this.store.getBinding(scopeId);
      const result = await this.app.readConfig(binding?.cwd ?? this.config.defaultCwd, true);
      const sentMessageId = await this.ui.sendMessage(
        scopeId,
        `${this.formatConfigToggleUpdate(locale, update)}\n\n${formatConfigMessage(locale, result, this.config, this.store.getCodexAuthPoolStats())}`,
        configKeyboard(locale, this.config),
      );
      this.ui.scheduleStalePanelDeletion(scopeId, sentMessageId);
      return;
    }
    if (['delete_tool_details', 'delete-tool-details', 'tool_details', 'tool-details'].includes(action)) {
      const enabled = parseConfigBooleanArg(args[1]);
      if (enabled === null) {
        await this.ui.sendMessage(scopeId, t(locale, 'config_delete_tool_details_usage'));
        return;
      }
      const update = await this.setFoxClawBooleanConfig('delete_tool_details', enabled);
      const binding = this.store.getBinding(scopeId);
      const result = await this.app.readConfig(binding?.cwd ?? this.config.defaultCwd, true);
      const sentMessageId = await this.ui.sendMessage(
        scopeId,
        `${this.formatConfigToggleUpdate(locale, update)}\n\n${formatConfigMessage(locale, result, this.config, this.store.getCodexAuthPoolStats())}`,
        configKeyboard(locale, this.config),
      );
      this.ui.scheduleStalePanelDeletion(scopeId, sentMessageId);
      return;
    }
    const binding = this.store.getBinding(scopeId);
    const result = await this.app.readConfig(binding?.cwd ?? this.config.defaultCwd, true);
    const sentMessageId = await this.ui.sendMessage(scopeId, formatConfigMessage(locale, result, this.config, this.store.getCodexAuthPoolStats()), configKeyboard(locale, this.config));
    this.ui.scheduleStalePanelDeletion(scopeId, sentMessageId);
  }

  async handleConfigToggleCallback(
    event: TelegramCallbackEvent,
    key: 'auth_auto_delete' | 'delete_tool_details',
    enabled: boolean,
    locale: AppLocale,
  ): Promise<void> {
    const update = await this.setFoxClawBooleanConfig(key, enabled);
    await this.ui.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    const binding = this.store.getBinding(event.scopeId);
    const result = await this.app.readConfig(binding?.cwd ?? this.config.defaultCwd, true);
    const message = `${this.formatConfigToggleUpdate(locale, update)}\n\n${formatConfigMessage(locale, result, this.config, this.store.getCodexAuthPoolStats())}`;
    if (event.messageId !== null) {
      await this.ui.editMessage(event.scopeId, event.messageId, message, configKeyboard(locale, this.config));
      this.ui.scheduleStalePanelDeletion(event.scopeId, event.messageId);
    } else {
      const sentMessageId = await this.ui.sendMessage(event.scopeId, message, configKeyboard(locale, this.config));
      this.ui.scheduleStalePanelDeletion(event.scopeId, sentMessageId);
    }
  }

  async setFoxClawBooleanConfig(
    key: 'auth_auto_delete' | 'delete_tool_details',
    enabled: boolean,
  ): Promise<{ key: 'auth_auto_delete' | 'delete_tool_details'; enabled: boolean; envKey: string; envPath: string | null; envUpdated: boolean; envError: string | null }> {
    const envKey = key === 'auth_auto_delete'
      ? 'AUTH_AUTO_DELETE_NEEDS_REPAIR'
      : 'TELEGRAM_DELETE_TOOL_DETAILS_AFTER_FINAL';
    if (key === 'auth_auto_delete') {
      this.config.authAutoDeleteNeedsRepair = enabled;
    } else {
      this.config.telegramDeleteToolDetailsAfterFinal = enabled;
    }
    const envPath = this.config.envPath;
    if (!envPath) {
      return { key, enabled, envKey, envPath: null, envUpdated: false, envError: null };
    }
    try {
      await writeEnvBoolean(envPath, envKey, enabled);
      return { key, enabled, envKey, envPath, envUpdated: true, envError: null };
    } catch (error) {
      this.logger.warn('config.env_update_failed', { key: envKey, envPath, error: toErrorMeta(error) });
      return { key, enabled, envKey, envPath, envUpdated: false, envError: formatUserError(error) };
    }
  }

  formatConfigToggleUpdate(
    locale: AppLocale,
    update: { key: 'auth_auto_delete' | 'delete_tool_details'; enabled: boolean; envPath: string | null; envUpdated: boolean; envError: string | null },
  ): string {
    const lines = [t(locale, update.key === 'auth_auto_delete' ? 'config_auth_auto_delete_updated' : 'config_delete_tool_details_updated', {
      value: t(locale, update.enabled ? 'yes' : 'no'),
    })];
    if (update.envError) {
      lines.push(t(locale, 'config_env_update_failed', { value: update.envPath ?? t(locale, 'unknown'), error: update.envError }));
    }
    return lines.join('\n');
  }

  async handleRequirementsCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const requirements = await this.app.readConfigRequirements();
    await this.ui.sendMessage(scopeId, formatRequirementsMessage(locale, requirements));
  }

  async handleProviderCommand(scopeId: string, locale: AppLocale): Promise<void> {
    const capabilities = await this.app.readModelProviderCapabilities();
    await this.ui.sendMessage(scopeId, formatProviderMessage(locale, capabilities));
  }

  async handleMcpCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const detail = args[0]?.toLowerCase() === 'brief' ? 'toolsAndAuthOnly' : 'full';
    const statuses = await this.app.listMcpServerStatus(detail);
    await this.ui.sendMessage(scopeId, formatMcpStatusMessage(locale, statuses));
  }

  async handleMcpReloadCommand(scopeId: string, locale: AppLocale): Promise<void> {
    await this.app.reloadMcpServers();
    await this.ui.sendMessage(scopeId, t(locale, 'mcp_reload_done'));
  }

  async handleMcpLoginCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      await this.ui.sendMessage(scopeId, t(locale, 'usage_mcp_login'));
      return;
    }
    const url = await this.app.loginMcpServer(name);
    await this.ui.sendMessage(scopeId, t(locale, 'mcp_login_started', { name, url: url || t(locale, 'unknown') }));
  }

  async handleMcpResourceCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const [server, ...uriParts] = args;
    const uri = uriParts.join(' ').trim();
    if (!server || !uri) {
      await this.ui.sendMessage(scopeId, t(locale, 'usage_mcp_resource'));
      return;
    }
    const binding = this.store.getBinding(scopeId);
    const contents = await this.app.readMcpResource(server, uri, binding?.threadId ?? null);
    await this.ui.sendMessage(scopeId, formatMcpResourceMessage(locale, server, uri, contents));
  }

  async listSkillsForScope(scopeId: string, forceReload: boolean): Promise<CodexSkillsListEntry[]> {
    const binding = this.store.getBinding(scopeId);
    return this.app.listSkills(binding?.cwd ?? this.config.defaultCwd, forceReload);
  }
}
