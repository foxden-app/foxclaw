import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexLocalUsageSnapshot, writeCodexLocalUsageSnapshot } from './local_usage.js';

test('local usage snapshots persist for fast status reads', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-local-usage-'));
  const snapshotPath = path.join(tempDir, 'runtime', 'codex-local-usage.json');
  const snapshot = {
    computedAtMs: 1_769_435_280_000,
    stats: {
      sessionFiles: 2,
      sessionsWithUsage: 2,
      turns: 3,
      usageEvents: 4,
      totals: {
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 4,
        reasoningOutputTokens: 2,
        totalTokens: 14,
      },
      outputSpeed: {
        samples: 2,
        outputTokens: 4,
        seconds: 1,
        latestTokensPerSecond: 4,
        latestSampleAtMs: 1_769_435_280_000,
      },
      latestSessionMtimeMs: 1_769_435_280_000,
    },
  };
  try {
    await writeCodexLocalUsageSnapshot(snapshotPath, snapshot);
    assert.deepEqual(await readCodexLocalUsageSnapshot(snapshotPath), snapshot);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
