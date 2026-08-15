import {
  classifyAgentOutput,
  inferToolActivityState,
  type RawExecCommandEvent,
  type TurnActivityEvent,
} from './activity.js';

export interface SessionLogCursor {
  activeTurnId: string | null;
  nextMessageIndex: number;
  pendingToolCalls?: SessionToolCall[];
}

export interface SessionLogBootstrap {
  cursor: SessionLogCursor;
  events: TurnActivityEvent[];
  startedTurnId: string | null;
}

export interface SessionLogDiff {
  cursor: SessionLogCursor;
  events: TurnActivityEvent[];
  startedTurnIds: string[];
}

export interface SplitJsonlChunk {
  lines: string[];
  remainder: string;
}

interface SessionRecord {
  type: string;
  payload?: any;
}

interface SessionToolCall {
  callId: string;
  kind: 'custom' | 'function';
  name: string;
}

export function splitJsonlChunk(remainder: string, chunk: string): SplitJsonlChunk {
  const text = `${remainder}${chunk}`;
  if (text.length === 0) {
    return { lines: [], remainder: '' };
  }
  const parts = text.split('\n');
  const nextRemainder = text.endsWith('\n') ? '' : parts.pop() ?? '';
  return {
    lines: parts.filter(line => line.trim().length > 0),
    remainder: nextRemainder,
  };
}

export function bootstrapSessionLog(lines: string[]): SessionLogBootstrap {
  const records = parseRecords(lines);
  let state: SessionLogCursor = { activeTurnId: null, nextMessageIndex: 0 };
  let events: TurnActivityEvent[] = [];

  for (const record of records) {
    const next = applySessionRecord(record, state);
    if (next.startedTurnId) {
      state = next.cursor;
      events = [];
      continue;
    }
    if (!state.activeTurnId) {
      continue;
    }
    if (next.turnCompleted) {
      state = next.cursor;
      events = [];
      continue;
    }
    events.push(...next.events);
    state = next.cursor;
  }

  return {
    cursor: state,
    events,
    startedTurnId: state.activeTurnId,
  };
}

export function applySessionLog(lines: string[], cursor: SessionLogCursor): SessionLogDiff {
  const records = parseRecords(lines);
  let state: SessionLogCursor = { ...cursor };
  const events: TurnActivityEvent[] = [];
  const startedTurnIds: string[] = [];

  for (const record of records) {
    const next = applySessionRecord(record, state);
    if (next.startedTurnId) {
      state = next.cursor;
      startedTurnIds.push(next.startedTurnId);
      continue;
    }
    events.push(...next.events);
    state = next.cursor;
  }

  return {
    cursor: state,
    events,
    startedTurnIds,
  };
}

function parseRecords(lines: string[]): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as SessionRecord;
      if (parsed && typeof parsed.type === 'string') {
        records.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return records;
}

