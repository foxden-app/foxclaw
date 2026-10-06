import {
  CodexAuthQuotaSnapshot,
  CodexAuthCandidate,
  CodexAuthState,
  CodexAuthQuotaIdentity,
  CODEX_AUTH_QUOTA_SNAPSHOT_FILENAME,
} from './state_types.js';
import {
  chatGptAuthMetadataMatchesCandidateName,
  readChatGptAuthRecord,
  readChatGptAuthMetadata,
  type ChatGptAuthMetadata,
} from '../auth/mirror.js';
import {
  selectCodexRateLimitSnapshot,
  authQuotaSnapshotFromRateLimit,
  isFiniteCodexAuthQuotaSnapshotRecord,
  mergeCodexAuthQuotaSnapshots,
  codexAuthQuotaSnapshotFromRecord,
  isCodexAuthQuotaSnapshot,
  normalizeCodexAuthQuotaSnapshot,
} from './auth_presentation.js';
import { formatUserError } from './shared_helpers.js';
import type { CodexRateLimitSnapshot } from '../types.js';
import { isCodexApiKeyAuthCandidate } from './auth_files.js';
import { readAccessTokenExpiresAtMs } from '../auth/cross_node_sync.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { CodexAppClient } from '../codex_app/client.js';

export class CodexAuthQuotaService {
  private authQuotaSnapshots: Record<string, CodexAuthQuotaSnapshot> = {};
  private authQuotaSnapshotsLoaded = false;
  constructor(private readonly config: AppConfig, private readonly store: BridgeStore, private readonly logger: Logger, private readonly app: Pick<CodexAppClient, 'readAccountRateLimits'>, private readonly syncCodexAuthCandidate: (name: string) => Promise<void>) {}

  async refreshCurrentCodexAuthQuota(state: CodexAuthState): Promise<void> {
    const candidate = state.candidates.find(entry => entry.isCurrent);
    if (!candidate) {
      return;
    }
    if (candidate.state === 'needs_repair') {
      return;
    }
    try {
      const metadata = await readChatGptAuthMetadata(candidate.path);
      if (!metadata || !chatGptAuthMetadataMatchesCandidateName(candidate.name, metadata)) {
        return;
      }
      const snapshot = selectCodexRateLimitSnapshot(await this.app.readAccountRateLimits());
      if (!snapshot) {
        return;
      }
      const quota = authQuotaSnapshotFromRateLimit(
        snapshot,
        metadata?.accountId ?? null,
        metadata?.quotaIdentityId ?? null,
      );
      candidate.quota = quota;
      await this.recordCodexAuthQuotaSnapshot(candidate.name, metadata, snapshot);
      await this.applySharedCodexAuthQuotaSnapshots(state);
      await this.syncCodexAuthCandidate(candidate.name);
    } catch (error) {
      this.logger.warn('codex.auth_quota_refresh_failed', { error: formatUserError(error) });
    }
  }

  async applySharedCodexAuthQuotaSnapshots(
    state: CodexAuthState,
    candidateQuotaIdentities?: Map<string, CodexAuthQuotaIdentity>,
  ): Promise<void> {
    const quotaIdentities = candidateQuotaIdentities ?? await this.readCodexAuthCandidateQuotaIdentities(state.candidates);
    const uniqueQuotaIdentityIds = [...new Set([...quotaIdentities.values()].map(identity => identity.quotaIdentityId))];
    if (uniqueQuotaIdentityIds.length === 0) {
      return;
    }
    const snapshotsByIdentity = new Map<string, CodexAuthQuotaSnapshot>();
    for (const record of this.store.listCodexAuthQuotaSnapshots(uniqueQuotaIdentityIds)) {
      if (!isFiniteCodexAuthQuotaSnapshotRecord(record)) {
        continue;
      }
      snapshotsByIdentity.set(
        record.quotaIdentityId,
        mergeCodexAuthQuotaSnapshots(
          snapshotsByIdentity.get(record.quotaIdentityId) ?? null,
          codexAuthQuotaSnapshotFromRecord(record),
        )!,
      );
    }
    for (const candidate of state.candidates) {
      const quotaIdentity = quotaIdentities.get(candidate.name);
      if (!quotaIdentity) {
        continue;
      }
      candidate.quota = mergeCodexAuthQuotaSnapshots(
        candidate.quota,
        snapshotsByIdentity.get(quotaIdentity.quotaIdentityId) ?? null,
      );
    }
  }

