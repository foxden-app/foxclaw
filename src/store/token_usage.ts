import path from 'node:path';
import type { AppLocale } from '../types.js';
import type { BridgeStore } from './database.js';
import { readCodexLocalUsageStats } from '../codex_app/local_usage.js';

export interface CumulativeTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  turnsCount: number;
}

export interface CumulativeTokenUsageRecord extends CumulativeTokenTotals {
  backendId: string;
  updatedAt: number;
}

export interface TokenUsageDelta {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export function formatMetricTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1_000_000_000) {
    const g = value / 1_000_000_000;
    return `${Number.isInteger(g) ? g : Number(g.toFixed(2))}G`;
  }
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(2))}M`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return `${Number.isInteger(k) ? k : Number(k.toFixed(1))}K`;
  }
  return String(Math.round(value));
}

export function formatTokenUsageSummary(
  totals: CumulativeTokenTotals,
  locale: AppLocale = 'zh',
): string {
  const total = formatMetricTokenCount(totals.totalTokens);
  const input = formatMetricTokenCount(totals.inputTokens);
  const output = formatMetricTokenCount(totals.outputTokens);
  const cached = formatMetricTokenCount(totals.cachedTokens);

  if (locale === 'zh') {
    return `• **Token 用量**: 总计 ${total} (输入 ${input}, 输出 ${output}, 缓存 ${cached})`;
  }
  return `• **Token Usage**: Total ${total} (Input ${input}, Output ${output}, Cached ${cached})`;
}

export function formatBackendTokenUsageBreakdown(usages: CumulativeTokenUsageRecord[]): string {
  if (usages.length <= 1) return '';
  const labels: Record<string, string> = {
    antigravity: 'AGY',
    codex: 'Codex',
    opencode: 'OpenCode',
  };
  const parts = usages
    .filter((u) => u.totalTokens > 0)
    .map((u) => `${labels[u.backendId] || u.backendId}: ${formatMetricTokenCount(u.totalTokens)}`);
  if (parts.length <= 1) return '';
  return `\n  └ ${parts.join(' · ')}`;
}

export async function syncCodexLocalUsageToStore(
  store: BridgeStore,
  codexHome?: string,
): Promise<void> {
  try {
    const stats = await readCodexLocalUsageStats(codexHome);
    if (stats.totals.totalTokens > 0 || stats.turns > 0) {
      store.setBackendCumulativeTokenUsage(
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
  } catch {
    // Non-fatal if codex home is unavailable
  }
}
