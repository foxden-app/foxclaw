import type { StagedTelegramAttachment } from '../telegram/media.js';
import type { AppLocale } from '../types.js';

export interface EngineModel {
  id: string;
  name: string;
  description?: string | undefined;
  isDefault?: boolean | undefined;
}

export interface EngineTurnRequest {
  scopeId: string;
  prompt: string;
  stagedAttachments?: StagedTelegramAttachment[] | undefined;
  threadId: string | null;
  cwd: string;
  model: string;
  effort?: string | null | undefined;
  serviceTier?: string | null | undefined;
  locale: AppLocale;
}

export interface EngineToolEvent {
  name: string;
  args?: Record<string, unknown> | string | undefined;
  output?: string | undefined;
  status?: 'running' | 'completed' | 'failed' | undefined;
  stepIndex?: number | undefined;
  summary?: string | undefined;
}

export interface EngineTurnResult {
  kind: 'result';
  status: 'SUCCESS' | 'ERROR' | 'INTERRUPTED';
  response: string;
  error?: string | undefined;
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
  cancel(): void;
  waitForResult(): Promise<EngineTurnResult | null>;
  on(event: 'delta', listener: (text: string) => void): void;
  on(event: 'tool', listener: (tool: EngineToolEvent) => void): void;
  on(event: 'result', listener: (result: EngineTurnResult) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
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
  listModels(): Promise<EngineModel[]>;
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
}

