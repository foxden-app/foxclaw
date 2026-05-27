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
  responseThroughput: CodexLocalResponseThroughputStats;
  latestSessionMtimeMs: number | null;
}

export interface CodexLocalUsageSnapshot {
  computedAtMs: number;
  stats: CodexLocalUsageStats;
}

export interface CodexLocalResponseThroughputStats {
  completedTurns: number;
  visibleOutputTokens: number;
  seconds: number;
  recentCompletedTurns: number;
  recentVisibleOutputTokens: number;
  recentSeconds: number;
}

interface CodexLocalCompletedTurnSample {
  completedAtMs: number;
  visibleOutputTokens: number;
  seconds: number;
}

interface ActiveTurnUsage {
  turnId: string;
  startedAtMs: number;
  visibleOutputTokens: number;
}

const RECENT_COMPLETED_TURNS = 10;

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
  const completedTurnSamples: CodexLocalCompletedTurnSample[] = [];

  for (const filePath of sessionFiles) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) {
      latestSessionMtimeMs = Math.max(latestSessionMtimeMs ?? 0, stat.mtimeMs);
    }
    const fileUsage = await readSessionUsage(filePath, turnIds);
    usageEvents += fileUsage.usageEvents;
    completedTurnSamples.push(...fileUsage.completedTurnSamples);
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
    responseThroughput: summarizeResponseThroughput(completedTurnSamples),
    latestSessionMtimeMs,
  };
}

export async function readCodexLocalUsageSnapshot(snapshotPath: string): Promise<CodexLocalUsageSnapshot | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as Partial<CodexLocalUsageSnapshot>;
    if (!isFiniteNumber(parsed.computedAtMs) || !isCodexLocalUsageStats(parsed.stats)) {
      return null;
    }
    return { computedAtMs: parsed.computedAtMs, stats: parsed.stats };
  } catch {
    return null;
  }
}

export async function writeCodexLocalUsageSnapshot(
  snapshotPath: string,
  snapshot: CodexLocalUsageSnapshot,
): Promise<void> {
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, snapshotPath);
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

async function readSessionUsage(
  filePath: string,
  turnIds: Set<string>,
): Promise<{
  usageEvents: number;
  totalUsage: RawTokenUsage | null;
  completedTurnSamples: CodexLocalCompletedTurnSample[];
}> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let totalUsage: RawTokenUsage | null = null;
  let usageEvents = 0;
  let activeTurn: ActiveTurnUsage | null = null;
  const completedTurnSamples: CodexLocalCompletedTurnSample[] = [];

  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const timestampMs = parseTimestampMs(event?.timestamp);
      const turnId = typeof event?.payload?.turn_id === 'string' ? event.payload.turn_id : null;
      if (turnId) {
        turnIds.add(turnId);
      }
      if (
        timestampMs !== null
        && turnId
        && event?.type === 'event_msg'
        && event?.payload?.type === 'task_started'
      ) {
        activeTurn = { turnId, startedAtMs: timestampMs, visibleOutputTokens: 0 };
      }
      const info = event?.payload?.info;
      const lastTokenUsage = info?.last_token_usage ?? info?.lastTokenUsage;
      if (lastTokenUsage) {
        usageEvents += 1;
        if (activeTurn) {
          activeTurn.visibleOutputTokens += visibleOutputTokens(lastTokenUsage);
        }
      }
      const totalTokenUsage = info?.total_token_usage ?? info?.totalTokenUsage;
      if (totalTokenUsage) {
        totalUsage = totalTokenUsage;
      }
      const completedTurn = activeTurn;
      if (
        completedTurn !== null
        && timestampMs !== null
        && turnId
        && completedTurn.turnId === turnId
        && event?.type === 'event_msg'
        && (event?.payload?.type === 'task_complete' || event?.payload?.type === 'turn_aborted')
      ) {
        if (event.payload.type === 'task_complete' && completedTurn.visibleOutputTokens > 0) {
          const seconds = (timestampMs - completedTurn.startedAtMs) / 1000;
          if (Number.isFinite(seconds) && seconds > 0) {
            completedTurnSamples.push({
              completedAtMs: timestampMs,
              visibleOutputTokens: completedTurn.visibleOutputTokens,
              seconds,
            });
          }
        }
        activeTurn = null;
      }
    }
  } finally {
    reader.close();
  }

  return { usageEvents, totalUsage, completedTurnSamples };
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

function isCodexLocalUsageStats(value: unknown): value is CodexLocalUsageStats {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const stats = value as Partial<CodexLocalUsageStats>;
  const totals = stats.totals as Partial<CodexLocalUsageTotals> | undefined;
  const throughput = stats.responseThroughput as Partial<CodexLocalResponseThroughputStats> | undefined;
  return isFiniteNumber(stats.sessionFiles)
    && isFiniteNumber(stats.sessionsWithUsage)
    && isFiniteNumber(stats.turns)
    && isFiniteNumber(stats.usageEvents)
    && Boolean(totals)
    && isFiniteNumber(totals?.inputTokens)
    && isFiniteNumber(totals?.cachedInputTokens)
    && isFiniteNumber(totals?.outputTokens)
    && isFiniteNumber(totals?.reasoningOutputTokens)
    && isFiniteNumber(totals?.totalTokens)
    && Boolean(throughput)
    && isFiniteNumber(throughput?.completedTurns)
    && isFiniteNumber(throughput?.visibleOutputTokens)
    && isFiniteNumber(throughput?.seconds)
    && isFiniteNumber(throughput?.recentCompletedTurns)
    && isFiniteNumber(throughput?.recentVisibleOutputTokens)
    && isFiniteNumber(throughput?.recentSeconds)
    && isNullableFiniteNumber(stats.latestSessionMtimeMs);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
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

function visibleOutputTokens(usage: RawTokenUsage): number {
  return Math.max(
    0,
    numberField(usage, 'output_tokens', 'outputTokens')
      - numberField(usage, 'reasoning_output_tokens', 'reasoningOutputTokens'),
  );
}

function summarizeResponseThroughput(
  samples: CodexLocalCompletedTurnSample[],
): CodexLocalResponseThroughputStats {
  const ordered = samples.slice().sort((left, right) => left.completedAtMs - right.completedAtMs);
  const recent = ordered.slice(-RECENT_COMPLETED_TURNS);
  return {
    completedTurns: ordered.length,
    visibleOutputTokens: ordered.reduce((total, sample) => total + sample.visibleOutputTokens, 0),
    seconds: ordered.reduce((total, sample) => total + sample.seconds, 0),
    recentCompletedTurns: recent.length,
    recentVisibleOutputTokens: recent.reduce((total, sample) => total + sample.visibleOutputTokens, 0),
    recentSeconds: recent.reduce((total, sample) => total + sample.seconds, 0),
  };
}

function numberField(source: RawTokenUsage, snakeKey: keyof RawTokenUsage, camelKey: keyof RawTokenUsage): number {
  const snakeValue = source[snakeKey];
  const value = snakeValue === undefined || snakeValue === null ? source[camelKey] : snakeValue;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
