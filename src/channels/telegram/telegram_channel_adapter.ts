import type { BridgeSessionCore } from '../../controller/controller.js';

export interface ITelegramBridgeCore {
  registerTelegramInboundHandlers(): void;
  startCodexApp(): Promise<void>;
  startTelegramPolling(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Telegram channel: inbound subscription + transport startup ordering for {@link BridgeSessionCore}
 * or {@link UnifiedBridgeCore}.
 * Additional channels (e.g. Weixin) can compose the same core with their own adapters.
 */
export class TelegramChannelAdapter {
  constructor(private readonly core: BridgeSessionCore | ITelegramBridgeCore) {}

  async start(): Promise<void> {
    this.core.registerTelegramInboundHandlers();
    await this.core.startCodexApp();
    await this.core.startTelegramPolling();
  }

  async stop(): Promise<void> {
    await this.core.stop();
  }

  get sessionCore(): BridgeSessionCore | ITelegramBridgeCore {
    return this.core;
  }
}

