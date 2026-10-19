// Shared fixtures for the usage-accounting wiring tests (plan
// background-usage-accounting §10): a `usage` chunk builder, a provider that
// replays a script, and a meter that meters nothing.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import type { UsageMeter } from '../../usage-meter';

/** One `usage` chunk with no cache tokens. */
export function usageChunk(
  inputTokens: number,
  outputTokens: number,
  estimatedCostUsd: number,
): CompletionChunk {
  return {
    type: 'usage',
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd,
    },
  };
}

type Script =
  | CompletionChunk[]
  | ((
      messages: Message[],
      tools: ToolDefinitionLite[],
      options: CompletionOptions,
    ) => CompletionChunk[]);

/** A provider whose every `complete()` yields `script` (or what it returns for the call). */
export function scriptedProvider(
  script: Script,
  identity: { name?: string; model?: string } = {},
): LLMProvider {
  return {
    name: identity.name ?? 'stub',
    model: identity.model ?? 'stub-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages, tools, options): AsyncIterable<CompletionChunk> {
      yield* typeof script === 'function' ? script(messages, tools, options) : script;
    },
    async countTokens() {
      return 1;
    },
  };
}

/** A meter for tests that do not assert on usage: every provider passes through unmetered. */
export const PASSTHROUGH_METER: Pick<UsageMeter, 'meter'> = { meter: (provider) => provider };
