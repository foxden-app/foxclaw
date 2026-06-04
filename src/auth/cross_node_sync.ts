import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '../logger.js';
import type { AuthMirrorCandidateRecord, AuthMirrorImportResult } from './mirror.js';
import { isAuthCandidateName, parseChatGptAuthMetadata } from './mirror.js';

export interface AuthSyncConfig {
  enabled: boolean;
  transport: 'telegram-private';
  transportLabel?: string | null;
  key: string | null;
  peers: string[];
  nodeId: string | null;
  clusterId: string;
  statePath: string;
  tempDir: string;
}

export interface AuthSyncPeerIdentity {
  userId: string;
  username: string | null;
}

export interface AuthSyncStatus {
  enabled: boolean;
  nodeId: string | null;
  transport: 'telegram-private';
  transportLabel: string | null;
  peers: string[];
  pendingImports: number;
  lastSentAt: string | null;
  lastReceivedAt: string | null;
  lastImportedAt: string | null;
  lastImportCandidate: string | null;
  lastPullAt: string | null;
  lastPullCandidate: string | null;
  lastError: string | null;
  candidateFailures: AuthSyncCandidateFailure[];
  activeLeaseId: string | null;
}

export interface AuthSyncCandidateFailure {
  candidateName: string;
  reason: string;
  sourceNodeId: string | null;
  sourceLabel: string | null;
  peer: string | null;
  mode: AuthSyncRemoteImportMode;
  updatedAt: string;
}

export interface AuthSyncValidationResult {
  ok: boolean;
  reason?: string | null;
}

export type AuthSyncRemoteImportMode = 'push' | 'pull';

export type AuthSyncPullResponseResult = 'sent' | 'candidate_not_found' | 'account_mismatch' | 'not_newer';

export type AuthSyncNotification =
  | { kind: 'candidate_publish_started'; candidateName: string; peers: string[] }
  | { kind: 'candidate_publish_completed'; candidateName: string; peers: string[] }
  | { kind: 'candidate_publish_failed'; candidateName: string; peers: string[]; reason: string }
  | { kind: 'push_all_started'; candidateCount: number; peers: string[] }
  | { kind: 'push_all_completed'; sent: number; skipped: number; peers: string[] }
  | { kind: 'push_all_failed'; sent: number; skipped: number; peers: string[]; reason: string }
  | { kind: 'remote_bundle_received'; candidateName: string; sourceNodeId: string; sourceLabel: string; peer: string; queued: boolean; queueLength: number }
  | { kind: 'remote_import_imported'; candidateName: string; sourceNodeId: string; sourceLabel: string; peer: string; mode: AuthSyncRemoteImportMode }
  | { kind: 'remote_import_skipped'; candidateName: string; sourceNodeId: string; sourceLabel: string; peer: string; mode: AuthSyncRemoteImportMode; reason: string }
  | { kind: 'remote_import_failed'; candidateName: string; sourceNodeId: string; sourceLabel: string; peer: string; mode: AuthSyncRemoteImportMode; reason: string }
  | { kind: 'recovery_started'; candidateName: string; requestId: string; peers: string[]; timeoutMs: number }
  | { kind: 'recovery_peer_empty'; candidateName: string; peer: string; reason: string }
  | { kind: 'recovery_peer_bundle_received'; candidateName: string; peer: string; sourceNodeId: string }
  | { kind: 'recovery_failed'; candidateName: string; requestId?: string; peers: string[]; reason: string; waitMs?: number; peerReachability?: AuthSyncPeerReachability[] }
  | { kind: 'pull_request_received'; candidateName: string; peer: string; requesterNodeId: string }
  | { kind: 'pull_response_sent'; candidateName: string; peer: string; result: AuthSyncPullResponseResult; reason: string | null }
  | { kind: 'sync_error'; reason: string };

export interface AuthSyncImportCallbacks {
  readLocalCandidate: (candidateName: string) => Promise<AuthMirrorCandidateRecord | null>;
  listLocalCandidates: () => Promise<AuthMirrorCandidateRecord[]>;
  validateCandidate: (candidateName: string, raw: string, expectedAccountId: string) => Promise<AuthSyncValidationResult>;
  importCandidate: (
    candidateName: string,
    raw: string,
    source: { nodeId: string; label?: string | null },
  ) => Promise<AuthMirrorImportResult>;
  isIdle: () => boolean;
  notify?: (event: AuthSyncNotification) => Promise<void>;
}

export interface AuthSyncPeerReachability {
  peer: string;
  reachableDuringRequest: boolean;
  lastReceivedAt: string | null;
}

export interface AuthSyncTransport {
  send: (peer: string, envelope: string) => Promise<void>;
}

interface AuthSyncStateFile {
  nodeId?: string;
  seenNonces?: Record<string, number>;
  lastSentAt?: string | null;
  lastReceivedAt?: string | null;
  lastImportedAt?: string | null;
  lastImportCandidate?: string | null;
  lastPullAt?: string | null;
  lastPullCandidate?: string | null;
  lastError?: string | null;
  lastCandidateFailures?: Record<string, AuthSyncCandidateFailure>;
}

interface AuthSyncBundlePayload {
  candidateName: string;
  accountId: string;
  lastRefreshMs: number;
  rawAuth: string;
  authSha256: string;
}

type AuthSyncPlainMessage =
  | ({ kind: 'push.bundle' } & AuthSyncBundlePayload)
  | { kind: 'pull.request'; requestId: string; candidateName: string; accountId: string | null; lastRefreshMs: number | null }
  | { kind: 'pull.response'; requestId: string; bundle: AuthSyncBundlePayload | null; reason?: string | null }
  | { kind: 'digest'; records: Array<{ candidateName: string; accountIdHash: string; lastRefreshMs: number }> }
  | { kind: 'test.ping'; requestId: string }
  | { kind: 'test.pong'; requestId: string; nodeId: string }
  | { kind: 'lease.request'; leaseId: string; reason: string; expiresAt: number }
  | { kind: 'lease.grant'; leaseId: string; expiresAt: number }
  | { kind: 'lease.deny'; leaseId: string; reason: string }
  | { kind: 'lease.release'; leaseId: string };

