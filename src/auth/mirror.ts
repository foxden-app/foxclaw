import fs from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger.js';

export interface AuthMirrorRuntime {
  id: string;
  label?: string;
  authDir: string;
  notify?: (message: string) => Promise<void>;
  validate?: (context: AuthMirrorValidationContext) => Promise<AuthMirrorValidationResult | boolean>;
}

export interface AuthMirrorStatus {
  candidateName: string;
  sourceRuntimeId: string;
  sourceLabel: string;
  syncedAt: string;
}

export interface AuthMirrorValidationContext {
  candidateName: string;
  accountId: string;
  lastRefreshMs: number;
}

export interface AuthMirrorValidationResult {
  ok: boolean;
  reason?: string | null;
}

interface AuthRecord {
  raw: string;
  accountId: string;
  lastRefreshMs: number;
}

const AUTH_SCAN_INTERVAL_MS = 5_000;

export class AuthCandidateMirror {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastSyncedRefresh = new Map<string, number>();
  private activeOperations = 0;
  private lastStatus: AuthMirrorStatus | null = null;

  constructor(
    private readonly canonicalDir: string,
    private readonly runtimes: AuthMirrorRuntime[],
    private readonly logger: Logger,
    private readonly statusPath: string | null = null,
  ) {}

  async initialize(): Promise<void> {
    this.lastStatus = await readMirrorStatus(this.statusPath);
    await fs.mkdir(this.canonicalDir, { recursive: true, mode: 0o700 });
    await this.ensureCanonicalDefaultCandidate();
    const candidateNames = await this.collectCandidateNames();
    for (const name of candidateNames) {
      await this.reconcileCandidateAtStartup(name);
    }
    const canonicalCandidateNames = await listAuthCandidateNames(this.canonicalDir);
    const defaultCandidate = await this.resolveCanonicalCurrentCandidate()
      ?? canonicalCandidateNames.sort()[0]
      ?? null;
    for (const runtime of this.runtimes) {
      await fs.mkdir(runtime.authDir, { recursive: true, mode: 0o700 });
      for (const name of canonicalCandidateNames) {
        const destination = path.join(runtime.authDir, name);
        if (!(await exists(destination))) {
          await atomicCopy(path.join(this.canonicalDir, name), destination);
        }
      }
      if (defaultCandidate && !(await exists(path.join(runtime.authDir, 'auth.json')))) {
        await pointAuthSymlink(runtime.authDir, defaultCandidate);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scan().catch((error) => {
        this.logger.warn('auth.mirror.scan_failed', { error: formatError(error) });
      });
    }, AUTH_SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isIdle(): boolean {
    return this.activeOperations === 0;
  }

  getStatus(): AuthMirrorStatus | null {
    return this.lastStatus;
  }

  async syncRuntimeCandidate(runtimeId: string, candidateName: string): Promise<boolean> {
    if (!isAuthCandidateName(candidateName)) return false;
    const runtime = this.runtimes.find((entry) => entry.id === runtimeId);
    if (!runtime) return false;
    return this.withActivity(() => this.propagateValidatedCandidate(runtime, candidateName));
  }

  private async scan(): Promise<void> {
    await this.withActivity(async () => {
      for (const runtime of this.runtimes) {
        const names = await listAuthCandidateNames(runtime.authDir);
        for (const name of names) {
          await this.propagateValidatedCandidate(runtime, name);
        }
      }
    });
  }

  private async propagateValidatedCandidate(runtime: AuthMirrorRuntime, name: string): Promise<boolean> {
    const sourcePath = path.join(runtime.authDir, name);
    const record = await readChatGptAuthRecord(sourcePath);
    if (!record) return false;
    const canonicalPath = path.join(this.canonicalDir, name);
    const canonical = await readChatGptAuthRecord(canonicalPath);
    if (canonical && canonical.accountId !== record.accountId) {
      this.logger.warn('auth.mirror.account_conflict', { runtimeId: runtime.id, name });
      return false;
    }
    const previousRefresh = Math.max(canonical?.lastRefreshMs ?? 0, this.lastSyncedRefresh.get(name) ?? 0);
    if (record.lastRefreshMs <= previousRefresh) {
      return false;
    }
    const validation = await this.validateRuntimeCandidate(runtime, name, record);
    if (!validation.ok) {
      this.logger.warn('auth.mirror.validation_failed', {
        runtimeId: runtime.id,
        name,
        reason: validation.reason ?? 'unknown',
      });
      return false;
    }
    await atomicWrite(canonicalPath, record.raw);
    for (const target of this.runtimes) {
      if (target.id !== runtime.id) {
        await atomicWrite(path.join(target.authDir, name), record.raw);
      }
    }
    this.lastSyncedRefresh.set(name, record.lastRefreshMs);
    const sourceLabel = runtime.label ?? runtime.id;
    this.lastStatus = {
      candidateName: name,
      sourceRuntimeId: runtime.id,
      sourceLabel,
      syncedAt: new Date().toISOString(),
    };
    await writeMirrorStatus(this.statusPath, this.lastStatus);
    this.logger.info('auth.mirror.synced', { sourceRuntimeId: runtime.id, name });
    const message = `${name} has been refreshed by ${sourceLabel} and synchronized to the other Codex homes.`;
    await Promise.allSettled(this.runtimes.map((target) => target.notify?.(message)));
    return true;
  }

  private async validateRuntimeCandidate(
    runtime: AuthMirrorRuntime,
    name: string,
    record: AuthRecord,
  ): Promise<AuthMirrorValidationResult> {
    if (!runtime.validate) {
      return { ok: true };
    }
    try {
      const result = await runtime.validate({
        candidateName: name,
        accountId: record.accountId,
        lastRefreshMs: record.lastRefreshMs,
      });
      if (typeof result === 'boolean') {
        return { ok: result };
      }
      return { ok: Boolean(result.ok), reason: result.reason ?? null };
    } catch (error) {
      return { ok: false, reason: formatError(error) };
    }
  }

  private async withActivity<T>(operation: () => Promise<T>): Promise<T> {
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
    }
  }

  private async ensureCanonicalDefaultCandidate(): Promise<void> {
    const names = await listAuthCandidateNames(this.canonicalDir);
    if (names.length > 0) return;
    const authPath = path.join(this.canonicalDir, 'auth.json');
    if (!(await exists(authPath))) return;
    const finalPath = await resolveFinalPath(authPath);
    if (isAuthCandidateName(path.basename(finalPath))) return;
    await atomicCopy(authPath, path.join(this.canonicalDir, 'auth.json_default'));
  }

  private async collectCandidateNames(): Promise<string[]> {
    const all = new Set(await listAuthCandidateNames(this.canonicalDir));
    for (const runtime of this.runtimes) {
      for (const name of await listAuthCandidateNames(runtime.authDir)) {
        all.add(name);
      }
    }
    return [...all];
  }

  private async reconcileCandidateAtStartup(name: string): Promise<void> {
    const paths = [
      path.join(this.canonicalDir, name),
      ...this.runtimes.map((runtime) => path.join(runtime.authDir, name)),
    ];
    const records = (await Promise.all(paths.map(async (sourcePath) => ({
      sourcePath,
      record: await readChatGptAuthRecord(sourcePath),
    })))).filter((entry): entry is { sourcePath: string; record: AuthRecord } => entry.record !== null);
    if (records.length === 0) return;
    const accountIds = new Set(records.map((entry) => entry.record.accountId));
    if (accountIds.size !== 1) {
      this.logger.warn('auth.mirror.startup_conflict', { name });
      return;
    }
    const newest = records.reduce((current, entry) => (
      entry.record.lastRefreshMs > current.record.lastRefreshMs ? entry : current
    ));
    this.lastSyncedRefresh.set(name, newest.record.lastRefreshMs);
    for (const destination of paths) {
      await atomicWrite(destination, newest.record.raw);
    }
  }

  private async resolveCanonicalCurrentCandidate(): Promise<string | null> {
    const finalPath = await resolveFinalPath(path.join(this.canonicalDir, 'auth.json'));
    const name = path.basename(finalPath);
    return isAuthCandidateName(name) ? name : null;
  }
}

export function isAuthCandidateName(name: string): boolean {
  return name !== 'auth.json'
    && !name.startsWith('.auth.json.')
    && (name.startsWith('auth.json_') || name.startsWith('auth.json.') || name.startsWith('auth.json-'));
}

async function listAuthCandidateNames(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isAuthCandidateName(entry.name))
    .map((entry) => entry.name);
}

