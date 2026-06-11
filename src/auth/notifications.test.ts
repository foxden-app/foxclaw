import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAggregatedAuthRefreshNotifications,
  isAggregateableAuthSyncNotification,
} from './notifications.js';

test('formats local refresh mirror and cross-node publish as one summary', () => {
  const message = formatAggregatedAuthRefreshNotifications('en', [
    {
      source: 'mirror',
      event: {
        kind: 'local_synced',
        candidateName: 'auth.json_a',
        sourceRuntimeId: 'bot-a',
        sourceLabel: '@bot_a',
      },
    },
    {
      source: 'auth_sync',
      event: {
        kind: 'candidate_publish_started',
        candidateName: 'auth.json_a',
        peers: ['@peer_bot'],
      },
    },
    {
      source: 'auth_sync',
      event: {
        kind: 'candidate_publish_completed',
        candidateName: 'auth.json_a',
        peers: ['@peer_bot'],
      },
    },
  ]);

  assert.match(message ?? '', /Auth refresh\/sync summary/);
  assert.match(message ?? '', /Same-node mirror: auth\.json_a <- @bot_a/);
  assert.match(message ?? '', /Cross-node sent: auth\.json_a -> @peer_bot/);
});

test('formats remote import once when auth sync and mirror both report it', () => {
  const message = formatAggregatedAuthRefreshNotifications('zh', [
    {
      source: 'auth_sync',
      event: {
        kind: 'remote_bundle_received',
        candidateName: 'auth.json_b',
        sourceNodeId: 'node-b',
        sourceLabel: '@peer_bot',
        peer: '@peer_bot',
        queued: false,
        queueLength: 0,
      },
    },
    {
      source: 'mirror',
      event: {
        kind: 'remote_imported',
        candidateName: 'auth.json_b',
        sourceNodeId: 'node-b',
        sourceLabel: '@peer_bot',
      },
    },
    {
      source: 'auth_sync',
      event: {
        kind: 'remote_import_imported',
        candidateName: 'auth.json_b',
        sourceNodeId: 'node-b',
        sourceLabel: '@peer_bot',
        peer: '@peer_bot',
        mode: 'push',
      },
    },
  ]);

  assert.match(message ?? '', /auth 刷新\/同步汇总/);
  assert.match(message ?? '', /跨节点已导入: auth\.json_b <- @peer_bot \/ node-b/);
  assert.doesNotMatch(message ?? '', /远端镜像写入/);
});

test('aggregates refresh-path auth sync notifications only', () => {
  assert.equal(isAggregateableAuthSyncNotification({
    kind: 'candidate_publish_started',
    candidateName: 'auth.json_a',
    peers: [],
  }), true);
  assert.equal(isAggregateableAuthSyncNotification({
    kind: 'recovery_failed',
    candidateName: 'auth.json_a',
    peers: ['@peer_bot'],
    reason: 'not found',
  }), false);
});
