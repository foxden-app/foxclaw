import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import { TelegramGateway } from '../telegram/gateway.js';
import { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import { getDshTelegramCommands } from '../i18n.js';
import { UnifiedChannelOrchestrator } from '../core/orchestrator.js';
import { createDshBackend } from './backend.js';
import { BRIDGE_SCOPE_TELEGRAM_PREFIX, parseTelegramTargetFromBridgeScope } from '../core/bridge_scope.js';

/** Dedicated DSH bot using the same backend and channel orchestration as other bots. */
export class DshTelegramRuntime {
  private readonly bot: TelegramGateway;
  private readonly orchestrator: UnifiedChannelOrchestrator;
  private running = false;

  constructor(config: AppConfig, store: BridgeStore, logger: Logger) {
    if (!config.dshBotToken) throw new Error('DSH_BOT_TOKEN is required');
    this.bot = new TelegramGateway(config.dshBotToken, config.tgAllowedUserId, config.tgAllowedChatId, config.telegramPollIntervalMs, store, logger, true, getDshTelegramCommands);
    const messaging = new TelegramMessagingPort(this.bot);
    const backend = createDshBackend(config, store, logger, messaging);
    this.orchestrator = new UnifiedChannelOrchestrator({
      config, store, logger, bot: this.bot, backends: [backend], defaultBackendId: backend.id, messaging,
      ownsScope: scopeId => scopeId.startsWith(BRIDGE_SCOPE_TELEGRAM_PREFIX) && parseTelegramTargetFromBridgeScope(scopeId).botId === this.bot.identity,
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
  }

  getRuntimeStatus() {
    return { id: this.bot.identity ?? 'dsh', username: this.bot.username, connected: this.running, activeTurns: this.orchestrator.getActiveTurnsCount(), pendingApprovals: this.orchestrator.getPendingApprovals(), defaultBackend: 'dsh' as const };
  }
}