interface AuthSyncEnvelope {
  magic: 'foxclaw-auth-sync';
  v: 1;
  cluster: string;
  sender: string;
  nonce: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface PendingRemoteImport {
  bundle: AuthSyncBundlePayload;
  sourceNodeId: string;
  sourceLabel: string | null;
  receivedAt: number;
  fromPeer: string;
}

interface AuthSyncImportOutcome {
  ok: boolean;
  imported: boolean;
  reason: string | null;
}

interface PendingPull {
  requestId: string;
  candidateName: string;
  peers: string[];
  emptyReplies: Map<string, string>;
  resolve: (value: boolean) => void;
  timer: NodeJS.Timeout;
  finished: boolean;
  startedAt: number;
}

interface PendingLease {
  leaseId: string;
  grants: Set<string>;
  denies: string[];
  resolve: (value: AuthSyncLeaseResult) => void;
  timer: NodeJS.Timeout;
}

interface PendingTest {
  peers: string[];
  replies: Set<string>;
  resolve: (value: AuthSyncTestResult) => void;
  timer: NodeJS.Timeout;
  finished: boolean;
}

export interface AuthSyncLeaseResult {
  ok: boolean;
  leaseId: string | null;
  reason?: string | null;
}

export interface AuthSyncTestResult {
  sent: number;
  replied: number;
  missing: string[];
}

const ENVELOPE_MAGIC = 'foxclaw-auth-sync';
const NONCE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PULL_TIMEOUT_MS = 12_000;
const TEST_TIMEOUT_MS = 8_000;
const LEASE_TIMEOUT_MS = 8_000;
const LEASE_TTL_MS = 60_000;
const REMOTE_ACCESS_TOKEN_MIN_TTL_MS = 60_000;

export class CrossNodeAuthSync {
  private nodeId: string | null = null;
  private key: Buffer | null = null;
  private readonly peers: string[];
  private readonly peerKeys: Set<string>;
  private readonly pendingImports: PendingRemoteImport[] = [];
  private readonly pendingPulls = new Map<string, PendingPull>();
  private readonly pendingLeases = new Map<string, PendingLease>();
  private readonly pendingTests = new Map<string, PendingTest>();
  private seenNonces = new Map<string, number>();
  private lastPeerActivityAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private importProcessorActive = false;
  private activeRemoteLease: { leaseId: string; peer: string; expiresAt: number } | null = null;
  private activeLocalLease: { leaseId: string; expiresAt: number } | null = null;
  private lastNotifiedError: string | null = null;
  private state: Required<Omit<AuthSyncStateFile, 'seenNonces' | 'nodeId'>> = {
    lastSentAt: null,
    lastReceivedAt: null,
    lastImportedAt: null,
    lastImportCandidate: null,
    lastPullAt: null,
    lastPullCandidate: null,
    lastError: null,
    lastCandidateFailures: {},
  };

