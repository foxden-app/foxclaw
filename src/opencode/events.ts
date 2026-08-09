import type {
  Event,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
} from '@opencode-ai/sdk/v2';

export interface OpencodeTextEvent {
  kind: 'text';
  sessionId: string;
  messageId: string;
  partId: string;
  text: string;
  delta: string | null;
}

export interface OpencodeToolEvent {
  kind: 'tool';
  sessionId: string;
  messageId: string;
  partId: string;
  callId: string;
  tool: string;
  status: string;
  title: string | null;
  error: string | null;
}

export type OpencodeBridgeEvent =
  | OpencodeTextEvent
  | OpencodeToolEvent
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'permissionResolved'; sessionId: string; requestId: string }
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'questionResolved'; sessionId: string; requestId: string }
  | { kind: 'status'; sessionId: string; status: SessionStatus }
  | { kind: 'idle'; sessionId: string }
  | { kind: 'error'; sessionId: string | null; message: string };

/**
 * Turns OpenCode's public SSE events into the small, stable event surface used
 * by the Telegram bridge. State is intentionally kept here so reconnect and
 * delta handling can be tested without starting a real server.
 */
export class OpencodeEventNormalizer {
  private readonly roles = new Map<string, Message['role']>();
  private readonly textByPart = new Map<string, string>();
  private readonly sessionByMessage = new Map<string, string>();

  reset(): void {
    this.roles.clear();
    this.textByPart.clear();
    this.sessionByMessage.clear();
  }

  accept(event: Event): OpencodeBridgeEvent[] {
    switch (event.type) {
      case 'message.updated': {
        this.roles.set(event.properties.info.id, event.properties.info.role);
        this.sessionByMessage.set(event.properties.info.id, event.properties.info.sessionID);
        return [];
      }
      case 'message.part.delta': {
        if (event.properties.field !== 'text' || this.roles.get(event.properties.messageID) !== 'assistant') {
          return [];
        }
        const key = partKey(event.properties.messageID, event.properties.partID);
        const text = `${this.textByPart.get(key) ?? ''}${event.properties.delta}`;
        this.textByPart.set(key, text);
        return [{
          kind: 'text',
          sessionId: event.properties.sessionID,
          messageId: event.properties.messageID,
          partId: event.properties.partID,
          text,
          delta: event.properties.delta,
        }];
      }
      case 'message.part.updated':
        return this.normalizePart(event.properties.part);
      case 'permission.asked':
        return [{ kind: 'permission', request: event.properties }];
      case 'permission.replied':
        return [{
          kind: 'permissionResolved',
          sessionId: event.properties.sessionID,
          requestId: event.properties.requestID,
        }];
      case 'question.asked':
        return [{ kind: 'question', request: event.properties }];
      case 'question.replied':
      case 'question.rejected':
        return [{
          kind: 'questionResolved',
          sessionId: event.properties.sessionID,
          requestId: event.properties.requestID,
        }];
      case 'session.status':
        if (event.properties.status.type === 'idle') this.clearSession(event.properties.sessionID);
        return [{ kind: 'status', sessionId: event.properties.sessionID, status: event.properties.status }];
      case 'session.idle':
        this.clearSession(event.properties.sessionID);
        return [{ kind: 'idle', sessionId: event.properties.sessionID }];
      case 'session.error':
        if (event.properties.sessionID) this.clearSession(event.properties.sessionID);
        return [{
          kind: 'error',
          sessionId: event.properties.sessionID ?? null,
          message: formatOpencodeError(event.properties.error),
        }];
      default:
        return [];
    }
  }

  private normalizePart(part: Part): OpencodeBridgeEvent[] {
    if (part.type === 'text') {
      if (this.roles.get(part.messageID) !== 'assistant') return [];
      const key = partKey(part.messageID, part.id);
      const previous = this.textByPart.get(key) ?? '';
      this.textByPart.set(key, part.text);
      if (part.text === previous) return [];
      return [{
        kind: 'text',
        sessionId: part.sessionID,
        messageId: part.messageID,
        partId: part.id,
        text: part.text,
        delta: part.text.startsWith(previous) ? part.text.slice(previous.length) : null,
      }];
    }
    if (part.type !== 'tool') return [];
    const state = part.state;
    return [{
      kind: 'tool',
      sessionId: part.sessionID,
      messageId: part.messageID,
      partId: part.id,
      callId: part.callID,
      tool: part.tool,
      status: state.status,
      title: 'title' in state && typeof state.title === 'string' ? state.title : null,
      error: state.status === 'error' ? state.error : null,
    }];
  }

  private clearSession(sessionId: string): void {
    for (const [messageId, owner] of this.sessionByMessage) {
      if (owner !== sessionId) continue;
      this.sessionByMessage.delete(messageId);
      this.roles.delete(messageId);
      for (const key of this.textByPart.keys()) {
        if (key.startsWith(`${messageId}:`)) this.textByPart.delete(key);
      }
    }
  }
}

function partKey(messageId: string, partId: string): string {
  return `${messageId}:${partId}`;
}

export function formatOpencodeError(error: unknown): string {
  if (!error) return 'OpenCode session failed';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const record = error as { message?: unknown; name?: unknown; data?: { message?: unknown } };
    if (typeof record.data?.message === 'string') return record.data.message;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.name === 'string') return record.name;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