function applySessionRecord(
  record: SessionRecord,
  cursor: SessionLogCursor,
): {
  cursor: SessionLogCursor;
  events: TurnActivityEvent[];
  startedTurnId: string | null;
  turnCompleted: boolean;
} {
  const { type, payload } = record;
  if (type === 'event_msg' && payload?.type === 'task_started' && typeof payload.turn_id === 'string') {
    return {
      cursor: { activeTurnId: payload.turn_id, nextMessageIndex: 0 },
      events: [],
      startedTurnId: payload.turn_id,
      turnCompleted: false,
    };
  }

  const activeTurnId = cursor.activeTurnId;
  if (!activeTurnId) {
    return {
      cursor,
      events: [],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'event_msg' && payload?.type === 'agent_message' && typeof payload.message === 'string') {
    return createSessionTextEvents(activeTurnId, cursor, payload.message, typeof payload.phase === 'string' ? payload.phase : null, false);
  }

  if (
    type === 'event_msg'
    && payload?.type === 'item_completed'
    && payload?.turn_id === activeTurnId
    && normalizeSessionItemType(payload?.item) === 'agentmessage'
  ) {
    const text = extractSessionItemText(payload.item);
    if (text === null) {
      return { cursor, events: [], startedTurnId: null, turnCompleted: false };
    }
    return createSessionTextEvents(
      activeTurnId,
      cursor,
      text,
      typeof payload.item.phase === 'string' ? payload.item.phase : null,
      false,
      false,
      typeof payload.item.id === 'string' ? payload.item.id : null,
    );
  }

  if (
    type === 'event_msg'
    && payload?.type === 'item_completed'
    && payload?.turn_id === activeTurnId
    && normalizeSessionItemType(payload?.item) === 'usermessage'
  ) {
    const text = extractSessionItemText(payload.item)?.trim() ?? '';
    if (!text) {
      return { cursor, events: [], startedTurnId: null, turnCompleted: false };
    }
    return {
      cursor,
      events: [{
        kind: 'user_message',
        turnId: activeTurnId,
        text,
      }],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'response_item' && payload?.type === 'plan' && typeof payload.text === 'string') {
    return createSessionTextEvents(activeTurnId, cursor, payload.text, 'commentary', true, true);
  }

  if (type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
    const text = payload.message.trim();
    if (!text) {
      return { cursor, events: [], startedTurnId: null, turnCompleted: false };
    }
    return {
      cursor,
      events: [{
        kind: 'user_message',
        turnId: activeTurnId,
        text,
      }],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'response_item' && payload?.type === 'function_call' && payload?.name === 'exec_command') {
    const exec = createExecStartEvent(activeTurnId, payload);
    if (!exec) {
      return { cursor, events: [], startedTurnId: null, turnCompleted: false };
    }
    return {
      cursor,
      events: [{
        kind: 'tool_started',
        turnId: activeTurnId,
        exec,
        state: inferToolActivityState(exec),
      }],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'response_item' && payload?.type === 'custom_tool_call') {
    return createSessionToolStart(activeTurnId, cursor, payload, 'custom');
  }

  if (type === 'response_item' && payload?.type === 'function_call') {
    return createSessionToolStart(activeTurnId, cursor, payload, 'function');
  }

  if (type === 'response_item' && payload?.type === 'custom_tool_call_output') {
    return createSessionToolEnd(activeTurnId, cursor, payload, 'custom');
  }

  if (type === 'response_item' && payload?.type === 'function_call_output') {
    return createSessionToolEnd(activeTurnId, cursor, payload, 'function');
  }

  if (type === 'event_msg' && payload?.type === 'exec_command_end' && payload?.turn_id === activeTurnId) {
    const exec = createExecEndEvent(payload);
    if (!exec) {
      return { cursor, events: [], startedTurnId: null, turnCompleted: false };
    }
    return {
      cursor,
      events: [{
        kind: 'tool_completed',
        turnId: activeTurnId,
        exec,
        state: inferToolActivityState(exec),
      }],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'event_msg' && payload?.type === 'task_complete' && payload?.turn_id === activeTurnId) {
    return {
      cursor: { activeTurnId: null, nextMessageIndex: 0 },
      events: [{
        kind: 'turn_completed',
        turnId: activeTurnId,
        state: 'completed',
      }],
      startedTurnId: null,
      turnCompleted: true,
    };
  }

  if (
    type === 'event_msg'
    && (payload?.type === 'turn_aborted' || payload?.type === 'turn_interrupted')
    && payload?.turn_id === activeTurnId
  ) {
    return {
      cursor: { activeTurnId: null, nextMessageIndex: 0 },
      events: [{
        kind: 'turn_completed',
        turnId: activeTurnId,
        state: 'interrupted',
      }],
      startedTurnId: null,
      turnCompleted: true,
    };
  }

  return {
    cursor,
    events: [],
    startedTurnId: null,
    turnCompleted: false,
  };
}

function buildSessionItemId(turnId: string, index: number): string {
  return `${turnId}:session:${index}`;
}

function createSessionTextEvents(
  activeTurnId: string,
  cursor: SessionLogCursor,
  text: string,
  phase: string | null,
  forceCommentary: boolean,
  isPlan = false,
  sourceItemId: string | null = null,
): {
  cursor: SessionLogCursor;
  events: TurnActivityEvent[];
  startedTurnId: string | null;
  turnCompleted: boolean;
} {
  const itemId = sourceItemId ?? buildSessionItemId(activeTurnId, cursor.nextMessageIndex + 1);
  const outputKind = forceCommentary ? 'commentary' : classifyAgentOutput(phase, true);
  const streamOutputKind = forceCommentary ? 'commentary' : classifyAgentOutput(phase, false);
  return {
    cursor: {
      ...cursor,
      activeTurnId,
      nextMessageIndex: cursor.nextMessageIndex + 1,
    },
    events: [
      {
        kind: 'agent_message_started',
        turnId: activeTurnId,
        itemId,
        phase,
        outputKind: streamOutputKind,
        isPlan,
      },
      {
        kind: 'agent_message_delta',
        turnId: activeTurnId,
        itemId,
        delta: text,
        outputKind: streamOutputKind,
        isPlan,
      },
      {
        kind: 'agent_message_completed',
        turnId: activeTurnId,
        itemId,
        phase,
        text,
        outputKind,
        isPlan,
      },
    ],
    startedTurnId: null,
    turnCompleted: false,
  };
}

function createSessionToolStart(
  turnId: string,
  cursor: SessionLogCursor,
  payload: any,
  kind: SessionToolCall['kind'],
): ReturnType<typeof applySessionRecord> {
  const callId = typeof payload?.call_id === 'string' ? payload.call_id : null;
  const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
  if (!callId || !name) {
    return { cursor, events: [], startedTurnId: null, turnCompleted: false };
  }
  const pendingToolCalls = [
    ...(cursor.pendingToolCalls ?? []).filter(call => call.callId !== callId),
    { callId, kind, name },
  ];
  const exec = createSessionToolEvent(turnId, callId, name);
  return {
    cursor: { ...cursor, pendingToolCalls },
    events: [{
      kind: 'tool_started',
      turnId,
      exec,
      state: inferToolActivityState(exec),
    }],
    startedTurnId: null,
    turnCompleted: false,
  };
}

function createSessionToolEnd(
  turnId: string,
  cursor: SessionLogCursor,
  payload: any,
  kind: SessionToolCall['kind'],
): ReturnType<typeof applySessionRecord> {
  const callId = typeof payload?.call_id === 'string' ? payload.call_id : null;
  const pending = callId
    ? (cursor.pendingToolCalls ?? []).find(call => call.callId === callId && call.kind === kind)
    : null;
  if (!pending) {
    return { cursor, events: [], startedTurnId: null, turnCompleted: false };
  }
  const exec = createSessionToolEvent(turnId, pending.callId, pending.name);
  return {
    cursor: {
      ...cursor,
      pendingToolCalls: (cursor.pendingToolCalls ?? []).filter(call => call !== pending),
    },
    events: [{
      kind: 'tool_completed',
      turnId,
      exec,
      state: inferToolActivityState(exec),
    }],
    startedTurnId: null,
    turnCompleted: false,
  };
}

function createSessionToolEvent(turnId: string, callId: string, name: string): RawExecCommandEvent {
  return {
    callId,
    turnId,
    command: [`Tool ${name}`],
    cwd: null,
    parsedCmd: [],
  };
}

function normalizeSessionItemType(item: any): string | null {
  if (typeof item?.type !== 'string') {
    return null;
  }
  return item.type.replace(/[^a-z]/gi, '').toLowerCase();
}

function extractSessionItemText(item: any): string | null {
  if (typeof item?.text === 'string') {
    return item.text;
  }
  if (!Array.isArray(item?.content)) {
    return null;
  }
  const parts = item.content
    .map((entry: any) => typeof entry?.text === 'string' ? entry.text : '')
    .filter(Boolean);
  return parts.length > 0 ? parts.join('') : null;
}

function createExecStartEvent(turnId: string, payload: any): RawExecCommandEvent | null {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
  if (!callId) {
    return null;
  }
  let args: any = null;
  if (typeof payload.arguments === 'string') {
    try {
      args = JSON.parse(payload.arguments);
    } catch {
      args = null;
    }
  }
  const commandText = typeof args?.cmd === 'string' ? args.cmd : null;
  const cwd = typeof args?.workdir === 'string' ? args.workdir : null;
  return {
    callId,
    turnId,
    command: commandText ? ['/bin/bash', '-lc', commandText] : [],
    cwd,
    parsedCmd: [],
  };
}

function createExecEndEvent(payload: any): RawExecCommandEvent | null {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
  if (!callId || !turnId) {
    return null;
  }
  return {
    callId,
    turnId,
    command: Array.isArray(payload.command) ? payload.command.map((entry: unknown) => String(entry)) : [],
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    parsedCmd: Array.isArray(payload.parsed_cmd) ? payload.parsed_cmd : [],
  };
}
