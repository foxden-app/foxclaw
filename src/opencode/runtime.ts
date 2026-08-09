import type { AppConfig } from '../config.js';
import { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import { getOpencodeTelegramCommands } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import { TelegramGateway } from '../telegram/gateway.js';
import { OpencodeAppClient } from './client.js';
import { OpencodeBridgeCore } from './controller.js';

/** Keeps the optional OpenCode Telegram bot lifecycle out of the Codex runtime branches. */
export class OpencodeTelegramRuntime {
  private readonly bot: TelegramGateway;
  private readonly app: OpencodeAppClient;
  private readonly core: OpencodeBridgeCore;

  constructor(config: AppConfig, store: BridgeStore, logger: Logger) {
    if (!config.opencodeBotToken) throw new Error('OPENCODE_BOT_TOKEN is required for the OpenCode runtime');
    this.bot = new TelegramGateway(
      config.opencodeBotToken,
      config.tgAllowedUserId,
      config.tgAllowedChatId,
      config.telegramPollIntervalMs,
      store,
      logger,
      true,
      getOpencodeTelegramCommands,
    );
    this.app = new OpencodeAppClient(
      config.opencodeCliBin,
      config.opencodeServerPassword,
      config.opencodeServerStatePath,
      config.opencodeServerLogPath,
      logger,
    );
    this.core = new OpencodeBridgeCore(
      config,
      store,
      logger,
      this.bot,
      this.app,
      new TelegramMessagingPort(this.bot),
    );
    this.core.registerInboundHandlers();
  }

  async start(): Promise<void> {
    await this.bot.initializeIdentity();
    await this.core.start();
  }

  async stop(): Promise<void> {
    await this.core.stop();
  }

  getRuntimeStatus(): ReturnType<OpencodeBridgeCore['getRuntimeStatus']> {
    return this.core.getRuntimeStatus();
  }
}
