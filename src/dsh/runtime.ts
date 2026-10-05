import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import { TelegramGateway } from '../telegram/gateway.js';
import { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import { getDshTelegramCommands } from '../i18n.js';
import { UnifiedChannelOrchestrator } from '../core/orchestrator.js';
import { DshUi } from './ui.js';
import { BRIDGE_SCOPE_TELEGRAM_PREFIX, parseTelegramTargetFromBridgeScope } from '../core/bridge_scope.js';

/** Dedicated DSH bot using the same backend and channel orchestration as other bots. */
export class DshTelegramRuntime {
  private readonly bot: TelegramGateway;
  private readonly ui: DshUi;
  private readonly orchestrator: UnifiedChannelOrchestrator;
  private running = false;

  constructor(config: AppConfig, store: BridgeStore, logger: Logger) {
    if (!config.dshBotToken) throw new Error('DSH_BOT_TOKEN is required');
    this.bot = new TelegramGateway(config.dshBotToken, config.tgAllowedUserId, config.tgAllowedChatId, config.telegramPollIntervalMs, store, logger, true, getDshTelegramCommands);
    const messaging = new TelegramMessagingPort(this.bot);
    this.ui = new DshUi(config, store, logger, messaging);
    this.orchestrator = new UnifiedChannelOrchestrator({
      config, store, logger, bot: this.bot, adapter: this.ui.adapter, messaging,
      ownsScope: scopeId => scopeId.startsWith(BRIDGE_SCOPE_TELEGRAM_PREFIX) && parseTelegramTargetFromBridgeScope(scopeId).botId === this.bot.identity,
      customUi: {
        renderCustomStatus: async (scopeId, locale) => this.ui.status(scopeId, locale),
        renderSetupMenu: async (scopeId, locale, messageId) => { await this.ui.setup(scopeId, locale, this.orchestrator, messageId); return true; },
        renderModelsMenu: async (scopeId, locale, messageId) => { await this.ui.models(scopeId, locale, this.orchestrator, messageId); return true; },
        handleCustomCommand: (scopeId, command, args, locale) => this.ui.command(scopeId, command, args, locale, this.orchestrator),
        handleCustomCallback: (scopeId, data, locale, _messageId, event) => this.ui.callback(scopeId, data, locale, this.orchestrator, event),
      },
    });
    this.orchestrator.registerInboundHandlers();
  }

  async start(): Promise<void> {
    await this.bot.initializeIdentity();
    await this.orchestrator.start();
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.orchestrator.stop();
    await this.ui.stop();
  }

  getRuntimeStatus() {
    return { id: this.bot.identity ?? 'dsh', username: this.bot.username, connected: this.running, activeTurns: this.orchestrator.getActiveTurnsCount(), pendingApprovals: this.ui.pendingApprovals, defaultBackend: 'dsh' as const };
  }
}
