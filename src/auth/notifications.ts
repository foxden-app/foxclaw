import type { AppLocale } from '../types.js';
import type { AuthSyncNotification } from './cross_node_sync.js';
import type { AuthMirrorNotification } from './mirror.js';

export type AuthRefreshNotificationItem =
  | { source: 'mirror'; event: AuthMirrorNotification }
  | { source: 'auth_sync'; event: AuthSyncNotification };

export interface AuthRefreshNotificationDestination {
  key: string;
  locale: AppLocale;
  sendMessage: (text: string) => Promise<unknown>;
}

export interface AuthRefreshNotificationAggregator {
  enqueueMirror(destination: AuthRefreshNotificationDestination, event: AuthMirrorNotification): void;
  enqueueAuthSync(destination: AuthRefreshNotificationDestination, event: AuthSyncNotification): boolean;
  flushAll(): Promise<void>;
}

interface AuthNotificationLogger {
  warn(message: string, meta?: unknown): void;
}

interface AuthNotificationQueue {
  locale: AppLocale;
  sendMessage: (text: string) => Promise<unknown>;
  items: AuthRefreshNotificationItem[];
  timer: NodeJS.Timeout | null;
}

const AUTH_REFRESH_NOTIFICATION_AGGREGATE_DELAY_MS = 8_000;
const AUTH_REFRESH_NOTIFICATION_LIST_LIMIT = 8;

export function createAuthRefreshNotificationAggregator(
  logger: AuthNotificationLogger,
  delayMs = AUTH_REFRESH_NOTIFICATION_AGGREGATE_DELAY_MS,
): AuthRefreshNotificationAggregator {
  const queues = new Map<string, AuthNotificationQueue>();

  const flush = async (key: string): Promise<void> => {
    const queue = queues.get(key);
    if (!queue) return;
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
    queues.delete(key);
    const message = formatAggregatedAuthRefreshNotifications(queue.locale, queue.items);
    if (!message) return;
    try {
      await queue.sendMessage(message);
    } catch (error) {
      logger.warn('auth.notification_aggregate_send_failed', { error: formatError(error) });
    }
  };

  const enqueue = (destination: AuthRefreshNotificationDestination, item: AuthRefreshNotificationItem): void => {
    const existing = queues.get(destination.key);
    const queue = existing ?? {
      locale: destination.locale,
      sendMessage: destination.sendMessage,
      items: [],
      timer: null,
    };
    queue.locale = destination.locale;
    queue.sendMessage = destination.sendMessage;
    queue.items.push(item);
    if (queue.timer) {
      clearTimeout(queue.timer);
    }
    queue.timer = setTimeout(() => {
      void flush(destination.key);
    }, delayMs);
    queue.timer.unref();
    queues.set(destination.key, queue);
  };

  return {
    enqueueMirror(destination, event): void {
      enqueue(destination, { source: 'mirror', event });
    },
    enqueueAuthSync(destination, event): boolean {
      if (!isAggregateableAuthSyncNotification(event)) {
        return false;
      }
      enqueue(destination, { source: 'auth_sync', event });
      return true;
    },
    async flushAll(): Promise<void> {
      await Promise.all([...queues.keys()].map((key) => flush(key)));
    },
  };
}

export function isAggregateableAuthSyncNotification(event: AuthSyncNotification): boolean {
  switch (event.kind) {
    case 'candidate_publish_started':
    case 'candidate_publish_completed':
    case 'candidate_publish_failed':
    case 'remote_bundle_received':
    case 'remote_import_imported':
    case 'remote_import_skipped':
    case 'remote_import_failed':
      return true;
    default:
      return false;
  }
}

