import type { CompletionChunk } from '@ethosagent/types';

export interface BedrockConverseStreamParams {
  modelId: string;
  messages: unknown[];
  system?: string;
  inferenceConfig?: Record<string, unknown>;
  toolConfig?: unknown;
}

// biome-ignore lint/correctness/useYield: stub — will yield CompletionChunk once implemented
export async function* streamBedrockConverse(
  _client: unknown,
  _params: BedrockConverseStreamParams,
  _signal?: AbortSignal,
): AsyncGenerator<CompletionChunk> {
  throw new Error('streamBedrockConverse: not yet implemented');
}
