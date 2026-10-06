interface EventSource { on(event: string, listener: (...args: any[]) => void): unknown; off?(event: string, listener: (...args: any[]) => void): unknown; }
/** Ownership of subscriptions is separate from ownership of the shared transport. */
export class ListenerScope {
  private readonly cleanup: Array<() => void> = [];
  listen(source: EventSource, event: string, listener: (...args: any[]) => void): void {
    source.on(event, listener);
    this.cleanup.push(() => source.off?.(event, listener));
  }
  clear(): void { for (const stop of this.cleanup.splice(0).reverse()) stop(); }
}
