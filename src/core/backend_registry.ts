import type { BackendDescriptor } from './engine_spi.js';
import type { BackendUi, BackendUiHost } from './backend_ui.js';
import type { ChannelTextEvent } from './channel_events.js';

/** Owns backend definitions and their panel lifecycle. Discovery may refresh metadata, never execution identity. */
export class BackendRegistry {
  private readonly entries = new Map<string, BackendDescriptor>();
  private stopping: Promise<void> | undefined;
  private readonly interfaces = new Map<string, BackendUi>();

  constructor(private readonly host: BackendUiHost) {}

  register(backend: BackendDescriptor): void {
    if (this.stopping) throw new Error('Backend registry is stopped');
    if (!backend.id) throw new Error('Backend id is required');
    const existing = this.entries.get(backend.id);
    if (existing && (existing.adapter !== backend.adapter || (backend.createUi !== undefined && existing.createUi !== backend.createUi))) {
      throw new Error(`Backend '${backend.id}' is already registered with a different runtime`);
    }
    const ui = !existing ? backend.createUi?.(this.host) : undefined;
    this.entries.set(backend.id, { ...existing, ...backend });
    if (ui) this.interfaces.set(backend.id, ui);
  }

  set(id: string, backend: BackendDescriptor): void {
    if (id !== backend.id) throw new Error('Backend registry key must match its id');
    this.register(backend);
  }
  has(id: string): boolean { return this.entries.has(id); }
  keys(): IterableIterator<string> { return this.entries.keys(); }
  values(): IterableIterator<BackendDescriptor> { return this.entries.values(); }
  get(id: string): BackendDescriptor | undefined { return this.entries.get(id); }
  list(): BackendDescriptor[] { return [...this.entries.values()]; }
  ui(id: string): BackendUi | undefined { return this.interfaces.get(id); }
  callbackOwner(data: string): BackendUi | undefined {
    return [...this.interfaces.values()].find(ui => ui.ownsCallback?.(data));
  }
  sensitiveInboundOwner(event: ChannelTextEvent): BackendUi | undefined {
    return [...this.interfaces.values()].find(ui => ui.isSensitiveInbound?.(event));
  }
  getPendingApprovals(): number {
    return [...this.interfaces.values()].reduce((sum, ui) => sum + (ui.getPendingApprovals?.() ?? 0), 0);
  }
  getPendingOperations(): number {
    return [...this.interfaces.values()].reduce((sum, ui) => sum + (ui.getPendingOperations?.() ?? 0), 0);
  }
  async stopPendingOperations(): Promise<void> {
    await Promise.allSettled([...this.interfaces.values()].map(ui => ui.stopPendingOperations?.()));
  }
  stop(): Promise<void> {
    return this.stopping ??= this.stopInterfaces();
  }

  private async stopInterfaces(): Promise<void> {
    const results = await Promise.allSettled([...this.interfaces.values()].map(ui => ui.stop?.()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
