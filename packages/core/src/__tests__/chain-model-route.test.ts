// D21 / D23b through a real AgentLoop and a real ChainedProvider: which hop a
// turn's model reaches, and which hops never see it.
//
// The registry mirrors the production config that produced
// `ALL_PROVIDERS_FAILED: … codex/gpt-5.6-terra (rate_limit), openai-compat/qwen3.8-flash-next (rate_limit)`:
// a codex entry and an openai-compat entry, default alias on codex.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  ModelResolutionContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { ChainedProvider, tagProviderEntry } from '../providers/chained-provider';
import { createTestSafety } from './helpers/test-safety';

type Step = 'ok' | (() => Error);

function hop(
  name: string,
  model: string,
  script: Step[],
): LLMProvider & { calls: CompletionOptions[] } {
  const provider = {
    name,
    model,
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    calls: [] as CompletionOptions[],
    async *complete(
      _messages: unknown,
      _tools: unknown,
      options: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      const step = script[Math.min(provider.calls.length, script.length - 1)];
      provider.calls.push(options);
      if (step !== 'ok' && step !== undefined) throw step();
      yield { type: 'text_delta', text: `from ${name}` };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
  return provider;
}

const rateLimited = () => Object.assign(new Error('Too Many Requests'), { status: 429 });

const resolution: ModelResolutionContext = {
  registry: {
    entries: {
      'gpt-5-6-terra': {
        alias: 'gpt-5-6-terra',
        provider: 'codex-gpt-terra',
        modelId: 'gpt-5.6-terra',
      },
      'qwen3-8-flash-next': {
        alias: 'qwen3-8-flash-next',
        provider: 'openai-compat',
        modelId: 'qwen3.8-flash-next',
      },
      'gpt-5-6-mini': {
        alias: 'gpt-5-6-mini',
        provider: 'codex-gpt-terra',
        modelId: 'gpt-5.6-mini',
      },
      vision: { alias: 'vision', provider: 'vision-only', modelId: 'gpt-vision' },
    },
    default: 'gpt-5-6-terra',
    roles: {},
  },
  routing: {},
};

function setup(codexScript: Step[], qwenScript: Step[] = ['ok']) {
  const codex = hop('codex', 'gpt-5.6-terra', codexScript);
  const qwen = hop('openai-compat', 'qwen3.8-flash-next', qwenScript);
  const loop = new AgentLoop({
    llm: new ChainedProvider([
      tagProviderEntry(codex, 'codex-gpt-terra'),
      tagProviderEntry(qwen, 'openai-compat'),
    ]),
    safety: createTestSafety(),
    modelResolution: resolution,
  });
  // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
  const personalities = loop['personalities'];
  personalities.define({ id: 'plain', name: 'Plain' });
  personalities.define({ id: 'on-codex', name: 'On codex', model: 'gpt-5-6-mini' });
  personalities.define({ id: 'on-qwen', name: 'On qwen', model: 'qwen3-8-flash-next' });
  personalities.define({ id: 'off-chain', name: 'Off chain', model: 'vision' });
  personalities.define({ id: 'legacy', name: 'Legacy', model: 'claude-sonnet-4-6' });
  return { loop, codex, qwen };
}

async function turn(loop: AgentLoop, personalityId: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of loop.run('hi', { personalityId, sessionKey: `cli:${personalityId}` })) {
    events.push(e);
  }
  return events;
}

function errorOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'error' }> | undefined {
  return events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
}

describe('a default-rung turn rides the chain with every hop on its own model', () => {
  it('while codex cools down, the qwen hop receives no modelOverride', async () => {
    const { loop, codex, qwen } = setup([rateLimited, 'ok']);

    // Turn 1: codex is rate limited, qwen answers.
    expect(errorOf(await turn(loop, 'plain'))).toBeUndefined();
    // Turn 2: codex is cooling. The default still resolves to codex's model —
    // and that id used to be sent to qwen as an override.
    const second = await turn(loop, 'plain');

    expect(errorOf(second)).toBeUndefined();
    expect(second.find((e) => e.type === 'run_start')).toMatchObject({
      provider: 'codex-gpt-terra',
      model: 'gpt-5.6-terra',
      source: 'default',
    });
    expect(codex.calls).toHaveLength(1);
    expect(qwen.calls).toHaveLength(2);
    for (const call of qwen.calls) {
      expect(call.modelOverride).toBeUndefined();
      expect(call.providerEntry).toBeUndefined();
    }
  });
});

describe('a pinned alias reaches only its own provider entry (D21)', () => {
  it('codex receives the pinned model, qwen never does, and a codex failure does not fail over', async () => {
    const { loop, codex, qwen } = setup([rateLimited]);

    const error = errorOf(await turn(loop, 'on-codex'));

    expect(codex.calls[0]?.modelOverride).toBe('gpt-5.6-mini');
    expect(qwen.calls).toHaveLength(0);
    expect(error?.code).toBe('llm_error');
    expect(error?.error).toMatch(
      /^PINNED_PROVIDER_FAILED: codex-gpt-terra \(codex\/gpt-5\.6-mini\): rate_limit/,
    );
    expect(error?.error).toContain('HTTP 429: Too Many Requests');
  });

  it('a pin on the second hop skips the healthy first hop and sends no override for its own model', async () => {
    const { loop, codex, qwen } = setup(['ok']);

    expect(errorOf(await turn(loop, 'on-qwen'))).toBeUndefined();

    expect(codex.calls).toHaveLength(0);
    expect(qwen.calls).toHaveLength(1);
    expect(qwen.calls[0]?.modelOverride).toBeUndefined();
  });

  it('a pin on an entry that is not a hop refuses with the entry named, and nothing runs', async () => {
    const { loop, codex, qwen } = setup(['ok']);

    const error = errorOf(await turn(loop, 'off-chain'));

    expect(error?.code).toBe('model_unresolved');
    expect(error?.error).toContain('"vision-only"');
    expect(error?.error).toContain('codex-gpt-terra, openai-compat');
    expect(codex.calls).toHaveLength(0);
    expect(qwen.calls).toHaveLength(0);
  });
});

describe('a declaration that does not resolve says where to fix it (D6/D14)', () => {
  it('names the routing override that outranks it and the config file to edit', async () => {
    const { loop, codex } = setup(['ok']);

    const error = errorOf(await turn(loop, 'legacy'));

    expect(error?.code).toBe('model_unresolved');
    expect(error?.error).toContain('"claude-sonnet-4-6"');
    expect(error?.error).toContain('`modelRouting.legacy: default` to ~/.ethos/config.yaml');
    expect(codex.calls).toHaveLength(0);
  });
});
