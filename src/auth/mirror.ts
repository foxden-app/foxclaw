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

export interface AuthMirrorExternalStatus extends AuthMirrorStatus {
  remoteNodeId?: string | null;
}

export interface AuthMirrorRecovery {
  candidateName: string;
  sourceRuntimeId: string;
  sourceCandidateName: string;
  lastRefreshMs: number;
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

export interface ChatGptAuthMetadata {
  accountId: string;
  lastRefreshMs: number;
}

export interface ChatGptAuthRecord extends ChatGptAuthMetadata {
  raw: string;
}

export interface AuthMirrorCandidateRecord extends ChatGptAuthRecord {
  candidateName: string;
  sourceRuntimeId: string;
  sourceLabel: string;
}

export interface AuthMirrorImportResult {
  ok: boolean;
  imported: boolean;
  reason?: string | null;
  record?: AuthMirrorCandidateRecord;
}

export interface AuthMirrorSyncedEvent {
  status: AuthMirrorStatus;
  record: AuthMirrorCandidateRecord;
}

export interface AuthMirrorHooks {
  onSynced?: (event: AuthMirrorSyncedEvent) => Promise<void> | void;
}

const AUTH_SCAN_INTERVAL_MS = 5_000;

export class AuthCandidateMirror {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastSyncedRefresh = new Map<string, number>();
  private readonly lastValidationFailures = new Map<string, string>();
  private readonly activeCandidateSyncs = new Set<string>();
  private activeOperations = 0;
  private lastStatus: AuthMirrorStatus | null = null;

