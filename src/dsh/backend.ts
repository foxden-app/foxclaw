import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { ChannelPort } from '../core/channel_port.js';
import type { BackendDescriptor } from '../core/engine_spi.js';
import { getDshTelegramCommands } from '../i18n.js';
import { DshUi } from './ui.js';

/** Same definition is mounted on a shared bot or on a dedicated DSH bot. */
export function createDshBackend(config: AppConfig, store: BridgeStore, logger: Logger, messaging: ChannelPort): BackendDescriptor {
  const ui = new DshUi(config, store, logger, messaging);
  return {
    id: ui.adapter.id, name: ui.adapter.name, engineType: ui.adapter.id, adapter: ui.adapter,
    defaults: { reasoningEffort: null, supportedReasoningEfforts: [], boost: false, tokenUsage: false },
    commands: getDshTelegramCommands,
    createUi: host => ({
      ownsCallback: data => data.startsWith('dsh:'),
      getPendingApprovals: () => ui.pendingApprovals,
      stop: () => ui.stop(),
      renderCustomStatus: async (scopeId, locale) => ui.status(scopeId, locale),
      renderSetupMenu: async (scopeId, locale, messageId) => { await ui.setup(scopeId, locale, host, messageId); return true; },
      renderModelsMenu: async (scopeId, locale, messageId) => { await ui.models(scopeId, locale, host, messageId); return true; },
      handleCustomCommand: (scopeId, command, args, locale) => ui.command(scopeId, command, args, locale, host),
      handleCustomCallback: (scopeId, data, locale, _messageId, event) => ui.callback(scopeId, data, locale, host, event),
    }),
  };
}
