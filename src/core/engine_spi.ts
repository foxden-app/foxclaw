import type { StagedAttachment } from './attachment_types.js';
import type { AppLocale, AccessPresetValue } from '../types.js';
import type { BackendUi, BackendUiHost } from './backend_ui.js';

export interface EngineModel {
  id: string;
  name: string;
  description?: string | undefined;
  isDefault?: boolean | undefined;
  supportedReasoningEfforts?: string[] | undefined;
}

export interface EngineTurnRequest {
  scopeId: string;
  prompt: string;
  stagedAttachments?: StagedAttachment[] | undefined;
  threadId: string | null;
  cwd: string;
  model: string;
  effort?: string | null | undefined;
  serviceTier?: string | null | undefined;
  locale: AppLocale;
  accessPreset?: AccessPresetValue | undefined;
}

export interface EngineToolEvent {
  name: string;
  args?: Record<string, unknown> | string | undefined;
  output?: string | undefined;
  status?: 'running' | 'completed' | 'failed' | undefined;
  stepIndex?: number | undefined;
  summary?: string | undefined;
}

export interface EngineCommentaryEvent { messageId: string; text: string; }

export interface EngineTurnResult {
  kind: 'result';
  status: 'SUCCESS' | 'ERROR' | 'INTERRUPTED';
  response: string;
  error?: string | undefined;
  /** The connection ended before a native outcome was confirmed. */
  outcomeUnknown?: boolean;
  conversationId: string | null;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cachedTokens?: number | undefined;
    totalTokens?: number | undefined;
  } | undefined;
}

export interface EngineTurnExecution {
  turnId?: string | undefined;
  /** A returned promise resolves after the native backend has released the turn. */
  cancel(): void | Promise<void>;
  waitForResult(): Promise<EngineTurnResult | null>;
  on(event: 'delta', listener: (text: string) => void): void;
  on(event: 'commentary', listener: (message: EngineCommentaryEvent) => void): void;
  on(event: 'tool', listener: (tool: EngineToolEvent) => void): void;
  on(event: 'result', listener: (result: EngineTurnResult) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
  on(event: 'conversation', listener: (conversationId: string) => void): void;
}

export interface EngineTurnErrorContext {
  error: string;
  request: EngineTurnRequest;
  retryCount: number;
  retryTurn: (retryCount: number) => Promise<void>;
  sendMessage: (text: string) => Promise<number>;
  editMessage: (messageId: number, text: string) => Promise<void>;
}

export interface IEngineAdapter {
  readonly id: string;
  readonly name: string;
  readonly supportsCommentary?: boolean;
  listModels(scopeId?: string): Promise<EngineModel[]>;
  executeTurn(request: EngineTurnRequest): EngineTurnExecution;
  preflightTurn?(request: EngineTurnRequest): Promise<void>;
  handleTurnError?(context: EngineTurnErrorContext): Promise<boolean>;
}

export interface BackendDescriptor {
  id: string;
  name: string;
  engineType: string;
  adapter: IEngineAdapter;
  account?: string | undefined;
  details?: string | undefined;
  isDefault?: boolean | undefined;
  onSelect?: (scopeId: string) => Promise<void>;
  defaults?: {
    reasoningEffort: string | null;
    supportedReasoningEfforts: readonly string[];
    boost: boolean;
    tokenUsage: boolean;
  };
  commands?: (locale: AppLocale) => Array<{ command: string; description: string }>;
  createUi?: (host: BackendUiHost) => BackendUi;
}

