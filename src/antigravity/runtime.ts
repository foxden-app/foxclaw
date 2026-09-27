import os from 'node:os';
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
import type { SelfUpdateRuntime } from '../update.js';

export interface AntigravityRuntimeOptions {
  botToken?: string | undefined;
  botId?: string | undefined;
  botUsername?: string | undefined;
  sharedDefaultRuntime?: boolean | undefined;
  home?: string | undefined;
  authDir?: string | undefined;
  codexApp?: CodexAppClient | undefined;
  app?: AntigravityAppClient | undefined;
  auth?: AntigravityAuthManager | undefined;
  selfUpdater?: SelfUpdateRuntime | undefined;
}

/** Keeps the optional Antigravity Telegram bot lifecycle decoupled from Codex and OpenCode runtimes. */
export class AntigravityTelegramRuntime {
  private readonly bot: TelegramGateway;
  private readonly app: AntigravityAppClient;
  private readonly auth: AntigravityAuthManager;
  private readonly core: AntigravityBridgeCore;
  private readonly botId: string | null;
  private readonly configuredUsername: string | null;
  private readonly sharedDefaultRuntime: boolean;
  private readonly home: string;
  private readonly authDir: string;

  constructor(
    config: AppConfig,
    store: BridgeStore,
    logger: Logger,
    options?: AntigravityRuntimeOptions,
  ) {
    const token = options?.botToken ?? config.antigravityBotToken;
    if (!token) {
      throw new Error('ANTIGRAVITY_BOT_TOKEN or ANTIGRAVITY_BOT_TOKENS is required for the Antigravity runtime');
    }
    this.bot = new TelegramGateway(
      token,
      config.tgAllowedUserId,
      config.tgAllowedChatId,
      config.telegramPollIntervalMs,
      store,
      logger,
      true,
      getAntigravityTelegramCommands,
    );
    this.botId = options?.botId ?? null;
    this.configuredUsername = options?.botUsername ?? null;
    this.home = options?.home ?? os.homedir();
    this.authDir = options?.authDir ?? config.antigravityAuthDir;
    this.sharedDefaultRuntime =
      options?.sharedDefaultRuntime ??
      (config.antigravityDefaultRuntimeBotToken
        ? config.antigravityDefaultRuntimeBotToken === token
        : true);

    this.auth = options?.auth ?? new AntigravityAuthManager(this.authDir, logger);
    const childEnv = options?.home && !this.sharedDefaultRuntime ? { HOME: options.home } : null;
    this.app = options?.app ?? new AntigravityAppClient(config.antigravityCliBin, logger, childEnv);
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

  get id(): string {
    return this.botId ?? this.bot.identity ?? 'unknown';
  }

  get username(): string | null {
    return this.bot.username ?? this.configuredUsername;
  }

  get isSharedDefaultRuntime(): boolean {
    return this.sharedDefaultRuntime;
  }

  get botHome(): string {
    return this.home;
  }

  get authDirectory(): string {
    return this.authDir;
  }

  async start(): Promise<void> {
    await this.bot.initializeIdentity().catch(() => {});
    await this.bot.resolveUsername().catch(() => {});
    await this.core.start();
  }

  async stop(): Promise<void> {
    await this.core.stop();
  }

  getRuntimeStatus(): ReturnType<AntigravityBridgeCore['getRuntimeStatus']> & {
    id?: string;
    botHome?: string;
    authDir?: string;
    sharedDefaultRuntime?: boolean;
  } {
    const status = this.core.getRuntimeStatus();
    return {
      ...status,
      id: this.id,
      botHome: this.home,
      authDir: this.authDir,
      sharedDefaultRuntime: this.sharedDefaultRuntime,
    };
  }

  get botGateway(): TelegramGateway {
    return this.bot;
  }

  get bridgeCore(): AntigravityBridgeCore {
    return this.core;
  }
}

