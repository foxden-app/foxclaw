export interface ManagedRuntime { start?(): void | Promise<void>; stop(): void | Promise<void>; }
export interface ShutdownFailure { name: string; error: unknown; }
interface Entry { name: string; resource: ManagedRuntime; start: Promise<void> | null; }

/** Owns resources from allocation onward, including partially started runtimes. */
export class RuntimeSupervisor {
  private readonly entries: Entry[] = [];
  private readonly identities = new Set<ManagedRuntime>();
  private closing = false;
  private shutdown: Promise<ShutdownFailure[]> | null = null;

  register(name: string, resource: ManagedRuntime): void {
    if (this.closing) throw new Error('Runtime supervisor is stopping');
    if (this.identities.has(resource)) return;
    if (this.entries.some(entry => entry.name === name)) throw new Error(`Runtime already registered: ${name}`);
    this.identities.add(resource);
    this.entries.push({ name, resource, start: null });
  }

  start(name: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Runtime supervisor is stopping'));
    const entry = this.entries.find(entry => entry.name === name);
    if (!entry) return Promise.reject(new Error(`Unknown runtime: ${name}`));
    entry.start ??= Promise.resolve().then(() => entry.resource.start?.());
    return entry.start;
  }

  stop(): Promise<ShutdownFailure[]> {
    this.closing = true;
    this.shutdown ??= this.stopAll();
    return this.shutdown;
  }

  private async stopAll(): Promise<ShutdownFailure[]> {
    const failures: ShutdownFailure[] = [];
    // Consumers are registered after their dependencies and stopped before them.
    for (const entry of [...this.entries].reverse()) {
      await entry.start?.catch(() => {});
      try { await entry.resource.stop(); }
      catch (error) { failures.push({ name: entry.name, error }); }
    }
    return failures;
  }
}
