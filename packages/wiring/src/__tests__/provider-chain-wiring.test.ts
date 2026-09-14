// How `createLLM` assembles the provider chain the default rung rides:
// `failover: false` entries are not hops (D23b), every instance carries its
// provider ENTRY key so a turn can scope a model to it (D21, `routeTurnModel`),
// a keyless self-hosted entry builds, and a chain failover lands in
// observability as `llm.failover` (D17).

import { ChainedProvider, providerEntriesOf } from '@ethosagent/core';
import type { ModelRegistry, ObsEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLM, type WiringProviderConfig } from '../index';
import { EthosObservability } from '../observability/ethos-observability';

function entry(
  id: string,
  model: string,
  extra: Partial<WiringProviderConfig> = {},
): WiringProviderConfig {
  return { provider: 'openrouter', id, model, apiKey: 'k', ...extra };
}

const TOP = { provider: 'openrouter', model: 'm-a', apiKey: 'k' };

describe('createLLM — chain membership and entry keys', () => {
  it('a failover:false entry is not a hop in the chain', async () => {
    const llm = await createLLM({
      ...TOP,
      providers: [entry('a', 'm-a'), entry('b', 'm-b'), entry('c', 'm-c', { failover: false })],
    });

    expect(llm).toBeInstanceOf(ChainedProvider);
    expect(providerEntriesOf(llm)).toEqual([
      { key: 'a', model: 'm-a' },
      { key: 'b', model: 'm-b' },
    ]);
  });

  it('when one hop is left it is used directly, like the single-provider path', async () => {
    const llm = await createLLM({
      ...TOP,
      providers: [entry('a', 'm-a'), entry('c', 'm-c', { failover: false })],
    });

    expect(llm).not.toBeInstanceOf(ChainedProvider);
    expect(providerEntriesOf(llm)).toEqual([{ key: 'a', model: 'm-a' }]);
  });

  it("with every entry opted out, the default alias's own entry serves alone", async () => {
    const modelRegistry: ModelRegistry = {
      entries: { vision: { alias: 'vision', provider: 'c', modelId: 'm-c' } },
      default: 'vision',
      roles: {},
    };
    const llm = await createLLM({
      ...TOP,
      modelRegistry,
      providers: [entry('a', 'm-a', { failover: false }), entry('c', 'm-c', { failover: false })],
    });

    expect(providerEntriesOf(llm)).toEqual([{ key: 'c', model: 'm-c' }]);
  });

  it('an entry with no id carries the positional deriveProviderKey default', async () => {
    const llm = await createLLM({
      ...TOP,
      providers: [
        { provider: 'openrouter', apiKey: 'k', model: 'm-1' },
        { provider: 'openrouter', apiKey: 'k', model: 'm-2' },
      ],
    });

    expect(providerEntriesOf(llm)?.map((e) => e.key)).toEqual(['openrouter', 'openrouter-1']);
  });

  it('a keyless self-hosted ollama chain entry builds', async () => {
    const llm = await createLLM({
      ...TOP,
      providers: [
        entry('local', 'qwen3:8b', {
          provider: 'ollama',
          apiKey: '',
          baseUrl: 'http://127.0.0.1:11434/v1',
        }),
        entry('b', 'm-b'),
      ],
    });

    expect(providerEntriesOf(llm)?.map((e) => e.key)).toEqual(['local', 'b']);
  });
});

// A live smoke with two stub OpenAI-compatible providers (A: 429 +
// `retry-after: 30`, B: answers) showed turn 1 hit A three times 30s apart
// before failing over — the SDK's own `retry-after`-honouring retries. In a
// chain, failover + cooldown is the retry policy, so hops build with retries off.
describe('createLLM — SDK retries on chain hops', () => {
  /** The SDK client's retry count, read off the real client each provider built. */
  const retriesOf = (provider: unknown): number =>
    (provider as { client: { maxRetries: number } }).client.maxRetries;
  const hopsOf = (llm: unknown): unknown[] =>
    (llm as { entries: Array<{ provider: unknown }> }).entries.map((e) => e.provider);

  it('a chain of two builds every hop with retries disabled', async () => {
    const llm = await createLLM({
      ...TOP,
      providers: [entry('a', 'm-a'), entry('b', 'claude-sonnet-5', { provider: 'anthropic' })],
    });

    expect(llm).toBeInstanceOf(ChainedProvider);
    expect(hopsOf(llm).map(retriesOf)).toEqual([0, 0]);
  });

  it('a single provider keeps the SDK default', async () => {
    const llm = await createLLM(TOP);
    expect(retriesOf(llm)).toBe(2);
  });

  it('a chain reduced to one hop by failover:false keeps the SDK default', async () => {
    const llm = await createLLM({
      ...TOP,
      providers: [entry('a', 'm-a'), entry('c', 'm-c', { failover: false })],
    });
    expect(retriesOf(llm)).toBe(2);
  });

  it('an explicit operator maxRetries applies to chain hops too', async () => {
    const llm = await createLLM({
      ...TOP,
      maxRetries: 3,
      providers: [entry('a', 'm-a'), entry('b', 'm-b')],
    });
    expect(hopsOf(llm).map(retriesOf)).toEqual([3, 3]);
  });
});

describe('EthosObservability.recordProviderFailover', () => {
  it('writes an llm.failover event carrying the entry key, reason and vendor message', async () => {
    const events: Array<Omit<ObsEvent, 'eventId' | 'ts'>> = [];
    const obs = new EthosObservability({
      startTrace: () => 't',
      endTrace: () => {},
      startSpan: () => 's',
      endSpan: () => {},
      recordEvent: (event) => events.push(event),
      flush: () => {},
    });
    const chain = new ChainedProvider(
      [
        {
          name: 'codex',
          model: 'gpt-5.6-terra',
          maxContextTokens: 1,
          supportsCaching: false,
          supportsThinking: false,
          // biome-ignore lint/correctness/useYield: throws before its first chunk by design
          async *complete() {
            throw Object.assign(new Error('Too Many Requests'), { status: 429 });
          },
          countTokens: async () => 0,
        },
      ],
      { onFailover: (event) => obs.recordProviderFailover(event) },
    );

    const drain = async () => {
      for await (const _ of chain.complete([], [], {})) {
        // nothing is yielded; the call throws
      }
    };
    await expect(drain()).rejects.toThrow('ALL_PROVIDERS_FAILED');

    expect(events).toEqual([
      {
        category: 'llm.failover',
        severity: 'error',
        code: 'rate_limit',
        cause: 'HTTP 429: Too Many Requests',
        details: {
          entryKey: 'codex',
          provider: 'codex',
          model: 'gpt-5.6-terra',
          outcome: 'give-up',
          pinned: false,
        },
      },
    ]);
  });
});
