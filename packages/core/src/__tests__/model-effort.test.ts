// Presence §4 — reasoning effort rides the model ALIAS. Two aliases of one
// model differ only in `effort`, a personality picks one by name, and the
// loop hands the resolved alias's effort to the provider on
// `CompletionOptions.effort` (`routeTurnModel`, agent-loop/model-route.ts).

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  ModelResolutionContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { tagProviderEntry } from '../providers/chained-provider';
import { createTestSafety } from './helpers/test-safety';

function recordingProvider(): LLMProvider & { calls: CompletionOptions[] } {
  const provider = {
    name: 'anthropic',
    model: 'claude-opus-4-7',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: true,
    calls: [] as CompletionOptions[],
    async *complete(
      _messages: unknown,
      _tools: unknown,
      options: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      provider.calls.push(options);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
  return provider;
}

const resolution: ModelResolutionContext = {
  registry: {
    entries: {
      'opus-deep': {
        alias: 'opus-deep',
        provider: 'anthropic-work',
        modelId: 'claude-opus-4-7',
        effort: 'high',
      },
      'opus-quick': {
        alias: 'opus-quick',
        provider: 'anthropic-work',
        modelId: 'claude-opus-4-7',
        effort: 'low',
      },
      opus: { alias: 'opus', provider: 'anthropic-work', modelId: 'claude-opus-4-7' },
    },
    default: 'opus',
    roles: {},
  },
  routing: {},
};

async function optionsFor(personalityModel: string | undefined): Promise<CompletionOptions> {
  const llm = recordingProvider();
  const loop = new AgentLoop({
    llm: tagProviderEntry(llm, 'anthropic-work'),
    safety: createTestSafety(),
    modelResolution: resolution,
  });
  // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
  loop['personalities'].define({
    id: 'p',
    name: 'P',
    ...(personalityModel ? { model: personalityModel } : {}),
  });
  for await (const _ of loop.run('hi', { personalityId: 'p', sessionKey: 'cli:p' })) {
    // drain
  }
  const call = llm.calls[0];
  if (!call) throw new Error('the provider was never called');
  return call;
}

describe('reasoning effort per model alias', () => {
  it('a personality on opus-quick sends effort low', async () => {
    expect((await optionsFor('opus-quick')).effort).toBe('low');
  });

  it('a personality on opus-deep sends effort high — same model, different request', async () => {
    const deep = await optionsFor('opus-deep');
    expect(deep.effort).toBe('high');
    expect(deep.modelOverride).toBeUndefined();
  });

  it('an alias with no effort sends no effort key at all', async () => {
    expect('effort' in (await optionsFor('opus'))).toBe(false);
    expect('effort' in (await optionsFor(undefined))).toBe(false);
  });
});
