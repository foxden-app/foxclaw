export interface AgInitPayload {
  cwd: string;
  tools?: string[];
  permission_mode?: string;
}

export interface AgInitEvent {
  event: 'init';
  conversation_id: string;
  init: AgInitPayload;
}

export interface AgStepUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

export interface AgToolInfo {
  name: string;
  parameters: Record<string, unknown>;
  output?: string;
}

export interface AgStepUpdatePayload {
  conversation_id: string;
  step_index: number;
  state: 'ACTIVE' | 'DONE' | 'ERROR';
  step_type: 'user_input' | 'system_message' | 'agent_response' | 'tool';
  text_delta?: string;
  tool_name?: string;
  tool_info?: AgToolInfo;
  duration_seconds?: number;
  usage?: AgStepUsage;
}

export interface AgStepUpdateEvent {
  event: 'step_update';
  step_update: AgStepUpdatePayload;
}

export interface AgResultPayload {
  conversation_id: string;
  status: 'SUCCESS' | 'ERROR';
  response: string;
  error?: string;
  duration_seconds: number;
  num_turns: number;
  usage?: AgStepUsage;
}

export interface AgResultEvent {
  event: 'result';
  result: AgResultPayload;
}

export type AgRawEvent = AgInitEvent | AgStepUpdateEvent | AgResultEvent;

export interface AgInitBridgeEvent {
  kind: 'init';
  conversationId: string;
  cwd: string;
  tools: string[];
}

export interface AgTextEvent {
  kind: 'text';
  conversationId: string;
  stepIndex: number;
  delta: string;
  accumulatedText: string;
}

export interface AgToolEvent {
  kind: 'tool';
  conversationId: string;
  stepIndex: number;
  state: 'ACTIVE' | 'DONE' | 'ERROR';
  toolName: string;
  parameters: Record<string, unknown>;
  output?: string | undefined;
}

export interface AgResultBridgeEvent {
  kind: 'result';
  conversationId: string;
  status: 'SUCCESS' | 'ERROR';
  response: string;
  error?: string | undefined;
  usage?: AgStepUsage | undefined;
  durationSeconds: number;
}

export interface AgErrorBridgeEvent {
  kind: 'error';
  conversationId: string | null;
  message: string;
  isQuotaError: boolean;
}

export type AntigravityBridgeEvent =
  | AgInitBridgeEvent
  | AgTextEvent
  | AgToolEvent
  | AgResultBridgeEvent
  | AgErrorBridgeEvent;

export function isQuotaOrAuthError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes('resourceexhausted') ||
    lower.includes('resource_exhausted') ||
    lower.includes('429') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('token expired') ||
    lower.includes('not authenticated') ||
    lower.includes('unauthenticated') ||
    lower.includes('invalid_grant')
  );
}

export function isCapacityOrUnavailableError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes('unavailable') ||
    lower.includes('503') ||
    lower.includes('no capacity available') ||
    lower.includes('overloaded') ||
    lower.includes('high load')
  );
}

/**
 * Normalizes raw NDJSON stream events from `agy` into clean bridge events.
 */
export class AntigravityEventNormalizer {
  private accumulatedTextByStep = new Map<number, string>();
  private lastSeenUsage: AgStepUsage | undefined;

  reset(): void {
    this.accumulatedTextByStep.clear();
    this.lastSeenUsage = undefined;
  }

  accept(raw: AgRawEvent): AntigravityBridgeEvent[] {
    switch (raw.event) {
      case 'init':
        return [
          {
            kind: 'init',
            conversationId: raw.conversation_id,
            cwd: raw.init.cwd,
            tools: raw.init.tools ?? [],
          },
        ];

      case 'step_update': {
        const payload = raw.step_update;
        if (payload.usage) {
          this.lastSeenUsage = payload.usage;
        }
        if (payload.step_type === 'agent_response' && payload.text_delta) {
          const current = this.accumulatedTextByStep.get(payload.step_index) ?? '';
          const next = current + payload.text_delta;
          this.accumulatedTextByStep.set(payload.step_index, next);
          return [
            {
              kind: 'text',
              conversationId: payload.conversation_id,
              stepIndex: payload.step_index,
              delta: payload.text_delta,
              accumulatedText: next,
            },
          ];
        }

        if (payload.step_type === 'tool' && payload.tool_name) {
          return [
            {
              kind: 'tool',
              conversationId: payload.conversation_id,
              stepIndex: payload.step_index,
              state: payload.state,
              toolName: payload.tool_name,
              parameters: payload.tool_info?.parameters ?? {},
              output: payload.tool_info?.output,
            },
          ];
        }

        return [];
      }

      case 'result': {
        const res = raw.result;
        const usage = res.usage ?? this.lastSeenUsage;
        const events: AntigravityBridgeEvent[] = [
          {
            kind: 'result',
            conversationId: res.conversation_id,
            status: res.status,
            response: res.response,
            error: res.error,
            usage,
            durationSeconds: res.duration_seconds,
          },
        ];

        if (res.status === 'ERROR' && res.error) {
          events.push({
            kind: 'error',
            conversationId: res.conversation_id,
            message: res.error,
            isQuotaError: isQuotaOrAuthError(res.error),
          });
        }
        return events;
      }

      default:
        return [];
    }
  }
}
