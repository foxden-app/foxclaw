import type { BackendUi, BackendUiHost } from '../core/backend_ui.js';
import type { BridgeSessionCore } from '../controller/controller.js';
import type { ChannelTextEvent } from '../core/channel_events.js';

const nativeCallbacks = /^(thread:|auth:|settings:|setup:|nav:|approval:|ui:|mcpel:|login:|config:|voice:)/;
const pendingCallbacks = /^(approval:|ui:|mcpel:|login:)/;
const commands = new Set(['threads', 'open', 'auth', 'login_device', 'login_cancel', 'logout', 'permissions', 'access',
  'skills', 'skill', 'skill_enable', 'skill_disable', 'hooks', 'plugins', 'plugin', 'plugin_skill', 'apps', 'features',
  'config', 'requirements', 'provider', 'mcp', 'mcp_reload', 'mcp_login', 'mcp_resource', 'approve', 'deny', 'answer', 'mcpel']);

/** Native Codex controls own their RPC subscriptions; execution remains owned by the orchestrator. */
export function createCodexBackendUi(core: BridgeSessionCore, host: BackendUiHost, fallback: BackendUi): BackendUi {
  return {
    ...fallback,
    ownsCallback: data => nativeCallbacks.test(data) || data.startsWith('codex:'),
    getPendingApprovals: () => core.getPendingApprovalCount(),
    stop: () => core.stopControlPlane(),
    handleCustomInbound: async (event, locale) => {
      if (core.hasPendingInteraction(event.scopeId)) { await core.dispatchBackendCommand(event); return true; }
      return await fallback.handleCustomInbound?.(event, locale) ?? false;
    },
    handleCustomCommand: async (scopeId, command, args, locale, event) => {
      if (!commands.has(command)) return await fallback.handleCustomCommand?.(scopeId, command, args, locale, event) ?? false;
      if (['open', 'logout'].includes(command) && host.hasActiveTurn(scopeId)) {
        await host.sendMessage(scopeId, locale === 'zh' ? '请先结束当前任务。' : 'Finish the active task first.'); return true;
      }
      const inbound: ChannelTextEvent = event ?? { scopeId, chatId: scopeId, topicId: null, chatType: 'private', userId: 'system',
        messageId: 0, text: `/${command} ${args}`, attachments: [], entities: [], replyToBot: false };
      await core.dispatchBackendCommand(inbound);
      host.syncCurrentBackendSettings(scopeId);
      return true;
    },
    handleCustomCallback: async (scopeId, data, locale, messageId, event) => {
      if (!nativeCallbacks.test(data) || !event) return await fallback.handleCustomCallback?.(scopeId, data, locale, messageId, event) ?? false;
      if (!pendingCallbacks.test(data) && host.getBackendDescriptorForScope(scopeId).engineType !== 'codex') return true;
      if (data.startsWith('thread:') && host.hasActiveTurn(scopeId)) {
        await host.sendMessage(scopeId, locale === 'zh' ? '请先结束当前任务。' : 'Finish the active task first.'); return true;
      }
      await core.handleCallback(event);
      if (!pendingCallbacks.test(data)) host.syncCurrentBackendSettings(scopeId);
      return true;
    },
  };
}
