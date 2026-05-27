import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readCodexLocalUsageSnapshot,
  readCodexLocalUsageStats,
  writeCodexLocalUsageSnapshot,
} from './local_usage.js';

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
      responseThroughput: {
        completedTurns: 2,
        visibleOutputTokens: 4,
        seconds: 1,
        recentCompletedTurns: 2,
        recentVisibleOutputTokens: 4,
        recentSeconds: 1,
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

test('local response throughput uses completed turn wall time and excludes reasoning output', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxclaw-local-usage-stats-'));
  const sessionDir = path.join(tempDir, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'turns.jsonl'), [
    JSON.stringify({
      timestamp: '2026-05-27T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'completed' },
    }),
    JSON.stringify({
      timestamp: '2026-05-27T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { output_tokens: 8, reasoning_output_tokens: 3 },
          total_token_usage: { input_tokens: 20, output_tokens: 8, reasoning_output_tokens: 3, total_tokens: 28 },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-27T00:00:04.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'completed' },
    }),
    JSON.stringify({
      timestamp: '2026-05-27T00:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'aborted' },
    }),
    JSON.stringify({
      timestamp: '2026-05-27T00:01:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { output_tokens: 100, reasoning_output_tokens: 0 },
          total_token_usage: { input_tokens: 40, output_tokens: 108, reasoning_output_tokens: 3, total_tokens: 148 },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-27T00:01:02.000Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'aborted' },
    }),
  ].join('\n'));

  try {
    const stats = await readCodexLocalUsageStats(tempDir);
    assert.deepEqual(stats.responseThroughput, {
      completedTurns: 1,
      visibleOutputTokens: 5,
      seconds: 4,
      recentCompletedTurns: 1,
      recentVisibleOutputTokens: 5,
      recentSeconds: 4,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
