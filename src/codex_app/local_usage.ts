import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export interface CodexLocalUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexLocalUsageStats {
  sessionFiles: number;
  sessionsWithUsage: number;
  turns: number;
  usageEvents: number;
  totals: CodexLocalUsageTotals;
  latestSessionMtimeMs: number | null;
}

interface RawTokenUsage {
  input_tokens?: unknown;
  inputTokens?: unknown;
  cached_input_tokens?: unknown;
  cachedInputTokens?: unknown;
  output_tokens?: unknown;
  outputTokens?: unknown;
  reasoning_output_tokens?: unknown;
  reasoningOutputTokens?: unknown;
  total_tokens?: unknown;
  totalTokens?: unknown;
}

export async function readCodexLocalUsageStats(codexHome = resolveCodexHome()): Promise<CodexLocalUsageStats> {
  const sessionFiles = await listJsonlFiles([
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ]);
  const totals = emptyTotals();
  const turnIds = new Set<string>();
  let sessionsWithUsage = 0;
  let usageEvents = 0;
  let latestSessionMtimeMs: number | null = null;

  for (const filePath of sessionFiles) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) {
      latestSessionMtimeMs = Math.max(latestSessionMtimeMs ?? 0, stat.mtimeMs);
    }
    const fileUsage = await readSessionUsage(filePath, turnIds);
    usageEvents += fileUsage.usageEvents;
    if (fileUsage.totalUsage) {
      sessionsWithUsage += 1;
      addUsage(totals, fileUsage.totalUsage);
    }
  }

  return {
    sessionFiles: sessionFiles.length,
    sessionsWithUsage,
    turns: turnIds.size,
    usageEvents,
    totals,
    latestSessionMtimeMs,
  };
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

async function listJsonlFiles(roots: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const root of roots) {
    await collectJsonlFiles(root, results);
  }
  return results;
}

async function collectJsonlFiles(targetPath: string, results: string[]): Promise<void> {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat) return;
  if (stat.isFile()) {
    if (targetPath.endsWith('.jsonl')) {
      results.push(targetPath);
    }
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    await collectJsonlFiles(path.join(targetPath, entry.name), results);
  }
}

async function readSessionUsage(filePath: string, turnIds: Set<string>): Promise<{ usageEvents: number; totalUsage: RawTokenUsage | null }> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let totalUsage: RawTokenUsage | null = null;
  let usageEvents = 0;

  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const turnId = typeof event?.payload?.turn_id === 'string' ? event.payload.turn_id : null;
      if (turnId) {
        turnIds.add(turnId);
      }
      const info = event?.payload?.info;
      if (info?.last_token_usage || info?.lastTokenUsage) {
        usageEvents += 1;
      }
      const totalTokenUsage = info?.total_token_usage ?? info?.totalTokenUsage;
      if (totalTokenUsage) {
        totalUsage = totalTokenUsage;
      }
    }
  } finally {
    reader.close();
  }

  return { usageEvents, totalUsage };
}

function emptyTotals(): CodexLocalUsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(totals: CodexLocalUsageTotals, usage: RawTokenUsage): void {
  const inputTokens = numberField(usage, 'input_tokens', 'inputTokens');
  const outputTokens = numberField(usage, 'output_tokens', 'outputTokens');
  const totalTokens = numberField(usage, 'total_tokens', 'totalTokens');
  totals.inputTokens += inputTokens;
  totals.cachedInputTokens += numberField(usage, 'cached_input_tokens', 'cachedInputTokens');
  totals.outputTokens += outputTokens;
  totals.reasoningOutputTokens += numberField(usage, 'reasoning_output_tokens', 'reasoningOutputTokens');
  totals.totalTokens += totalTokens || inputTokens + outputTokens;
}

function numberField(source: RawTokenUsage, snakeKey: keyof RawTokenUsage, camelKey: keyof RawTokenUsage): number {
  const snakeValue = source[snakeKey];
  const value = snakeValue === undefined || snakeValue === null ? source[camelKey] : snakeValue;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
