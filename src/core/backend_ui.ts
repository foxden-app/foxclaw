import type { AppLocale } from '../types.js';
import type { ChannelTextEvent, ChannelCallbackEvent } from '../core/channel_events.js';
import type { ChannelInlineKeyboard } from '../core/channel_port.js';
import type { BackendDescriptor } from './engine_spi.js';

/** Operations a backend panel can request without depending on the orchestrator implementation. */
export interface BackendUiHost {
  sendMessage(scopeId: string, text: string, keyboard?: ChannelInlineKeyboard): Promise<number>;
  editMessage(scopeId: string, messageId: number, text: string, keyboard?: ChannelInlineKeyboard): Promise<void>;
  scheduleStalePanelDeletion(scopeId: string, messageId: number): void;
  hasActiveTurn(scopeId: string): boolean;
  syncCurrentBackendSettings(scopeId: string): void;
  getBackendDescriptorForScope(scopeId: string): BackendDescriptor;
}

export interface EngineCustomUiHook {
  renderSetupMenu?(scopeId: string, locale: AppLocale, messageId?: number): Promise<boolean>;
  renderModelsMenu?(scopeId: string, locale: AppLocale, messageId?: number): Promise<boolean>;
  renderCustomStatus?(scopeId: string, locale: AppLocale): Promise<string | null>;
  renderCustomSetupRows?(scopeId: string, locale: AppLocale): Promise<ChannelInlineKeyboard>;
  renderBackendMenuRows?(scopeId: string, locale: AppLocale): Promise<ChannelInlineKeyboard>;
  handleCustomCallback?(scopeId: string, data: string, locale: AppLocale, messageId?: number, event?: ChannelCallbackEvent): Promise<boolean>;
  handleCustomCommand?(scopeId: string, command: string, args: string, locale: AppLocale, event?: ChannelTextEvent): Promise<boolean>;
  handleCustomInbound?(event: ChannelTextEvent, locale: AppLocale): boolean | Promise<boolean>;
  isSensitiveInbound?(event: ChannelTextEvent): boolean;
}

export interface BackendUi extends EngineCustomUiHook {
  /** Recognize owned buttons even after the user switches to another backend (e.g. pending approvals). */
  ownsCallback?(data: string): boolean;
  getPendingApprovals?(): number;
  getPendingOperations?(): number;
  stopPendingOperations?(): Promise<void>;
  stop?(): Promise<void>;
}