  async recordCodexAuthQuotaSnapshot(
    candidateName: string,
    metadata: ChatGptAuthMetadata | null,
    snapshot: CodexRateLimitSnapshot,
  ): Promise<void> {
    const quota = authQuotaSnapshotFromRateLimit(
      snapshot,
      metadata?.accountId ?? null,
      metadata?.quotaIdentityId ?? null,
    );
    this.authQuotaSnapshots[candidateName] = quota;
    if (metadata) {
      this.store.setCodexAuthQuotaSnapshot(
        this.authRuntimeId(),
        candidateName,
        metadata.accountId,
        metadata.quotaIdentityId,
        quota,
      );
    }
    await this.writeCodexAuthQuotaSnapshots();
  }

  async readCodexAuthCandidateQuotaIdentities(candidates: CodexAuthCandidate[]): Promise<Map<string, CodexAuthQuotaIdentity>> {
    const entries = await Promise.all(candidates.map(async (candidate) => {
      const record = await readChatGptAuthRecord(candidate.path);
      const metadataMatchesName = record
        ? chatGptAuthMetadataMatchesCandidateName(candidate.name, record)
        : false;
      candidate.credentialKind = record && metadataMatchesName
        ? 'chatgpt'
        : await isCodexApiKeyAuthCandidate(candidate.path)
          ? 'api-key'
          : 'invalid';
      candidate.credentialLastRefreshMs = record && metadataMatchesName ? record.lastRefreshMs : null;
      candidate.credentialExpiresAtMs = record && metadataMatchesName ? readAccessTokenExpiresAtMs(record.raw) : null;
      return [candidate.name, record && metadataMatchesName ? {
        accountId: record.accountId,
        quotaIdentityId: record.quotaIdentityId,
      } : null] as const;
    }));
    const quotaIdentities = new Map<string, CodexAuthQuotaIdentity>();
    for (const [name, quotaIdentity] of entries) {
      if (quotaIdentity) {
        quotaIdentities.set(name, quotaIdentity);
      }
    }
    return quotaIdentities;
  }

  codexAuthQuotaSnapshotMatchesIdentity(
    snapshot: CodexAuthQuotaSnapshot | null,
    identity: CodexAuthQuotaIdentity | null,
  ): snapshot is CodexAuthQuotaSnapshot {
    if (!snapshot) {
      return false;
    }
    const snapshotIdentityId = snapshot.quotaIdentityId ?? snapshot.accountId ?? null;
    if (!snapshotIdentityId) {
      return identity === null;
    }
    return identity !== null && snapshotIdentityId === identity.quotaIdentityId;
  }

  async readCodexAuthQuotaSnapshots(): Promise<Record<string, CodexAuthQuotaSnapshot>> {
    if (this.authQuotaSnapshotsLoaded) {
      return this.authQuotaSnapshots;
    }
    this.authQuotaSnapshotsLoaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.codexAuthQuotaSnapshotPath(), 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') {
        for (const [name, value] of Object.entries(parsed)) {
          if (isCodexAuthQuotaSnapshot(value)) {
            this.authQuotaSnapshots[name] = normalizeCodexAuthQuotaSnapshot(value);
          }
        }
      }
    } catch {
      // A missing or invalid historical cache should not block the auth panel.
    }
    return this.authQuotaSnapshots;
  }

  async writeCodexAuthQuotaSnapshots(): Promise<void> {
    const snapshotPath = this.codexAuthQuotaSnapshotPath();
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(this.authQuotaSnapshots, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, snapshotPath);
  }

  codexAuthQuotaSnapshotPath(): string {
    return path.join(path.dirname(this.config.statusPath), this.runtimeSnapshotFilename(CODEX_AUTH_QUOTA_SNAPSHOT_FILENAME));
  }
  private authRuntimeId(): string { return this.config.tgScopeBotId ?? 'default'; }
  private runtimeSnapshotFilename(filename: string): string { return this.config.tgScopeBotId ? filename.replace(/\.json$/, `-${this.config.tgScopeBotId}.json`) : filename; }
}
