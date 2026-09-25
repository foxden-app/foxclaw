export type TurnMessageMode = 'steer' | 'queue';

export interface QueuedTurnItem<T = unknown> {
  id: string;
  scopeId: string;
  prompt: string;
  payload: T;
  enqueuedAt: number;
}

export class TurnQueueManager<T = unknown> {
  private readonly queues = new Map<string, QueuedTurnItem<T>[]>();
  private readonly activeModes = new Map<string, TurnMessageMode>();

  getMode(scopeId: string, defaultMode: TurnMessageMode = 'queue'): TurnMessageMode {
    return this.activeModes.get(scopeId) ?? defaultMode;
  }

  setMode(scopeId: string, mode: TurnMessageMode): void {
    this.activeModes.set(scopeId, mode);
  }

  enqueue(scopeId: string, item: Omit<QueuedTurnItem<T>, 'id' | 'enqueuedAt'>): QueuedTurnItem<T> {
    const fullItem: QueuedTurnItem<T> = {
      ...item,
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      enqueuedAt: Date.now(),
    };
    const list = this.queues.get(scopeId) || [];
    list.push(fullItem);
    this.queues.set(scopeId, list);
    return fullItem;
  }

  dequeue(scopeId: string): QueuedTurnItem<T> | undefined {
    const list = this.queues.get(scopeId);
    if (!list || list.length === 0) return undefined;
    const item = list.shift();
    if (list.length === 0) this.queues.delete(scopeId);
    return item;
  }

  peek(scopeId: string): QueuedTurnItem<T> | undefined {
    return this.queues.get(scopeId)?.[0];
  }

  getQueueLength(scopeId: string): number {
    return this.queues.get(scopeId)?.length ?? 0;
  }

  clearQueue(scopeId: string): number {
    const count = this.getQueueLength(scopeId);
    this.queues.delete(scopeId);
    return count;
  }
}
