/** Serialize state changes for one conversation; unrelated scopes proceed independently. */
export class ScopeOperations {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(scopeId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(scopeId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.tails.set(scopeId, next);
    void next.finally(() => {
      if (this.tails.get(scopeId) === next) this.tails.delete(scopeId);
    }).catch(() => {});
    return next;
  }

  isIdle(): boolean { return this.tails.size === 0; }

  async idle(): Promise<void> {
    while (this.tails.size) await Promise.allSettled([...this.tails.values()]);
  }
}