export function formatAggregatedAuthRefreshNotifications(
  locale: AppLocale,
  items: AuthRefreshNotificationItem[],
): string | null {
  const localSynced: Array<{ candidateName: string; sourceLabel: string }> = [];
  const mirrorRemoteImports: Array<{ candidateName: string; sourceNodeId: string; sourceLabel: string }> = [];
  const publishes = new Map<string, {
    candidateName: string;
    peers: string[];
    state: 'sending' | 'sent' | 'failed';
    reason: string | null;
  }>();
  const remoteBundles = new Map<string, {
    candidateName: string;
    sourceNodeId: string;
    sourceLabel: string;
    peer: string;
    queued: boolean;
  }>();
  const remoteImports = new Map<string, {
    candidateName: string;
    sourceNodeId: string;
    sourceLabel: string;
    peer: string;
    state: 'imported' | 'skipped' | 'failed';
    reason: string | null;
  }>();

  for (const item of items) {
    if (item.source === 'mirror') {
      if (item.event.kind === 'local_synced') {
        localSynced.push({
          candidateName: item.event.candidateName,
          sourceLabel: item.event.sourceLabel,
        });
      } else {
        mirrorRemoteImports.push({
          candidateName: item.event.candidateName,
          sourceNodeId: item.event.sourceNodeId,
          sourceLabel: item.event.sourceLabel,
        });
      }
      continue;
    }

    const event = item.event;
    switch (event.kind) {
      case 'candidate_publish_started':
        publishes.set(event.candidateName, {
          candidateName: event.candidateName,
          peers: event.peers,
          state: 'sending',
          reason: null,
        });
        break;
      case 'candidate_publish_completed':
        publishes.set(event.candidateName, {
          candidateName: event.candidateName,
          peers: event.peers,
          state: 'sent',
          reason: null,
        });
        break;
      case 'candidate_publish_failed':
        publishes.set(event.candidateName, {
          candidateName: event.candidateName,
          peers: event.peers,
          state: 'failed',
          reason: event.reason,
        });
        break;
      case 'remote_bundle_received':
        remoteBundles.set(remoteKey(event), {
          candidateName: event.candidateName,
          sourceNodeId: event.sourceNodeId,
          sourceLabel: event.sourceLabel,
          peer: event.peer,
          queued: event.queued,
        });
        break;
      case 'remote_import_imported':
      case 'remote_import_skipped':
      case 'remote_import_failed':
        remoteImports.set(remoteKey(event), {
          candidateName: event.candidateName,
          sourceNodeId: event.sourceNodeId,
          sourceLabel: event.sourceLabel,
          peer: event.peer,
          state: event.kind === 'remote_import_imported'
            ? 'imported'
            : event.kind === 'remote_import_skipped'
              ? 'skipped'
              : 'failed',
          reason: 'reason' in event ? event.reason : null,
        });
        break;
      default:
        break;
    }
  }

  const lines = [locale === 'zh' ? 'auth 刷新/同步汇总' : 'Auth refresh/sync summary'];
  const failedPublishes = [...publishes.values()].filter((entry) => entry.state === 'failed');
  const failedImports = [...remoteImports.values()].filter((entry) => entry.state === 'failed');
  const sentPublishes = [...publishes.values()].filter((entry) => entry.state === 'sent');
  const sendingPublishes = [...publishes.values()].filter((entry) => entry.state === 'sending');
  const imported = [...remoteImports.values()].filter((entry) => entry.state === 'imported');
  const skipped = [...remoteImports.values()].filter((entry) => entry.state === 'skipped');
  const pendingRemote = [...remoteBundles.entries()]
    .filter(([key]) => !remoteImports.has(key))
    .map(([, entry]) => entry);
  const coveredRemoteImportKeys = new Set([...remoteImports.values()]
    .map((entry) => `${entry.candidateName}\0${entry.sourceNodeId}`));
  const mirrorRemoteOnly = mirrorRemoteImports
    .filter((entry) => !coveredRemoteImportKeys.has(`${entry.candidateName}\0${entry.sourceNodeId}`));

  if (failedPublishes.length > 0) {
    lines.push(formatLine(locale, 'Cross-node send failed', '跨节点发送失败',
      failedPublishes.map((entry) => `${entry.candidateName} -> ${formatPeerList(entry.peers, locale)} (${clipInline(entry.reason ?? '')})`)));
  }
  if (failedImports.length > 0) {
    lines.push(formatLine(locale, 'Cross-node import failed', '跨节点导入失败',
      failedImports.map((entry) => `${entry.candidateName} <- ${formatSource(entry.sourceLabel, entry.sourceNodeId)} (${clipInline(entry.reason ?? '')})`)));
  }
  if (localSynced.length > 0) {
    lines.push(formatLine(locale, 'Same-node mirror', '同节点镜像',
      dedupe(localSynced.map((entry) => `${entry.candidateName} <- ${entry.sourceLabel}`))));
  }
  if (sentPublishes.length > 0) {
    lines.push(formatLine(locale, 'Cross-node sent', '跨节点已发送',
      sentPublishes.map((entry) => `${entry.candidateName} -> ${formatPeerList(entry.peers, locale)}`)));
  }
  if (sendingPublishes.length > 0) {
    lines.push(formatLine(locale, 'Cross-node sending', '跨节点发送中',
      sendingPublishes.map((entry) => `${entry.candidateName} -> ${formatPeerList(entry.peers, locale)}`)));
  }
  if (imported.length > 0) {
    lines.push(formatLine(locale, 'Cross-node imported', '跨节点已导入',
      imported.map((entry) => `${entry.candidateName} <- ${formatSource(entry.sourceLabel, entry.sourceNodeId)}`)));
  }
  if (skipped.length > 0) {
    lines.push(formatLine(locale, 'Cross-node skipped', '跨节点已跳过',
      skipped.map((entry) => `${entry.candidateName} <- ${formatSource(entry.sourceLabel, entry.sourceNodeId)} (${clipInline(entry.reason ?? '')})`)));
  }
  if (pendingRemote.length > 0) {
    lines.push(formatLine(locale, 'Cross-node pending', '跨节点待处理',
      pendingRemote.map((entry) => {
        const state = locale === 'zh'
          ? (entry.queued ? '已排队' : '验证中')
          : (entry.queued ? 'queued' : 'validating');
        return `${entry.candidateName} <- ${formatSource(entry.sourceLabel, entry.sourceNodeId)} (${state})`;
      })));
  }
  if (mirrorRemoteOnly.length > 0) {
    lines.push(formatLine(locale, 'Remote mirror write', '远端镜像写入',
      mirrorRemoteOnly.map((entry) => `${entry.candidateName} <- ${formatSource(entry.sourceLabel, entry.sourceNodeId)}`)));
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

function remoteKey(event: {
  candidateName: string;
  sourceNodeId: string;
  peer: string;
  mode?: string;
}): string {
  return `${event.candidateName}\0${event.sourceNodeId}\0${event.peer}\0${event.mode ?? 'push'}`;
}

function formatLine(locale: AppLocale, enLabel: string, zhLabel: string, values: string[]): string {
  return `${locale === 'zh' ? zhLabel : enLabel}: ${formatCompactList(values, locale)}`;
}

function formatCompactList(values: string[], locale: AppLocale): string {
  const unique = dedupe(values).filter(Boolean);
  if (unique.length <= AUTH_REFRESH_NOTIFICATION_LIST_LIMIT) {
    return unique.join(', ');
  }
  const shown = unique.slice(0, AUTH_REFRESH_NOTIFICATION_LIST_LIMIT).join(', ');
  const remaining = unique.length - AUTH_REFRESH_NOTIFICATION_LIST_LIMIT;
  return locale === 'zh'
    ? `${shown}，另 ${remaining} 项`
    : `${shown}, and ${remaining} more`;
}

function formatPeerList(peers: string[], locale: AppLocale): string {
  return peers.length > 0 ? peers.join(', ') : (locale === 'zh' ? '无' : 'none');
}

function formatSource(sourceLabel: string, sourceNodeId: string): string {
  return sourceLabel === sourceNodeId ? sourceNodeId : `${sourceLabel} / ${sourceNodeId}`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function clipInline(value: string, limit = 120): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, limit - 3))}...`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
