import type {
  OpencodePermissionEvent,
  OpencodeTextDeltaEvent,
  OpencodeToolProgressEvent,
} from './client.js';

export type OpencodeActivityEvent =
  | { kind: 'textDelta'; sessionID: string; messageID: string; partID: string; text: string; delta?: string }
  | { kind: 'toolProgress'; sessionID: string; messageID: string; partID: string; tool: string; status: string; title: string | null; error: string | null }
  | { kind: 'permission'; sessionID: string; permissionID: string; type: string; pattern: string | null; title: string; metadata: Record<string, unknown> }
  | { kind: 'sessionIdle'; sessionID: string }
  | { kind: 'sessionStatus'; sessionID: string; statusType: string };

export function normalizeOpencodeTextDelta(event: OpencodeTextDeltaEvent): OpencodeActivityEvent {
  return {
    kind: 'textDelta',
    sessionID: event.sessionID,
    messageID: event.messageID,
    partID: event.partID,
    text: event.text,
    ...(event.delta !== undefined ? { delta: event.delta } : {}),
  };
}

export function normalizeOpencodeToolProgress(event: OpencodeToolProgressEvent): OpencodeActivityEvent {
  return {
    kind: 'toolProgress',
    sessionID: event.sessionID,
    messageID: event.messageID,
    partID: event.partID,
    tool: event.tool,
    status: event.status,
    title: event.title,
    error: event.error,
  };
}

export function normalizeOpencodePermission(event: OpencodePermissionEvent): OpencodeActivityEvent {
  const pattern = Array.isArray(event.pattern) ? event.pattern.join(', ') : (event.pattern ?? null);
  return {
    kind: 'permission',
    sessionID: event.sessionID,
    permissionID: event.id,
    type: event.type,
    pattern,
    title: event.title,
    metadata: event.metadata,
  };
}