  constructor(
    private readonly config: AuthSyncConfig,
    private readonly logger: Logger,
    private readonly transport: AuthSyncTransport,
    private readonly callbacks: AuthSyncImportCallbacks,
  ) {
    this.peers = config.peers.map(normalizeConfiguredPeer).filter(Boolean);
    this.peerKeys = new Set(this.peers.flatMap(expandPeerKeys));
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.key?.trim()) {
      throw new Error('AUTH_SYNC_KEY is required when AUTH_SYNC_ENABLED=true');
    }
    this.key = decodeSharedKey(this.config.key);
    const stored = await readState(this.config.statePath);
    this.nodeId = this.config.nodeId?.trim() || stored.nodeId || createNodeId();
    this.seenNonces = pruneSeenNonces(new Map(Object.entries(stored.seenNonces ?? {})));
    this.state = {
      lastSentAt: stored.lastSentAt ?? null,
      lastReceivedAt: stored.lastReceivedAt ?? null,
      lastImportedAt: stored.lastImportedAt ?? null,
      lastImportCandidate: stored.lastImportCandidate ?? null,
      lastPullAt: stored.lastPullAt ?? null,
      lastPullCandidate: stored.lastPullCandidate ?? null,
      lastError: stored.lastError ?? null,
      lastCandidateFailures: normalizeCandidateFailures(stored.lastCandidateFailures ?? {}),
    };
    await fs.mkdir(this.config.tempDir, { recursive: true, mode: 0o700 });
    await this.writeState();
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(() => {
      this.expireLeases();
      void this.processPendingImports().catch((error) => {
        this.recordError(`pending import failed: ${formatError(error)}`);
      });
    }, 5_000);
    this.timer.unref();
    void this.publishDigest().catch((error) => {
      this.recordError(`initial digest failed: ${formatError(error)}`);
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): AuthSyncStatus {
    return {
      enabled: this.config.enabled,
      nodeId: this.nodeId,
      transport: this.config.transport,
      transportLabel: this.config.transportLabel?.trim() || null,
      peers: this.peers,
      pendingImports: this.pendingImports.length,
      lastSentAt: this.state.lastSentAt,
      lastReceivedAt: this.state.lastReceivedAt,
      lastImportedAt: this.state.lastImportedAt,
      lastImportCandidate: this.state.lastImportCandidate,
      lastPullAt: this.state.lastPullAt,
      lastPullCandidate: this.state.lastPullCandidate,
      lastError: this.state.lastError,
      candidateFailures: Object.values(this.state.lastCandidateFailures)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      activeLeaseId: this.activeLocalLease?.leaseId ?? this.activeRemoteLease?.leaseId ?? null,
    };
  }

  isIdle(): boolean {
    return this.pendingImports.length === 0
      && !this.importProcessorActive
      && this.pendingPulls.size === 0
      && this.pendingLeases.size === 0
      && this.pendingTests.size === 0;
  }

  async publishCandidate(candidateName: string): Promise<boolean> {
    if (!this.isReady()) return false;
    const record = await this.callbacks.readLocalCandidate(candidateName);
    if (!record) return false;
    this.notify({ kind: 'candidate_publish_started', candidateName, peers: [...this.peers] });
    try {
      await this.sendToAll({
        kind: 'push.bundle',
        ...bundleFromRecord(record),
      });
      this.notify({ kind: 'candidate_publish_completed', candidateName, peers: [...this.peers] });
    } catch (error) {
      this.recordError(`candidate publish failed for ${candidateName}: ${formatError(error)}`, false);
      this.notify({
        kind: 'candidate_publish_failed',
        candidateName,
        peers: [...this.peers],
        reason: formatError(error),
      });
      throw error;
    }
    return true;
  }

  async pushAll(): Promise<{ sent: number; skipped: number }> {
    if (!this.isReady()) return { sent: 0, skipped: 0 };
    let sent = 0;
    let skipped = 0;
    const records = await this.callbacks.listLocalCandidates();
    this.notify({ kind: 'push_all_started', candidateCount: records.length, peers: [...this.peers] });
    try {
      for (const record of records) {
        if (!isAuthCandidateName(record.candidateName)) {
          skipped += 1;
          continue;
        }
        await this.sendToAll({
          kind: 'push.bundle',
          ...bundleFromRecord(record),
        });
        sent += 1;
      }
      this.notify({ kind: 'push_all_completed', sent, skipped, peers: [...this.peers] });
      return { sent, skipped };
    } catch (error) {
      this.recordError(`push all failed: ${formatError(error)}`, false);
      this.notify({
        kind: 'push_all_failed',
        sent,
        skipped,
        peers: [...this.peers],
        reason: formatError(error),
      });
      throw error;
    }
  }

  async publishDigest(): Promise<void> {
    if (!this.isReady()) return;
    const records = (await this.callbacks.listLocalCandidates()).map(record => ({
      candidateName: record.candidateName,
      accountIdHash: hashAccountId(record.accountId),
      lastRefreshMs: record.lastRefreshMs,
    }));
    await this.sendToAll({ kind: 'digest', records });
  }

  async requestRecovery(candidateName: string, current?: { accountId: string | null; lastRefreshMs: number | null }): Promise<boolean> {
    if (!this.isReady() || !isAuthCandidateName(candidateName)) return false;
    const requestId = crypto.randomUUID();
    const peers = [...this.peers];
    const startedAt = Date.now();
    this.notify({ kind: 'recovery_started', candidateName, requestId, peers, timeoutMs: PULL_TIMEOUT_MS });
    const result = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingPulls.get(requestId);
        if (pending) {
          pending.finished = true;
          this.pendingPulls.delete(requestId);
          const waitMs = Date.now() - pending.startedAt;
          const peerReachability = this.describePeerReachability(pending.peers, pending.startedAt);
          const reason = formatPullTimeoutReason(pending, waitMs, peerReachability);
          this.logger.warn('auth.sync.pull_timeout', {
            requestId,
            candidateName,
            peers: pending.peers,
            waitMs,
            peerReachability,
          });
          this.notify({
            kind: 'recovery_failed',
            candidateName,
            requestId,
            peers,
            reason,
            waitMs,
            peerReachability,
          });
          resolve(false);
        }
      }, PULL_TIMEOUT_MS);
      timer.unref();
      this.pendingPulls.set(requestId, {
        requestId,
        candidateName,
        peers,
        emptyReplies: new Map(),
        resolve,
        timer,
        finished: false,
        startedAt,
      });
      void this.sendToAll({
        kind: 'pull.request',
        requestId,
        candidateName,
        accountId: current?.accountId ?? null,
        lastRefreshMs: current?.lastRefreshMs ?? null,
      }).catch((error) => {
        clearTimeout(timer);
        this.pendingPulls.delete(requestId);
        this.recordError(`pull request failed: ${formatError(error)}`, false);
        const waitMs = Date.now() - startedAt;
        this.notify({
          kind: 'recovery_failed',
          candidateName,
          requestId,
          peers: [...this.peers],
          reason: `pull request send failed; requestId=${requestId}; candidate=${candidateName}; peers=${this.peers.join(', ') || 'none'}; waitMs=${waitMs}; error=${formatError(error)}`,
          waitMs,
          peerReachability: this.describePeerReachability(peers, startedAt),
        });
        resolve(false);
      });
    });
    this.state.lastPullAt = new Date().toISOString();
    this.state.lastPullCandidate = candidateName;
    await this.writeState();
    return result;
  }

  async acquireRefreshLease(reason: string): Promise<AuthSyncLeaseResult> {
    if (!this.isReady() || this.peers.length === 0) {
      const leaseId = crypto.randomUUID();
      this.activeLocalLease = { leaseId, expiresAt: Date.now() + LEASE_TTL_MS };
      return { ok: true, leaseId };
    }
    if (!this.callbacks.isIdle()) {
      return { ok: false, leaseId: null, reason: 'local runtime is not idle' };
    }
    const leaseId = crypto.randomUUID();
    const expiresAt = Date.now() + LEASE_TTL_MS;
    const result = await new Promise<AuthSyncLeaseResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingLeases.delete(leaseId);
        resolve({
          ok: false,
          leaseId: null,
          reason: `timed out waiting for ${this.peers.length} auth sync peer lease grant(s)`,
        });
      }, LEASE_TIMEOUT_MS);
      timer.unref();
      this.pendingLeases.set(leaseId, {
        leaseId,
        grants: new Set(),
        denies: [],
        resolve,
        timer,
      });
      void this.sendToAll({ kind: 'lease.request', leaseId, reason, expiresAt }).catch((error) => {
        clearTimeout(timer);
        this.pendingLeases.delete(leaseId);
        resolve({ ok: false, leaseId: null, reason: formatError(error) });
      });
    });
    if (result.ok) {
      this.activeLocalLease = { leaseId, expiresAt };
    } else {
      await this.releaseRefreshLease(leaseId);
    }
    return result;
  }

  async releaseRefreshLease(leaseId: string | null): Promise<void> {
    if (!leaseId) return;
    if (this.activeLocalLease?.leaseId === leaseId) {
      this.activeLocalLease = null;
    }
    if (this.isReady()) {
      await this.sendToAll({ kind: 'lease.release', leaseId }).catch((error) => {
        this.recordError(`lease release failed: ${formatError(error)}`);
      });
    }
  }

  async testPeers(): Promise<AuthSyncTestResult> {
    if (!this.isReady()) return { sent: 0, replied: 0, missing: [] };
    const requestId = crypto.randomUUID();
    const peers = [...this.peers];
    const resultPromise = new Promise<AuthSyncTestResult>((resolve) => {
      const timer = setTimeout(() => {
        this.finishPendingTest(requestId);
      }, TEST_TIMEOUT_MS);
      timer.unref();
      this.pendingTests.set(requestId, {
        peers,
        replies: new Set(),
        resolve,
        timer,
        finished: false,
      });
    });
    try {
      await this.sendToAll({ kind: 'test.ping', requestId });
    } catch (error) {
      const pending = this.pendingTests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingTests.delete(requestId);
      }
      throw error;
    }
    if (peers.length === 0) {
      this.finishPendingTest(requestId);
    }
    return resultPromise;
  }

  async handleIncomingEnvelope(rawEnvelope: string, peer: AuthSyncPeerIdentity): Promise<boolean> {
    if (!this.isReady() || !this.isAllowedPeer(peer)) {
      return false;
    }
    const opened = this.openEnvelope(rawEnvelope);
    if (opened.sender === this.nodeId) {
      return false;
    }
    const nonceKey = `${opened.sender}:${opened.envelope.nonce}`;
    if (this.seenNonces.has(nonceKey)) {
      return true;
    }
    this.seenNonces.set(nonceKey, Date.now());
    this.state.lastReceivedAt = new Date().toISOString();
    await this.writeState();
    this.notePeerActivity(normalizePeerIdentity(peer));
    await this.handleMessage(opened.message, opened.sender, peer);
    return true;
  }

  private async handleMessage(message: AuthSyncPlainMessage, senderNodeId: string, peer: AuthSyncPeerIdentity): Promise<void> {
    const sourceLabel = peer.username ? `@${peer.username}` : peer.userId;
    switch (message.kind) {
      case 'push.bundle':
        this.enqueueImport(message, senderNodeId, sourceLabel, normalizePeerIdentity(peer));
        return;
      case 'pull.request':
        await this.handlePullRequest(message, senderNodeId, normalizePeerIdentity(peer));
        return;
      case 'pull.response':
        await this.handlePullResponse(message, senderNodeId, sourceLabel, normalizePeerIdentity(peer));
        return;
      case 'digest':
        await this.handleDigest(message, normalizePeerIdentity(peer));
        return;
      case 'test.ping':
        await this.sendToPeer(normalizePeerIdentity(peer), {
          kind: 'test.pong',
          requestId: message.requestId,
          nodeId: this.nodeId!,
        });
        return;
      case 'test.pong':
        this.handleTestPong(message.requestId, normalizePeerIdentity(peer));
        this.logger.info('auth.sync.test_pong', { peer: normalizePeerIdentity(peer), nodeId: message.nodeId });
        return;
      case 'lease.request':
        await this.handleLeaseRequest(message, normalizePeerIdentity(peer));
        return;
      case 'lease.grant':
      case 'lease.deny':
        this.handleLeaseReply(message, normalizePeerIdentity(peer));
        return;
      case 'lease.release':
        if (this.activeRemoteLease?.leaseId === message.leaseId) {
          this.activeRemoteLease = null;
        }
        return;
      default:
        return;
    }
  }

  private async handlePullRequest(message: Extract<AuthSyncPlainMessage, { kind: 'pull.request' }>, requesterNodeId: string, peer: string): Promise<void> {
    if (!isAuthCandidateName(message.candidateName)) return;
    this.notify({
      kind: 'pull_request_received',
      candidateName: message.candidateName,
      peer,
      requesterNodeId,
    });
    const record = await this.callbacks.readLocalCandidate(message.candidateName);
    if (!record) {
      await this.sendToPeer(peer, { kind: 'pull.response', requestId: message.requestId, bundle: null, reason: 'candidate not found' });
      this.notify({
        kind: 'pull_response_sent',
        candidateName: message.candidateName,
        peer,
        result: 'candidate_not_found',
        reason: 'candidate not found',
      });
      return;
    }
    if (message.accountId && record.accountId !== message.accountId) {
      await this.sendToPeer(peer, { kind: 'pull.response', requestId: message.requestId, bundle: null, reason: 'account mismatch' });
      this.notify({
        kind: 'pull_response_sent',
        candidateName: message.candidateName,
        peer,
        result: 'account_mismatch',
        reason: 'account mismatch',
      });
      return;
    }
    if (message.lastRefreshMs !== null && record.lastRefreshMs <= message.lastRefreshMs) {
      await this.sendToPeer(peer, { kind: 'pull.response', requestId: message.requestId, bundle: null, reason: 'not newer' });
      this.notify({
        kind: 'pull_response_sent',
        candidateName: message.candidateName,
        peer,
        result: 'not_newer',
        reason: 'not newer',
      });
      return;
    }
    await this.sendToPeer(peer, {
      kind: 'pull.response',
      requestId: message.requestId,
      bundle: bundleFromRecord(record),
    });
    this.notify({
      kind: 'pull_response_sent',
      candidateName: message.candidateName,
      peer,
      result: 'sent',
      reason: null,
    });
  }

  private async handlePullResponse(
    message: Extract<AuthSyncPlainMessage, { kind: 'pull.response' }>,
    senderNodeId: string,
    sourceLabel: string,
    peer: string,
  ): Promise<void> {
    const pending = this.pendingPulls.get(message.requestId);
    if (!pending || pending.finished) return;
    const matchedPeer = this.matchConfiguredPeer(peer) ?? peer;
    if (!message.bundle || message.bundle.candidateName !== pending.candidateName) {
      const reason = message.reason ?? 'peer did not return a matching candidate';
      this.notify({
        kind: 'recovery_peer_empty',
        candidateName: pending.candidateName,
        peer,
        reason,
      });
      this.markPullPeerUnavailable(message.requestId, matchedPeer, reason);
      return;
    }
    this.notify({
      kind: 'recovery_peer_bundle_received',
      candidateName: pending.candidateName,
      peer,
      sourceNodeId: senderNodeId,
    });
    const outcome = await this.validateAndImport(message.bundle, senderNodeId, sourceLabel, peer, 'pull');
    if (!outcome.imported) {
      this.markPullPeerUnavailable(message.requestId, matchedPeer, outcome.reason ?? 'peer candidate was not imported');
      return;
    }
    pending.finished = true;
    clearTimeout(pending.timer);
    this.pendingPulls.delete(message.requestId);
    pending.resolve(true);
  }

  private markPullPeerUnavailable(requestId: string, peer: string, reason: string): void {
    const pending = this.pendingPulls.get(requestId);
    if (!pending || pending.finished) return;
    pending.emptyReplies.set(peer, reason);
    if (!pending.peers.every(peerName => pending.emptyReplies.has(peerName))) {
      return;
    }
    pending.finished = true;
    clearTimeout(pending.timer);
    this.pendingPulls.delete(requestId);
    const details = pending.peers
      .map(peerName => `${peerName}: ${pending.emptyReplies.get(peerName) ?? 'no usable candidate'}`)
      .join('; ');
    this.notify({
      kind: 'recovery_failed',
      candidateName: pending.candidateName,
      peers: pending.peers,
      reason: `all peers replied without an importable auth candidate${details ? ` (${details})` : ''}`,
    });
    pending.resolve(false);
  }

  private async handleDigest(message: Extract<AuthSyncPlainMessage, { kind: 'digest' }>, peer: string): Promise<void> {
    const remote = new Map(message.records.map(record => [record.candidateName, record]));
    for (const local of await this.callbacks.listLocalCandidates()) {
      const remoteRecord = remote.get(local.candidateName);
      const shouldSend = !remoteRecord
        || (
          remoteRecord.accountIdHash === hashAccountId(local.accountId)
          && local.lastRefreshMs > remoteRecord.lastRefreshMs
        );
      if (shouldSend) {
        await this.sendToPeer(peer, {
          kind: 'push.bundle',
          ...bundleFromRecord(local),
        });
      }
    }
  }

  private async handleLeaseRequest(message: Extract<AuthSyncPlainMessage, { kind: 'lease.request' }>, peer: string): Promise<void> {
    this.expireLeases();
    if (!this.callbacks.isIdle()) {
      await this.sendToPeer(peer, { kind: 'lease.deny', leaseId: message.leaseId, reason: 'runtime is not idle' });
      return;
    }
    if (this.activeRemoteLease && this.activeRemoteLease.leaseId !== message.leaseId) {
      await this.sendToPeer(peer, { kind: 'lease.deny', leaseId: message.leaseId, reason: 'another refresh lease is active' });
      return;
    }
    this.activeRemoteLease = {
      leaseId: message.leaseId,
      peer,
      expiresAt: Math.min(message.expiresAt, Date.now() + LEASE_TTL_MS),
    };
    await this.sendToPeer(peer, { kind: 'lease.grant', leaseId: message.leaseId, expiresAt: this.activeRemoteLease.expiresAt });
  }

  private handleLeaseReply(message: Extract<AuthSyncPlainMessage, { kind: 'lease.grant' | 'lease.deny' }>, peer: string): void {
    const pending = this.pendingLeases.get(message.leaseId);
    if (!pending) return;
    if (message.kind === 'lease.deny') {
      pending.denies.push(`${peer}: ${message.reason}`);
    } else {
      pending.grants.add(peer);
    }
    if (pending.denies.length > 0) {
      clearTimeout(pending.timer);
      this.pendingLeases.delete(message.leaseId);
      pending.resolve({ ok: false, leaseId: null, reason: pending.denies.join('; ') });
      return;
    }
    if (this.peers.every(peerName => pending.grants.has(peerName))) {
      clearTimeout(pending.timer);
      this.pendingLeases.delete(message.leaseId);
      pending.resolve({ ok: true, leaseId: message.leaseId });
    }
  }

  private enqueueImport(bundle: AuthSyncBundlePayload, sourceNodeId: string, sourceLabel: string | null, fromPeer: string): void {
    const queued = this.importProcessorActive || !this.callbacks.isIdle() || this.pendingImports.length > 0;
    this.pendingImports.push({
      bundle,
      sourceNodeId,
      sourceLabel,
      receivedAt: Date.now(),
      fromPeer,
    });
    this.notify({
      kind: 'remote_bundle_received',
      candidateName: bundle.candidateName,
      sourceNodeId,
      sourceLabel: sourceLabel ?? fromPeer,
      peer: fromPeer,
      queued,
      queueLength: this.pendingImports.length,
    });
    void this.processPendingImports().catch((error) => {
      this.recordError(`remote import failed: ${formatError(error)}`);
    });
  }

  private async processPendingImports(): Promise<void> {
    if (this.importProcessorActive) return;
    if (!this.callbacks.isIdle()) return;
    this.importProcessorActive = true;
    try {
      while (this.pendingImports.length > 0) {
        if (!this.callbacks.isIdle()) return;
        const pending = this.pendingImports.shift()!;
        await this.validateAndImport(pending.bundle, pending.sourceNodeId, pending.sourceLabel, pending.fromPeer, 'push');
      }
    } finally {
      this.importProcessorActive = false;
    }
  }

  private async validateAndImport(
    bundle: AuthSyncBundlePayload,
    sourceNodeId: string,
    sourceLabel: string | null,
    fromPeer: string,
    mode: AuthSyncRemoteImportMode,
  ): Promise<AuthSyncImportOutcome> {
    const source = sourceLabel ?? fromPeer;
    if (!isValidBundle(bundle)) {
      return this.rejectImport(bundle, sourceNodeId, source, fromPeer, mode, 'remote bundle shape is invalid');
    }
    const metadata = parseChatGptAuthMetadata(bundle.rawAuth);
    if (!metadata || metadata.accountId !== bundle.accountId || metadata.lastRefreshMs !== bundle.lastRefreshMs) {
      return this.rejectImport(bundle, sourceNodeId, source, fromPeer, mode, `remote bundle metadata mismatch for ${bundle.candidateName}`);
    }
    if (sha256(bundle.rawAuth) !== bundle.authSha256) {
      return this.rejectImport(bundle, sourceNodeId, source, fromPeer, mode, `remote bundle hash mismatch for ${bundle.candidateName}`);
    }
    const expiresAt = readAccessTokenExpiresAtMs(bundle.rawAuth);
    if (expiresAt === null || expiresAt <= Date.now() + REMOTE_ACCESS_TOKEN_MIN_TTL_MS) {
      return this.rejectImport(bundle, sourceNodeId, source, fromPeer, mode, `remote access token is expired or missing exp for ${bundle.candidateName}`);
    }
    const validation = await this.callbacks.validateCandidate(bundle.candidateName, bundle.rawAuth, bundle.accountId);
    if (!validation.ok) {
      return this.rejectImport(bundle, sourceNodeId, source, fromPeer, mode, `remote candidate validation failed for ${bundle.candidateName}: ${validation.reason ?? 'unknown'}`);
    }
    const result = await this.callbacks.importCandidate(bundle.candidateName, bundle.rawAuth, {
      nodeId: sourceNodeId,
      label: source,
    });
    if (!result.ok) {
      return this.rejectImport(bundle, sourceNodeId, source, fromPeer, mode, `remote candidate import failed for ${bundle.candidateName}: ${result.reason ?? 'unknown'}`);
    }
    const clearedFailure = this.clearCandidateFailure(bundle.candidateName);
    if (result.imported) {
      this.state.lastImportedAt = new Date().toISOString();
      this.state.lastImportCandidate = bundle.candidateName;
      this.state.lastError = null;
      await this.writeState();
      this.logger.info('auth.sync.imported', { candidateName: bundle.candidateName, sourceNodeId });
      this.notify({
        kind: 'remote_import_imported',
        candidateName: bundle.candidateName,
        sourceNodeId,
        sourceLabel: source,
        peer: fromPeer,
        mode,
      });
    } else {
      this.notify({
        kind: 'remote_import_skipped',
        candidateName: bundle.candidateName,
        sourceNodeId,
        sourceLabel: source,
        peer: fromPeer,
        mode,
        reason: result.reason ?? 'local candidate did not need an update',
      });
      if (clearedFailure) {
        await this.writeState();
      }
    }
    return { ok: true, imported: result.imported, reason: result.reason ?? null };
  }

  private async sendToAll(message: AuthSyncPlainMessage): Promise<void> {
    await Promise.all(this.peers.map(peer => this.sendToPeer(peer, message)));
  }

  private async sendToPeer(peer: string, message: AuthSyncPlainMessage): Promise<void> {
    const envelope = this.sealEnvelope(message);
    await this.transport.send(peer, envelope);
    this.state.lastSentAt = new Date().toISOString();
    if (this.state.lastError?.includes('USER_BOT_TO_BOT_DISABLED')) {
      this.state.lastError = null;
    }
    await this.writeState();
  }

  private handleTestPong(requestId: string, peer: string): void {
    const pending = this.pendingTests.get(requestId);
    if (!pending || pending.finished) return;
    const matchedPeer = this.matchConfiguredPeer(peer) ?? peer;
    pending.replies.add(matchedPeer);
    if (pending.peers.every(peerName => pending.replies.has(peerName))) {
      this.finishPendingTest(requestId);
    }
  }

  private finishPendingTest(requestId: string): void {
    const pending = this.pendingTests.get(requestId);
    if (!pending || pending.finished) return;
    pending.finished = true;
    clearTimeout(pending.timer);
    this.pendingTests.delete(requestId);
    const missing = pending.peers.filter(peer => !pending.replies.has(peer));
    pending.resolve({
      sent: pending.peers.length,
      replied: pending.replies.size,
      missing,
    });
  }

  private sealEnvelope(message: AuthSyncPlainMessage): string {
    if (!this.key || !this.nodeId) {
      throw new Error('auth sync is not initialized');
    }
    const nonce = crypto.randomBytes(16).toString('base64url');
    const iv = crypto.randomBytes(12);
    const cluster = hashClusterId(this.config.clusterId);
    const aad = envelopeAad(cluster, this.nodeId, nonce);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveMessageKey(this.key, this.config.clusterId), iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(message), 'utf8')),
      cipher.final(),
    ]);
    const envelope: AuthSyncEnvelope = {
      magic: ENVELOPE_MAGIC,
      v: 1,
      cluster,
      sender: this.nodeId,
      nonce,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    return `${JSON.stringify(envelope)}\n`;
  }

  private openEnvelope(raw: string): { envelope: AuthSyncEnvelope; sender: string; message: AuthSyncPlainMessage } {
    if (!this.key) {
      throw new Error('auth sync is not initialized');
    }
    const envelope = JSON.parse(raw) as Partial<AuthSyncEnvelope>;
    if (
      envelope.magic !== ENVELOPE_MAGIC
      || envelope.v !== 1
      || typeof envelope.cluster !== 'string'
      || typeof envelope.sender !== 'string'
      || typeof envelope.nonce !== 'string'
      || typeof envelope.iv !== 'string'
      || typeof envelope.tag !== 'string'
      || typeof envelope.ciphertext !== 'string'
    ) {
      throw new Error('invalid auth sync envelope');
    }
    if (envelope.cluster !== hashClusterId(this.config.clusterId)) {
      throw new Error('auth sync cluster mismatch');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveMessageKey(this.key, this.config.clusterId),
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(envelopeAad(envelope.cluster, envelope.sender, envelope.nonce), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const message = JSON.parse(plaintext) as AuthSyncPlainMessage;
    return { envelope: envelope as AuthSyncEnvelope, sender: envelope.sender, message };
  }

  private isReady(): boolean {
    return this.config.enabled && this.key !== null && this.nodeId !== null && this.peers.length > 0;
  }

  private isAllowedPeer(peer: AuthSyncPeerIdentity): boolean {
    const keys = [
      ...expandPeerKeys(peer.userId),
      ...(peer.username ? expandPeerKeys(`@${peer.username}`) : []),
    ];
    return keys.some(key => this.peerKeys.has(key));
  }

  private matchConfiguredPeer(peer: string): string | null {
    const keys = new Set(expandPeerKeys(peer));
    return this.peers.find(configuredPeer => expandPeerKeys(configuredPeer).some(key => keys.has(key))) ?? null;
  }

  private expireLeases(): void {
    const now = Date.now();
    if (this.activeRemoteLease && this.activeRemoteLease.expiresAt <= now) {
      this.activeRemoteLease = null;
    }
    if (this.activeLocalLease && this.activeLocalLease.expiresAt <= now) {
      this.activeLocalLease = null;
    }
  }

  private recordError(message: string, notify = true): void {
    this.state.lastError = message;
    this.logger.warn('auth.sync.error', { error: message });
    void this.writeState().catch((error) => {
      this.logger.warn('auth.sync.state_write_failed', { error: formatError(error) });
    });
    if (notify) {
      this.notifyError(message);
    }
  }

  private async rejectImport(
    bundle: AuthSyncBundlePayload,
    sourceNodeId: string,
    sourceLabel: string,
    fromPeer: string,
    mode: AuthSyncRemoteImportMode,
    reason: string,
  ): Promise<AuthSyncImportOutcome> {
    await this.recordCandidateFailure(bundle, sourceNodeId, sourceLabel, fromPeer, mode, reason);
    this.notify({
      kind: 'remote_import_failed',
      candidateName: bundle.candidateName,
      sourceNodeId,
      sourceLabel,
      peer: fromPeer,
      mode,
      reason,
    });
    return { ok: false, imported: false, reason };
  }

  private async recordCandidateFailure(
    bundle: AuthSyncBundlePayload,
    sourceNodeId: string,
    sourceLabel: string,
    fromPeer: string,
    mode: AuthSyncRemoteImportMode,
    reason: string,
  ): Promise<void> {
    const candidateName = typeof bundle.candidateName === 'string' && bundle.candidateName.trim()
      ? bundle.candidateName
      : 'invalid-bundle';
    this.state.lastCandidateFailures[candidateName] = {
      candidateName,
      reason,
      sourceNodeId,
      sourceLabel,
      peer: fromPeer,
      mode,
      updatedAt: new Date().toISOString(),
    };
    this.state.lastCandidateFailures = pruneCandidateFailures(this.state.lastCandidateFailures);
    this.logger.warn('auth.sync.candidate_failed', {
      candidateName,
      sourceNodeId,
      sourceLabel,
      peer: fromPeer,
      mode,
      reason,
    });
    await this.writeState();
  }

  private clearCandidateFailure(candidateName: string): boolean {
    if (!this.state.lastCandidateFailures[candidateName]) {
      return false;
    }
    delete this.state.lastCandidateFailures[candidateName];
    return true;
  }

  private notePeerActivity(peer: string): void {
    const matchedPeer = this.matchConfiguredPeer(peer) ?? peer;
    this.lastPeerActivityAt.set(matchedPeer, Date.now());
  }

  private describePeerReachability(peers: string[], sinceMs: number): AuthSyncPeerReachability[] {
    return peers.map((peer) => {
      const lastActivityAt = this.lastPeerActivityAt.get(peer) ?? null;
      return {
        peer,
        reachableDuringRequest: lastActivityAt !== null && lastActivityAt >= sinceMs,
        lastReceivedAt: lastActivityAt === null ? null : new Date(lastActivityAt).toISOString(),
      };
    });
  }

  private notify(event: AuthSyncNotification): void {
    if (!this.callbacks.notify) return;
    void this.callbacks.notify(event).catch((error) => {
      this.logger.warn('auth.sync.notify_failed', { error: formatError(error) });
    });
  }

  private notifyError(reason: string): void {
    if (this.lastNotifiedError === reason) return;
    this.lastNotifiedError = reason;
    this.notify({ kind: 'sync_error', reason });
  }

  private async writeState(): Promise<void> {
    if (!this.config.enabled) return;
    this.seenNonces = pruneSeenNonces(this.seenNonces);
    await fs.mkdir(path.dirname(this.config.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.config.statePath}.${process.pid}.${Date.now()}.tmp`;
    const state: AuthSyncStateFile = {
      seenNonces: Object.fromEntries(this.seenNonces),
      ...this.state,
    };
    if (this.nodeId) {
      state.nodeId = this.nodeId;
    }
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.config.statePath);
  }
}

export function readAccessTokenExpiresAtMs(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown } };
    const token = typeof parsed.tokens?.access_token === 'string' ? parsed.tokens.access_token : null;
    if (!token) return null;
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function bundleFromRecord(record: AuthMirrorCandidateRecord): AuthSyncBundlePayload {
  return {
    candidateName: record.candidateName,
    accountId: record.accountId,
    lastRefreshMs: record.lastRefreshMs,
    rawAuth: record.raw,
    authSha256: sha256(record.raw),
  };
}

function isValidBundle(value: AuthSyncBundlePayload): boolean {
  return typeof value.candidateName === 'string'
    && isAuthCandidateName(value.candidateName)
    && typeof value.accountId === 'string'
    && typeof value.lastRefreshMs === 'number'
    && Number.isFinite(value.lastRefreshMs)
    && typeof value.rawAuth === 'string'
    && typeof value.authSha256 === 'string';
}

function decodeSharedKey(raw: string): Buffer {
  const value = raw.trim();
  const candidates: Buffer[] = [];
  if (/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    try {
      candidates.push(Buffer.from(value, 'base64url'));
    } catch {
      // Ignore invalid base64url and try other key encodings.
    }
  }
  if (/^[a-fA-F0-9]+$/.test(value) && value.length % 2 === 0) {
    try {
      candidates.push(Buffer.from(value, 'hex'));
    } catch {
      // Ignore invalid hex and try the raw UTF-8 bytes.
    }
  }
  candidates.push(Buffer.from(value, 'utf8'));
  const key = candidates.find(candidate => candidate.length >= 32);
  if (!key) {
    throw new Error('AUTH_SYNC_KEY must decode to at least 32 bytes');
  }
  return key.subarray(0, 32);
}

function deriveMessageKey(key: Buffer, clusterId: string): Buffer {
  const derived = crypto.hkdfSync('sha256', key, Buffer.from('foxclaw-auth-sync-v1'), Buffer.from(clusterId), 32);
  return Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
}

function envelopeAad(cluster: string, sender: string, nonce: string): string {
  return `${ENVELOPE_MAGIC}\n1\n${cluster}\n${sender}\n${nonce}`;
}

function hashClusterId(clusterId: string): string {
  return crypto.createHash('sha256').update(clusterId).digest('hex').slice(0, 24);
}

function hashAccountId(accountId: string): string {
  return crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 24);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeCandidateFailures(raw: Record<string, Partial<AuthSyncCandidateFailure>>): Record<string, AuthSyncCandidateFailure> {
  const failures: Record<string, AuthSyncCandidateFailure> = {};
  for (const [key, value] of Object.entries(raw)) {
    const candidateName = typeof value.candidateName === 'string' && value.candidateName.trim()
      ? value.candidateName
      : key;
    const reason = typeof value.reason === 'string' ? value.reason : '';
    const mode = value.mode === 'pull' ? 'pull' : 'push';
    const updatedAt = typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
      ? value.updatedAt
      : new Date().toISOString();
    if (!candidateName || !reason) {
      continue;
    }
    failures[candidateName] = {
      candidateName,
      reason,
      sourceNodeId: typeof value.sourceNodeId === 'string' ? value.sourceNodeId : null,
      sourceLabel: typeof value.sourceLabel === 'string' ? value.sourceLabel : null,
      peer: typeof value.peer === 'string' ? value.peer : null,
      mode,
      updatedAt,
    };
  }
  return pruneCandidateFailures(failures);
}

function pruneCandidateFailures(failures: Record<string, AuthSyncCandidateFailure>): Record<string, AuthSyncCandidateFailure> {
  return Object.fromEntries(Object.entries(failures)
    .sort(([, left], [, right]) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 20));
}

function formatPullTimeoutReason(
  pending: PendingPull,
  waitMs: number,
  peerReachability: AuthSyncPeerReachability[],
): string {
  const reachable = peerReachability
    .filter((entry) => entry.reachableDuringRequest)
    .map((entry) => entry.peer);
  const reachableSuffix = reachable.length > 0
    ? `; peer reachable but this request timed out: ${reachable.join(', ')}`
    : '';
  return `timed out waiting for ${pending.peers.length} auth sync peer response(s); requestId=${pending.requestId}; candidate=${pending.candidateName}; peers=${pending.peers.join(', ') || 'none'}; waitMs=${waitMs}${reachableSuffix}`;
}

function normalizeConfiguredPeer(peer: string): string {
  const value = peer.trim();
  if (!value) return '';
  return value.startsWith('@') ? value.toLowerCase() : value.toLowerCase();
}

function normalizePeerIdentity(peer: AuthSyncPeerIdentity): string {
  return peer.username ? `@${peer.username.toLowerCase()}` : peer.userId;
}

function expandPeerKeys(peer: string): string[] {
  const value = peer.toLowerCase();
  if (!value) return [];
  if (value.startsWith('@')) {
    return [value, value.slice(1)];
  }
  return [value, `@${value}`];
}

function createNodeId(): string {
  const host = os.hostname().replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 48) || 'node';
  return `${host}-${crypto.randomBytes(5).toString('hex')}`;
}

function pruneSeenNonces(nonces: Map<string, number>): Map<string, number> {
  const cutoff = Date.now() - NONCE_RETENTION_MS;
  for (const [nonce, seenAt] of nonces) {
    if (!Number.isFinite(seenAt) || seenAt < cutoff) {
      nonces.delete(nonce);
    }
  }
  return nonces;
}

async function readState(statePath: string): Promise<AuthSyncStateFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8')) as AuthSyncStateFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
