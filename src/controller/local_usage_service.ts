import {
  readCodexLocalUsageSnapshot,
  readCodexLocalUsageStats,
  writeCodexLocalUsageSnapshot,
  type CodexLocalUsageSnapshot,
} from '../codex_app/local_usage.js';
import { CODEX_LOCAL_USAGE_REFRESH_MS, CODEX_LOCAL_USAGE_SNAPSHOT_FILENAME } from './state_types.js';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';

export class CodexLocalUsageService {
  private closed = false;
  async stop(): Promise<void> { this.closed = true; await this.localUsageRefresh?.catch(() => {}); }

  private localUsageCache: CodexLocalUsageSnapshot | null = null;
  private localUsageCacheLoaded = false;
  private localUsageRefresh: Promise<void> | null = null;
  constructor(private readonly config: AppConfig, private readonly store: BridgeStore) {}

  async readCachedCodexLocalUsageStats(): Promise<CodexLocalUsageSnapshot | null> {
    if (this.localUsageCacheLoaded) {
      return this.localUsageCache;
    }
    this.localUsageCache = await readCodexLocalUsageSnapshot(this.codexLocalUsageSnapshotPath());
    this.localUsageCacheLoaded = true;
    return this.localUsageCache;
  }

  async refreshCodexLocalUsageIfNeeded(snapshot?: CodexLocalUsageSnapshot | null): Promise<void> {
    const current = snapshot === undefined ? await this.readCachedCodexLocalUsageStats() : snapshot;
    if (this.closed) return;
    if (current && Date.now() - current.computedAtMs < CODEX_LOCAL_USAGE_REFRESH_MS) {
      return;
    }
    if (this.localUsageRefresh) {
      return;
    }
    this.localUsageRefresh = this.refreshCodexLocalUsageStats().finally(() => {
      this.localUsageRefresh = null;
    });
    await this.localUsageRefresh;
  }

  async refreshCodexLocalUsageStats(): Promise<void> {
    if (this.closed) return;
    const stats = await readCodexLocalUsageStats(this.config.codexHome ?? undefined);
    const snapshot = { computedAtMs: Date.now(), stats };
    this.localUsageCache = snapshot;
    this.localUsageCacheLoaded = true;
    await writeCodexLocalUsageSnapshot(this.codexLocalUsageSnapshotPath(), snapshot);
    if (this.closed) return;
    this.store.setBackendCumulativeTokenUsage(
      {
        inputTokens: stats.totals.inputTokens,
        outputTokens: stats.totals.outputTokens,
        cachedTokens: stats.totals.cachedInputTokens,
        totalTokens: stats.totals.totalTokens,
        turnsCount: stats.turns,
      },
      'codex',
    );
  }

  codexLocalUsageSnapshotPath(): string {
    return path.join(path.dirname(this.config.statusPath), this.runtimeSnapshotFilename(CODEX_LOCAL_USAGE_SNAPSHOT_FILENAME));
  }
  invalidate(): void { this.localUsageCache = null; }
  private runtimeSnapshotFilename(filename: string): string { return this.config.tgScopeBotId ? filename.replace(/\.json$/, `-${this.config.tgScopeBotId}.json`) : filename; }
}