  constructor(
    private readonly canonicalDir: string,
    private readonly runtimes: AuthMirrorRuntime[],
    private readonly logger: Logger,
    private readonly statusPath: string | null = null,
    private readonly hooks: AuthMirrorHooks = {},
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

  async readNewestCandidate(candidateName: string): Promise<AuthMirrorCandidateRecord | null> {
    if (!isAuthCandidateName(candidateName)) return null;
    return this.withActivity(async () => this.findNewestRecord(
      (entry) => entry.candidateName === candidateName,
    ));
  }

  async readRuntimeCandidate(runtimeId: string, candidateName: string): Promise<AuthMirrorCandidateRecord | null> {
    if (!isAuthCandidateName(candidateName)) return null;
    return this.withActivity(async () => {
      const runtime = this.runtimes.find((entry) => entry.id === runtimeId);
      const authDir = runtimeId === 'canonical' ? this.canonicalDir : runtime?.authDir;
      if (!authDir) return null;
      const record = await readChatGptAuthRecord(path.join(authDir, candidateName));
      if (!record) return null;
      return {
        ...record,
        candidateName,
        sourceRuntimeId: runtimeId,
        sourceLabel: runtime?.label ?? runtimeId,
      };
    });
  }

  async listNewestCandidates(): Promise<AuthMirrorCandidateRecord[]> {
    return this.withActivity(async () => {
      const byName = new Map<string, AuthMirrorCandidateRecord>();
      for (const entry of await this.collectAuthRecords()) {
        if (!isAuthCandidateName(entry.candidateName)) continue;
        const sourceLabel = this.runtimeLabel(entry.runtimeId);
        const candidate: AuthMirrorCandidateRecord = {
          ...entry.record,
          candidateName: entry.candidateName,
          sourceRuntimeId: entry.runtimeId,
          sourceLabel,
        };
        const current = byName.get(entry.candidateName);
        if (!current || candidate.lastRefreshMs > current.lastRefreshMs) {
          byName.set(entry.candidateName, candidate);
        }
      }
      return [...byName.values()].sort((a, b) => a.candidateName.localeCompare(b.candidateName));
    });
  }

  async syncRuntimeCandidate(runtimeId: string, candidateName: string): Promise<boolean> {
    if (!isAuthCandidateName(candidateName)) return false;
    const runtime = this.runtimes.find((entry) => entry.id === runtimeId);
    if (!runtime) return false;
    return this.withActivity(() => this.propagateValidatedCandidate(runtime, candidateName));
  }

  async recoverRuntimeCandidate(runtimeId: string, candidateName: string): Promise<AuthMirrorRecovery | null> {
    if (!isAuthCandidateName(candidateName)) return null;
    const runtime = this.runtimes.find((entry) => entry.id === runtimeId);
    if (!runtime) return null;
    return this.withActivity(async () => {
      const destinationPath = path.join(runtime.authDir, candidateName);
      const destination = await readChatGptAuthRecord(destinationPath);
      if (!destination) return null;
      const sources = await this.collectAuthRecords();
      const newest = sources
        .filter(entry => entry.record.accountId === destination.accountId)
        .reduce<(typeof sources)[number] | null>((current, entry) => (
          !current || entry.record.lastRefreshMs > current.record.lastRefreshMs ? entry : current
        ), null);
      if (!newest || newest.record.lastRefreshMs <= destination.lastRefreshMs) {
        return null;
      }
      await atomicWrite(destinationPath, newest.record.raw);
      this.logger.info('auth.mirror.recovered', {
        runtimeId,
        candidateName,
        sourceRuntimeId: newest.runtimeId,
        sourceCandidateName: newest.candidateName,
      });
      return {
        candidateName,
        sourceRuntimeId: newest.runtimeId,
        sourceCandidateName: newest.candidateName,
        lastRefreshMs: newest.record.lastRefreshMs,
      };
    });
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

  async importExternalCandidate(
    candidateName: string,
    raw: string,
    source: { nodeId: string; label?: string | null },
  ): Promise<AuthMirrorImportResult> {
    if (!isAuthCandidateName(candidateName)) {
      return { ok: false, imported: false, reason: 'invalid candidate name' };
    }
    return this.withActivity(async () => {
      if (this.activeCandidateSyncs.has(candidateName)) {
        return { ok: false, imported: false, reason: 'candidate sync already active' };
      }
      this.activeCandidateSyncs.add(candidateName);
      try {
        const metadata = parseChatGptAuthMetadata(raw);
        if (!metadata) {
          return { ok: false, imported: false, reason: 'invalid ChatGPT auth payload' };
        }
        const existing = (await this.collectAuthRecords())
          .filter(entry => entry.candidateName === candidateName);
        const conflicting = existing.find(entry => entry.record.accountId !== metadata.accountId);
        if (conflicting) {
          return { ok: false, imported: false, reason: 'same candidate belongs to a different account' };
        }
        const newest = existing.reduce<(typeof existing)[number] | null>((current, entry) => (
          !current || entry.record.lastRefreshMs > current.record.lastRefreshMs ? entry : current
        ), null);
        const previousRefresh = Math.max(newest?.record.lastRefreshMs ?? 0, this.lastSyncedRefresh.get(candidateName) ?? 0);
        if (metadata.lastRefreshMs <= previousRefresh) {
          return { ok: true, imported: false, reason: 'local candidate is already newer or equal' };
        }

        await atomicWrite(path.join(this.canonicalDir, candidateName), raw);
        for (const target of this.runtimes) {
          await atomicWrite(path.join(target.authDir, candidateName), raw);
        }
        this.lastSyncedRefresh.set(candidateName, metadata.lastRefreshMs);
        const sourceLabel = source.label?.trim() || source.nodeId;
        this.lastStatus = {
          candidateName,
          sourceRuntimeId: `remote:${source.nodeId}`,
          sourceLabel,
          syncedAt: new Date().toISOString(),
        };
        await writeMirrorStatus(this.statusPath, this.lastStatus);
        this.logger.info('auth.mirror.remote_imported', { candidateName, sourceNodeId: source.nodeId });
        const message = `${candidateName} has been synchronized from remote node ${sourceLabel}.`;
        await Promise.allSettled(this.runtimes.map((target) => target.notify?.(message)));
        return {
          ok: true,
          imported: true,
          record: {
            raw,
            ...metadata,
            candidateName,
            sourceRuntimeId: `remote:${source.nodeId}`,
            sourceLabel,
          },
        };
      } finally {
        this.activeCandidateSyncs.delete(candidateName);
      }
    });
  }

  private async propagateValidatedCandidate(runtime: AuthMirrorRuntime, name: string): Promise<boolean> {
    if (this.activeCandidateSyncs.has(name)) {
      return false;
    }
    this.activeCandidateSyncs.add(name);
    try {
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
        const reason = validation.reason ?? 'unknown';
        const failureKey = `${runtime.id}:${name}`;
        const failureValue = `${record.lastRefreshMs}:${reason}`;
        if (this.lastValidationFailures.get(failureKey) !== failureValue) {
          this.lastValidationFailures.set(failureKey, failureValue);
          this.logger.warn('auth.mirror.validation_failed', {
            runtimeId: runtime.id,
            name,
            reason,
          });
        }
        return false;
      }
      this.lastValidationFailures.delete(`${runtime.id}:${name}`);
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
      await this.hooks.onSynced?.({
        status: this.lastStatus,
        record: {
          ...record,
          candidateName: name,
          sourceRuntimeId: runtime.id,
          sourceLabel,
        },
      });
      return true;
    } finally {
      this.activeCandidateSyncs.delete(name);
    }
  }

  private async validateRuntimeCandidate(
    runtime: AuthMirrorRuntime,
    name: string,
    record: ChatGptAuthRecord,
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

  private async collectAuthRecords(): Promise<Array<{
    runtimeId: string;
    candidateName: string;
    record: ChatGptAuthRecord;
  }>> {
    const directories = [
      { runtimeId: 'canonical', authDir: this.canonicalDir },
      ...this.runtimes.map(runtime => ({ runtimeId: runtime.id, authDir: runtime.authDir })),
    ];
    const records: Array<{ runtimeId: string; candidateName: string; record: ChatGptAuthRecord }> = [];
    for (const directory of directories) {
      const names = new Set(['auth.json', ...await listAuthCandidateNames(directory.authDir)]);
      for (const candidateName of names) {
        const record = await readChatGptAuthRecord(path.join(directory.authDir, candidateName));
        if (record) {
          records.push({ runtimeId: directory.runtimeId, candidateName, record });
        }
      }
    }
    return records;
  }

  private async reconcileCandidateAtStartup(name: string): Promise<void> {
    const paths = [
      path.join(this.canonicalDir, name),
      ...this.runtimes.map((runtime) => path.join(runtime.authDir, name)),
    ];
    const records = (await Promise.all(paths.map(async (sourcePath) => ({
      sourcePath,
      record: await readChatGptAuthRecord(sourcePath),
    })))).filter((entry): entry is { sourcePath: string; record: ChatGptAuthRecord } => entry.record !== null);
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

  private async findNewestRecord(
    predicate: (entry: { runtimeId: string; candidateName: string; record: ChatGptAuthRecord }) => boolean,
  ): Promise<AuthMirrorCandidateRecord | null> {
    const newest = (await this.collectAuthRecords())
      .filter(predicate)
      .reduce<{
        runtimeId: string;
        candidateName: string;
        record: ChatGptAuthRecord;
      } | null>((current, entry) => (
        !current || entry.record.lastRefreshMs > current.record.lastRefreshMs ? entry : current
      ), null);
    if (!newest) return null;
    return {
      ...newest.record,
      candidateName: newest.candidateName,
      sourceRuntimeId: newest.runtimeId,
      sourceLabel: this.runtimeLabel(newest.runtimeId),
    };
  }

  private runtimeLabel(runtimeId: string): string {
    if (runtimeId === 'canonical') return 'canonical';
    const runtime = this.runtimes.find((entry) => entry.id === runtimeId);
    return runtime?.label ?? runtimeId;
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

export async function readChatGptAuthRecord(filePath: string): Promise<ChatGptAuthRecord | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const metadata = parseChatGptAuthMetadata(raw);
    if (!metadata) return null;
    return { raw, ...metadata };
  } catch {
    return null;
  }
}

export async function readChatGptAuthMetadata(filePath: string): Promise<ChatGptAuthMetadata | null> {
  try {
    return parseChatGptAuthMetadata(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function parseChatGptAuthMetadata(raw: string): ChatGptAuthMetadata | null {
  try {
    const parsed = JSON.parse(raw) as {
      tokens?: { account_id?: unknown };
      last_refresh?: unknown;
    };
    const accountId = typeof parsed.tokens?.account_id === 'string' ? parsed.tokens.account_id : '';
    const lastRefreshMs = typeof parsed.last_refresh === 'string' ? Date.parse(parsed.last_refresh) : NaN;
    if (!accountId || !Number.isFinite(lastRefreshMs)) return null;
    return { accountId, lastRefreshMs };
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
