import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BridgeStore } from './database.js';
import {
  formatMetricTokenCount,
  formatTokenUsageSummary,
  formatBackendTokenUsageBreakdown,
} from './token_usage.js';

test('formatMetricTokenCount correctly formats tokens into G, M, K, and raw counts', () => {
  assert.equal(formatMetricTokenCount(0), '0');
  assert.equal(formatMetricTokenCount(-100), '0');
  assert.equal(formatMetricTokenCount(450), '450');
  assert.equal(formatMetricTokenCount(1200), '1.2K');
  assert.equal(formatMetricTokenCount(25000), '25K');
  assert.equal(formatMetricTokenCount(1000000), '1M');
  assert.equal(formatMetricTokenCount(20135432), '20.14M');
  assert.equal(formatMetricTokenCount(1000000000), '1G');
  assert.equal(formatMetricTokenCount(7563800912), '7.56G');
  assert.equal(formatMetricTokenCount(7248253824), '7.25G');
  assert.equal(formatMetricTokenCount(7583936344), '7.58G');
});

test('formatTokenUsageSummary generates clear summary for zh and en', () => {
  const totals = {
    totalTokens: 7583936344,
    inputTokens: 7563800912,
    outputTokens: 20135432,
    cachedTokens: 7248253824,
    turnsCount: 2183,
  };

  const zh = formatTokenUsageSummary(totals, 'zh');
  assert.ok(zh.includes('总计 7.58G'));
  assert.ok(zh.includes('输入 7.56G'));
  assert.ok(zh.includes('输出 20.14M'));
  assert.ok(zh.includes('缓存 7.25G'));

  const en = formatTokenUsageSummary(totals, 'en');
  assert.ok(en.includes('Total 7.58G'));
  assert.ok(en.includes('Input 7.56G'));
  assert.ok(en.includes('Output 20.14M'));
  assert.ok(en.includes('Cached 7.25G'));
});

test('formatBackendTokenUsageBreakdown formats multiple backends', () => {
  const single = [
    {
      backendId: 'codex',
      totalTokens: 7583936344,
      inputTokens: 7563800912,
      outputTokens: 20135432,
      cachedTokens: 7248253824,
      turnsCount: 2183,
      updatedAt: Date.now(),
    },
  ];
  assert.equal(formatBackendTokenUsageBreakdown(single), '');

  const multi = [
    {
      backendId: 'codex',
      totalTokens: 7583936344,
      inputTokens: 7563800912,
      outputTokens: 20135432,
      cachedTokens: 7248253824,
      turnsCount: 2183,
      updatedAt: Date.now(),
    },
    {
      backendId: 'antigravity',
      totalTokens: 12500000,
      inputTokens: 10000000,
      outputTokens: 2500000,
      cachedTokens: 8000000,
      turnsCount: 5,
      updatedAt: Date.now(),
    },
  ];
  const breakdown = formatBackendTokenUsageBreakdown(multi);
  assert.ok(breakdown.includes('Codex: 7.58G'));
  assert.ok(breakdown.includes('AGY: 12.5M'));
});

test('BridgeStore persists and aggregates token usage', () => {
  const tempDb = path.join(os.tmpdir(), `foxclaw_token_test_${Date.now()}.db`);
  try {
    const store = new BridgeStore(tempDb);

    // Initial state is all zeroes
    const initial = store.getCumulativeTokenUsage();
    assert.equal(initial.totalTokens, 0);
    assert.equal(initial.inputTokens, 0);
    assert.equal(initial.outputTokens, 0);
    assert.equal(initial.cachedTokens, 0);

    // Record usage for AGY
    store.recordTokenUsage(
      {
        inputTokens: 5000,
        outputTokens: 1000,
        cachedTokens: 2000,
        totalTokens: 6000,
      },
      'antigravity',
    );

    const agyUsage = store.getCumulativeTokenUsage('antigravity');
    assert.equal(agyUsage.inputTokens, 5000);
    assert.equal(agyUsage.outputTokens, 1000);
    assert.equal(agyUsage.cachedTokens, 2000);
    assert.equal(agyUsage.totalTokens, 6000);
    assert.equal(agyUsage.turnsCount, 1);

    // Add another turn to AGY
    store.recordTokenUsage(
      {
        inputTokens: 3000,
        outputTokens: 500,
        cachedTokens: 1000,
        totalTokens: 3500,
      },
      'antigravity',
    );

    const agyUsage2 = store.getCumulativeTokenUsage('antigravity');
    assert.equal(agyUsage2.inputTokens, 8000);
    assert.equal(agyUsage2.outputTokens, 1500);
    assert.equal(agyUsage2.cachedTokens, 3000);
    assert.equal(agyUsage2.totalTokens, 9500);
    assert.equal(agyUsage2.turnsCount, 2);

    // Set baseline for Codex
    store.setBackendCumulativeTokenUsage(
      {
        inputTokens: 7563800912,
        outputTokens: 20135432,
        cachedTokens: 7248253824,
        totalTokens: 7583936344,
        turnsCount: 2183,
      },
      'codex',
    );

    const codexUsage = store.getCumulativeTokenUsage('codex');
    assert.equal(codexUsage.totalTokens, 7583936344);

    // Total across all backends
    const combined = store.getCumulativeTokenUsage();
    assert.equal(combined.totalTokens, 7583936344 + 9500);
    assert.equal(combined.inputTokens, 7563800912 + 8000);
    assert.equal(combined.outputTokens, 20135432 + 1500);
    assert.equal(combined.cachedTokens, 7248253824 + 3000);
    assert.equal(combined.turnsCount, 2185);

    const all = store.getAllBackendTokenUsages();
    assert.equal(all.length, 2);
    assert.equal(all[0]?.backendId, 'codex');
    assert.equal(all[1]?.backendId, 'antigravity');
  } finally {
    fs.rmSync(tempDb, { force: true });
  }
});
