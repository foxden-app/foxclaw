import type { StagedAttachment } from './attachment_types.js';

export interface QueuedEngineInput {
  version: 1;
  prompt: string;
  backendId: string;
  cwd: string;
  stagedAttachments: StagedAttachment[];
}

export function decodeQueuedEngineInput(inputJson: string, fallbackPrompt: string): QueuedEngineInput | { prompt: string; stagedAttachments: StagedAttachment[] } {
  const input: unknown = JSON.parse(inputJson);
  // Legacy queues contained only a Codex-shaped text input array.
  if (Array.isArray(input)) {
    const text = input[0]?.text;
    return { prompt: typeof text === 'string' ? text : fallbackPrompt, stagedAttachments: [] };
  }
  if (typeof input !== 'object' || input === null || !('version' in input) || input.version !== 1 ||
      !('prompt' in input) || typeof input.prompt !== 'string' ||
      !('backendId' in input) || typeof input.backendId !== 'string' ||
      !('cwd' in input) || typeof input.cwd !== 'string' ||
      !('stagedAttachments' in input) || !Array.isArray(input.stagedAttachments)) {
    throw new Error('Invalid queued engine input');
  }
  return input as QueuedEngineInput;
}