async function readChatGptAuthRecord(filePath: string): Promise<AuthRecord | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      tokens?: { account_id?: unknown };
      last_refresh?: unknown;
    };
    const accountId = typeof parsed.tokens?.account_id === 'string' ? parsed.tokens.account_id : '';
    const lastRefreshMs = typeof parsed.last_refresh === 'string' ? Date.parse(parsed.last_refresh) : NaN;
    if (!accountId || !Number.isFinite(lastRefreshMs)) return null;
    return { raw, accountId, lastRefreshMs };
  } catch {
    return null;
  }
}

async function atomicCopy(source: string, destination: string): Promise<void> {
  await atomicWrite(destination, await fs.readFile(source, 'utf8'));
}

async function atomicWrite(destination: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.auth.json.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, destination);
}

async function pointAuthSymlink(dir: string, candidateName: string): Promise<void> {
  const temporary = path.join(dir, `.auth.json.${process.pid}.${Date.now()}.link`);
  await fs.symlink(path.join(dir, candidateName), temporary);
  await fs.rename(temporary, path.join(dir, 'auth.json'));
}

async function resolveFinalPath(sourcePath: string): Promise<string> {
  try {
    return await fs.realpath(sourcePath);
  } catch {
    return sourcePath;
  }
}

async function exists(filePath: string): Promise<boolean> {
  return fs.lstat(filePath).then(() => true).catch(() => false);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readMirrorStatus(statusPath: string | null): Promise<AuthMirrorStatus | null> {
  if (!statusPath) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(statusPath, 'utf8')) as Partial<AuthMirrorStatus>;
    if (
      typeof parsed.candidateName !== 'string'
      || typeof parsed.sourceRuntimeId !== 'string'
      || typeof parsed.sourceLabel !== 'string'
      || typeof parsed.syncedAt !== 'string'
    ) {
      return null;
    }
    return {
      candidateName: parsed.candidateName,
      sourceRuntimeId: parsed.sourceRuntimeId,
      sourceLabel: parsed.sourceLabel,
      syncedAt: parsed.syncedAt,
    };
  } catch {
    return null;
  }
}

async function writeMirrorStatus(statusPath: string | null, status: AuthMirrorStatus): Promise<void> {
  if (!statusPath) return;
  await fs.mkdir(path.dirname(statusPath), { recursive: true, mode: 0o700 });
  const temporary = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, statusPath);
}
