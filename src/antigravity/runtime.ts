import type { AppConfig } from '../config.js';
import { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import { getAntigravityTelegramCommands } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import { TelegramGateway } from '../telegram/gateway.js';
import { AntigravityAppClient } from './client.js';
import { AntigravityAuthManager } from './auth.js';
import { AntigravityBridgeCore } from './controller.js';
import type { CodexAppClient } from '../codex_app/client.js';

/** Keeps the optional Antigravity Telegram bot lifecycle decoupled from Codex and OpenCode runtimes. */
export class AntigravityTelegramRuntime {
  private readonly bot: TelegramGateway;
  private readonly app: AntigravityAppClient;
  private readonly auth: AntigravityAuthManager;
  private readonly core: AntigravityBridgeCore;

  constructor(
    config: AppConfig,
    store: BridgeStore,
    logger: Logger,
    options?: {
      codexApp?: CodexAppClient | undefined;
      app?: AntigravityAppClient | undefined;
      auth?: AntigravityAuthManager | undefined;
    },
  ) {
    if (!config.antigravityBotToken) {
      throw new Error('ANTIGRAVITY_BOT_TOKEN is required for the Antigravity runtime');
    }
    this.bot = new TelegramGateway(
      config.antigravityBotToken,
      config.tgAllowedUserId,
      config.tgAllowedChatId,
      config.telegramPollIntervalMs,
      store,
      logger,
      true,
      getAntigravityTelegramCommands,
    );
    this.auth = options?.auth ?? new AntigravityAuthManager(config.antigravityAuthDir, logger);
    this.app = options?.app ?? new AntigravityAppClient(config.antigravityCliBin, logger);
    this.core = new AntigravityBridgeCore(
      config,
      store,
      logger,
      this.bot,
      this.app,
      this.auth,
      new TelegramMessagingPort(this.bot),
      {
        ...options,
        defaultBackendId: 'antigravity',
      },
    );
    this.core.registerInboundHandlers();
  }

  async start(): Promise<void> {
    await this.bot.resolveUsername();
    await this.core.start();
  }

  async stop(): Promise<void> {
    await this.core.stop();
  }

  getRuntimeStatus(): ReturnType<AntigravityBridgeCore['getRuntimeStatus']> {
    return this.core.getRuntimeStatus();
  }

  get botGateway(): TelegramGateway {
    return this.bot;
  }

  get bridgeCore(): AntigravityBridgeCore {
    return this.core;
  }
}

