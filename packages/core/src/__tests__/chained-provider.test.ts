import type { CompletionChunk, CompletionOptions, LLMProvider } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChainedProvider,
  type ChainFailoverEvent,
  classifyProviderError,
  tagProviderEntry,
} from '../providers/chained-provider';

function makeProvider(name: string, chunks: CompletionChunk[] | (() => Error)): LLMProvider {
  return {
    name,
    model: `${name}-model`,
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      const result = typeof chunks === 'function' ? chunks() : undefined;
      if (result) throw result;
      for (const chunk of chunks as CompletionChunk[]) {
        yield chunk;
      }
    },
    async countTokens() {
      return 1;
    },
  };
}

function makeErrorProvider(name: string, errorMessage: string): LLMProvider {
  return makeProvider(name, () => new Error(errorMessage));
}

function makeSuccessProvider(name: string, text = 'ok'): LLMProvider {
  return makeProvider(name, [
    { type: 'text_delta', text },
    {
      type: 'usage',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
      },
    },
    { type: 'done', finishReason: 'end_turn' },
  ]);
}

async function collect(provider: LLMProvider): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const chunk of provider.complete([], [], {})) {
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * A provider that yields `chunks`, then throws `failWith` (if given). Counts
 * how many times `complete` was called so a test can prove a second attempt
 * was — or was not — started.
 */
function makeScriptedProvider(
  name: string,
  chunks: CompletionChunk[],
  failWith?: () => Error,
): LLMProvider & { calls: number } {
  const provider = {
    ...makeProvider(name, []),
    calls: 0,
    async *complete(): AsyncIterable<CompletionChunk> {
      provider.calls++;
      for (const chunk of chunks) yield chunk;
      if (failWith) throw failWith();
    },
  };
  return provider;
}

/** Drains the stream, returning what was emitted and what (if anything) was thrown. */
async function drain(
  provider: LLMProvider,
  options: Parameters<LLMProvider['complete']>[2] = {},
): Promise<{ chunks: CompletionChunk[]; error: unknown }> {
  const chunks: CompletionChunk[] = [];
  try {
    for await (const chunk of provider.complete([], [], options)) chunks.push(chunk);
  } catch (error) {
    return { chunks, error };
  }
  return { chunks, error: undefined };
}

const USAGE_CHUNK: CompletionChunk = {
  type: 'usage',
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
  },
};
const B_STREAM: CompletionChunk[] = [
  { type: 'text_delta', text: 'from b' },
  { type: 'done', finishReason: 'end_turn' },
];
const rateLimited = () => new Error('429 Too Many Requests');

describe('ChainedProvider', () => {
  it('uses the first provider on success', async () => {
    const chain = new ChainedProvider([makeSuccessProvider('a'), makeSuccessProvider('b')]);
    const chunks = await collect(chain);
    const text = chunks.find((c) => c.type === 'text_delta') as
      | Extract<CompletionChunk, { type: 'text_delta' }>
      | undefined;
    expect(text?.text).toBe('ok');
    expect(chain.name).toContain('a');
  });

  it('fails over to the second provider on a rate_limit error', async () => {
    const chain = new ChainedProvider([
      makeErrorProvider('primary', '429 Too Many Requests'),
      makeSuccessProvider('fallback', 'fallback response'),
    ]);
    const chunks = await collect(chain);
    const text = chunks.find((c) => c.type === 'text_delta') as
      | Extract<CompletionChunk, { type: 'text_delta' }>
      | undefined;
    expect(text?.text).toBe('fallback response');
  });

  it('fails over on overloaded error (529)', async () => {
    const chain = new ChainedProvider([
      makeErrorProvider('primary', '529 overloaded'),
      makeSuccessProvider('fallback'),
    ]);
    const chunks = await collect(chain);
    expect(chunks.find((c) => c.type === 'done')).toBeDefined();
  });

  it('fails over on network error', async () => {
    const chain = new ChainedProvider([
      makeErrorProvider('primary', 'ECONNREFUSED connection refused'),
      makeSuccessProvider('fallback'),
    ]);
    const chunks = await collect(chain);
    expect(chunks.find((c) => c.type === 'done')).toBeDefined();
  });

  it('does NOT fail over on auth error — propagates immediately', async () => {
    const chain = new ChainedProvider([
      makeErrorProvider('primary', '401 Unauthorized invalid api key'),
      makeSuccessProvider('fallback'),
    ]);
    await expect(collect(chain)).rejects.toThrow('401');
  });

  it('does NOT fail over on content_filter error', async () => {
    const chain = new ChainedProvider([
      makeErrorProvider('primary', 'content policy violation'),
      makeSuccessProvider('fallback'),
    ]);
    await expect(collect(chain)).rejects.toThrow('content policy');
  });

  it('throws ALL_PROVIDERS_FAILED when all providers fail with retriable errors', async () => {
    const chain = new ChainedProvider([
      makeErrorProvider('p1', '429 rate limit'),
      makeErrorProvider('p2', '529 overloaded'),
    ]);
    await expect(collect(chain)).rejects.toThrow('ALL_PROVIDERS_FAILED');
  });

  it('throws ALL_PROVIDERS_REJECT_MODEL when all providers fail with model_not_found', async () => {
    const chain = new ChainedProvider([
      makeErrorProvider('p1', '404 model not found'),
      makeErrorProvider('p2', '404 no such model'),
    ]);
    await expect(collect(chain)).rejects.toThrow('ALL_PROVIDERS_REJECT_MODEL');
  });

  it('exposes model from first available (non-cooled) provider', () => {
    const chain = new ChainedProvider([makeSuccessProvider('a'), makeSuccessProvider('b')]);
    expect(chain.model).toBe('a-model');
  });

  it('requires at least one provider', () => {
    expect(() => new ChainedProvider([])).toThrow('at least one provider');
  });
});

// F03 — the first emitted chunk commits the attempt. The agent loop
// accumulates everything a provider yields into ONE assistant turn, so a
// second attempt after a first chunk would splice two answers together.
describe('ChainedProvider stream commit (F03)', () => {
  it('fails over when the retryable error comes before the first chunk', async () => {
    const a = makeScriptedProvider('a', [], rateLimited);
    const b = makeScriptedProvider('b', B_STREAM);
    const { chunks, error } = await drain(new ChainedProvider([a, b]));

    expect(error).toBeUndefined();
    expect(chunks).toEqual(B_STREAM);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });

  const committingChunks: Array<[string, CompletionChunk]> = [
    ['text_delta', { type: 'text_delta', text: 'The answer is 4' }],
    ['tool_use_start', { type: 'tool_use_start', toolCallId: 'call_1', toolName: 'read_file' }],
    ['usage', USAGE_CHUNK],
  ];

  for (const [label, first] of committingChunks) {
    it(`propagates a retryable error after a ${label} chunk and never starts provider B`, async () => {
      const a = makeScriptedProvider('a', [first], rateLimited);
      const b = makeScriptedProvider('b', B_STREAM);
      const { chunks, error } = await drain(new ChainedProvider([a, b]));

      expect(chunks).toEqual([first]);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('429 Too Many Requests');
      expect(a.calls).toBe(1);
      expect(b.calls).toBe(0);
    });
  }

  it('never starts another attempt once the caller has aborted', async () => {
    const controller = new AbortController();
    const a = makeScriptedProvider('a', [], () => {
      controller.abort();
      return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });
    const b = makeScriptedProvider('b', B_STREAM);
    const chain = new ChainedProvider([a, b]);
    const { chunks, error } = await drain(chain, { abortSignal: controller.signal });

    expect(chunks).toEqual([]);
    expect((error as Error).name).toBe('AbortError');
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
    // An abort is the caller's decision, not a provider fault — A is not cooled.
    expect(chain.model).toBe('a-model');
  });
});

/**
 * A provider that records the options each call received and follows `script`
 * call by call (the last step repeats). A step is `'ok'` or an error to throw.
 */
function recordingProvider(
  name: string,
  model: string,
  script: Array<'ok' | (() => Error)>,
): LLMProvider & { calls: CompletionOptions[] } {
  const provider = {
    ...makeProvider(name, []),
    model,
    calls: [] as CompletionOptions[],
    async *complete(
      _m: unknown,
      _t: unknown,
      options: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      const step = script[Math.min(provider.calls.length, script.length - 1)];
      provider.calls.push(options);
      if (step !== 'ok' && step !== undefined) throw step();
      yield { type: 'text_delta', text: `from ${name}` };
      yield { type: 'done', finishReason: 'end_turn' };
    },
  };
  return provider;
}

describe('ChainedProvider — modelOverride scoping (D21/D23b)', () => {
  it("an override naming hop A's own model never reaches hop B while A cools (the user's sequence)", async () => {
    const codex = recordingProvider('codex', 'gpt-5.6-terra', [rateLimited, 'ok']);
    const qwen = recordingProvider('openai-compat', 'qwen3.8-flash-next', ['ok']);
    const chain = new ChainedProvider([
      tagProviderEntry(codex, 'codex-gpt-terra'),
      tagProviderEntry(qwen, 'openai-compat'),
    ]);

    // Call 1: codex is rate limited and cools down; qwen answers.
    expect((await drain(chain)).error).toBeUndefined();
    // While codex cools, `chain.model` is qwen's — so a caller comparing against
    // it sends codex's model id as an override.
    expect(chain.model).toBe('qwen3.8-flash-next');
    const { error } = await drain(chain, { modelOverride: 'gpt-5.6-terra' });

    expect(error).toBeUndefined();
    expect(codex.calls).toHaveLength(1);
    expect(qwen.calls).toHaveLength(2);
    for (const call of qwen.calls) expect(call.modelOverride).toBeUndefined();
  });

  it('a pinned entry alone receives the override, and no other hop is tried', async () => {
    vi.useFakeTimers();
    try {
      const a = recordingProvider('a', 'a-model', [rateLimited]);
      const b = recordingProvider('b', 'b-model', ['ok']);
      const pending = drain(new ChainedProvider([a, b]), {
        modelOverride: 'a-bigger',
        providerEntry: { key: 'a', pinned: true },
      });
      // A 429 on a pinned call is retried with a backoff; skip the waits.
      await vi.runAllTimersAsync();
      const { error } = await pending;

      expect((error as Error).message).toMatch(
        /^PINNED_PROVIDER_FAILED: a \(a\/a-bigger\): rate_limit/,
      );
      expect((error as Error).message).toContain('429 Too Many Requests');
      for (const call of a.calls) {
        expect(call.modelOverride).toBe('a-bigger');
        expect(call.providerEntry).toBeUndefined();
      }
      expect(b.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a default-rung scoped override reaches only its entry; the next hop runs its own model', async () => {
    const a = recordingProvider('a', 'a-model', [rateLimited]);
    const b = recordingProvider('b', 'b-model', ['ok']);
    const { error } = await drain(new ChainedProvider([a, b]), {
      modelOverride: 'a-bigger',
      providerEntry: { key: 'a', pinned: false },
    });

    expect(error).toBeUndefined();
    expect(a.calls[0]?.modelOverride).toBe('a-bigger');
    expect(b.calls[0]?.modelOverride).toBeUndefined();
  });

  it('a providerEntry naming no hop refuses and runs nothing', async () => {
    const a = recordingProvider('a', 'a-model', ['ok']);
    const { error } = await drain(new ChainedProvider([a, makeSuccessProvider('b')]), {
      providerEntry: { key: 'vision-only', pinned: true },
    });

    expect((error as Error).message).toMatch(/^PROVIDER_ENTRY_NOT_IN_CHAIN: .*"vision-only"/);
    expect(a.calls).toHaveLength(0);
  });

  it('a hop rejecting a model it was never configured with is not cooled down', async () => {
    const notFound = () => new Error('404 model not found');
    const a = recordingProvider('a', 'a-model', [notFound, 'ok']);
    const b = recordingProvider('b', 'b-model', [notFound]);
    const chain = new ChainedProvider([a, b]);

    const { error } = await drain(chain, { modelOverride: 'nobody-serves-this' });

    expect((error as Error).message).toMatch(/^ALL_PROVIDERS_REJECT_MODEL/);
    expect(chain.model).toBe('a-model');
  });
});

describe('ChainedProvider — an honest exhaustion error (D17)', () => {
  /** Cools `b` down with one failed pinned call, leaving `a` ready. */
  async function coolB(chain: ChainedProvider) {
    // `b` is untagged at index 1, so its positional key is `b-1`.
    await drain(chain, { providerEntry: { key: 'b-1', pinned: true } });
  }

  it('names the entry skipped for cooldown with its last error, and retries it once', async () => {
    const tunnel = () => new Error('upstream tunnel said no');
    const a = recordingProvider('a', 'a-model', [rateLimited]);
    const b = recordingProvider('b', 'b-model', [tunnel]);
    const chain = new ChainedProvider([a, b]);
    await coolB(chain);

    const { error } = await drain(chain);
    const message = (error as Error).message;

    expect(message).toMatch(/^ALL_PROVIDERS_FAILED: all 2 providers in the chain were tried/);
    expect(message).toContain('a (a/a-model): rate_limit — "429 Too Many Requests"');
    expect(message).toMatch(
      /b-1 \(b\/b-model\): unknown — "upstream tunnel said no" \[was cooling down, \d+s left after unknown — "upstream tunnel said no"; retried anyway\]/,
    );
    expect(b.calls).toHaveLength(2);
  });

  it('a cooling entry that answers on the retry serves the call', async () => {
    const a = recordingProvider('a', 'a-model', [rateLimited]);
    const b = recordingProvider('b', 'b-model', [() => new Error('502 bad gateway'), 'ok']);
    const chain = new ChainedProvider([a, b]);
    await coolB(chain);

    const { chunks, error } = await drain(chain);

    expect(error).toBeUndefined();
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'from b' });
  });
});

describe('classifyProviderError', () => {
  it('does not read a status code out of an id that merely contains its digits', () => {
    expect(classifyProviderError(new Error('request id abc4290 failed'))).toBe('unknown');
  });

  it('prefers a structured status over the message text', () => {
    expect(
      classifyProviderError(Object.assign(new Error('upstream said no'), { status: 429 })),
    ).toBe('rate_limit');
    expect(classifyProviderError(Object.assign(new Error('echo: 429'), { status: 400 }))).toBe(
      'unknown',
    );
  });

  it('still matches a whole-token status and the phrases', () => {
    expect(classifyProviderError(new Error('429 Too Many Requests'))).toBe('rate_limit');
    expect(classifyProviderError(new Error('You are being rate limited'))).toBe('rate_limit');
  });
});

describe('ChainedProvider — onFailover', () => {
  it('reports each failed attempt with its entry key, reason, bounded redacted message and next step', async () => {
    const events: ChainFailoverEvent[] = [];
    const a = recordingProvider('codex', 'gpt-5.6-terra', [
      () => new Error(`429 rate limited for key sk-ant-api03-${'x'.repeat(24)} ${'y'.repeat(400)}`),
    ]);
    const chain = new ChainedProvider(
      [tagProviderEntry(a, 'codex-gpt-terra'), makeSuccessProvider('openai-compat')],
      { onFailover: (e) => events.push(e) },
    );

    await drain(chain);

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      entryKey: 'codex-gpt-terra',
      provider: 'codex',
      model: 'gpt-5.6-terra',
      reason: 'rate_limit',
      outcome: 'next-entry',
      // Untagged, so the positional `deriveProviderKey`-style default.
      nextEntryKey: 'openai-compat-1',
      pinned: false,
    });
    expect(event?.message).toContain('429 rate limited for key [redacted]');
    expect(event?.message).not.toContain('sk-ant');
    expect(event?.message.length).toBeLessThanOrEqual(301);
  });

  it('a throwing callback never breaks the completion', async () => {
    const chain = new ChainedProvider(
      [makeErrorProvider('a', '429 Too Many Requests'), makeSuccessProvider('b')],
      {
        onFailover: () => {
          throw new Error('telemetry down');
        },
      },
    );
    expect((await drain(chain)).error).toBeUndefined();
  });
});

// D21 + `maxRetries: 0` on chain hops (createLLMFromRegistry): a pinned call
// cannot fail over, so the chain retries its one entry on a transient error.
describe('ChainedProvider — pinned call retries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Fake timers, and jitter pinned to zero so the waits are exact. */
  function deterministicTimers() {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  }

  const PINNED_A = { providerEntry: { key: 'a', pinned: true } };

  function withRetryAfter(seconds: string): () => Error {
    return () =>
      Object.assign(new Error('rate limited'), {
        status: 429,
        headers: new Headers({ 'retry-after': seconds }),
      });
  }

  it('retries a 429 and succeeds on the second attempt', async () => {
    deterministicTimers();
    const events: ChainFailoverEvent[] = [];
    const a = recordingProvider('a', 'a-model', [rateLimited, 'ok']);
    const b = recordingProvider('b', 'b-model', ['ok']);
    const pending = drain(
      new ChainedProvider([a, b], { onFailover: (e) => events.push(e) }),
      PINNED_A,
    );

    await vi.advanceTimersByTimeAsync(499);
    expect(a.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const { chunks, error } = await pending;

    expect(error).toBeUndefined();
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'from a' });
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entryKey: 'a',
      reason: 'rate_limit',
      outcome: 'retry-pinned',
      nextEntryKey: 'a',
      pinned: true,
    });
  });

  it('gives up after 3 attempts and says so', async () => {
    deterministicTimers();
    const events: ChainFailoverEvent[] = [];
    const a = recordingProvider('a', 'a-model', [rateLimited]);
    const b = recordingProvider('b', 'b-model', ['ok']);
    const pending = drain(
      new ChainedProvider([a, b], { onFailover: (e) => events.push(e) }),
      PINNED_A,
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(a.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1499);
    expect(a.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await pending;

    expect((error as Error).message).toMatch(
      /^PINNED_PROVIDER_FAILED: a \(a\/a-model\): rate_limit/,
    );
    expect((error as Error).message).toContain('(3 attempts made)');
    expect(a.calls).toHaveLength(3);
    expect(b.calls).toHaveLength(0);
    expect(events.map((e) => e.outcome)).toEqual(['retry-pinned', 'retry-pinned', 'give-up']);
  });

  it('honours retry-after over the backoff, capped at 10s per wait', async () => {
    deterministicTimers();
    const a = recordingProvider('a', 'a-model', [withRetryAfter('2'), withRetryAfter('30'), 'ok']);
    const pending = drain(new ChainedProvider([a, makeSuccessProvider('b')]), PINNED_A);

    // retry-after: 2 — longer than the 500ms backoff, and honoured.
    await vi.advanceTimersByTimeAsync(1999);
    expect(a.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.calls).toHaveLength(2);
    // retry-after: 30 — capped at 10s, not the minute the SDK would have waited.
    await vi.advanceTimersByTimeAsync(9999);
    expect(a.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = await pending;

    expect(error).toBeUndefined();
    expect(a.calls).toHaveLength(3);
  });

  it('an abort during the backoff stops at once, with no further attempt or leftover timer', async () => {
    deterministicTimers();
    const controller = new AbortController();
    const a = recordingProvider('a', 'a-model', [rateLimited, 'ok']);
    const pending = drain(new ChainedProvider([a, makeSuccessProvider('b')]), {
      ...PINNED_A,
      abortSignal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(a.calls).toHaveLength(1);
    controller.abort(new Error('user stopped the turn'));
    const { error } = await pending;

    expect((error as Error).message).toBe('user stopped the turn');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.calls).toHaveLength(1);
  });

  it('an auth error on a pinned call is not retried', async () => {
    deterministicTimers();
    const a = recordingProvider('a', 'a-model', [() => new Error('401 Unauthorized'), 'ok']);
    const { error } = await drain(new ChainedProvider([a, makeSuccessProvider('b')]), PINNED_A);

    expect((error as Error).message).toBe('401 Unauthorized');
    expect(a.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an unpinned call does not retry — it fails over at once', async () => {
    deterministicTimers();
    const a = recordingProvider('a', 'a-model', [rateLimited, 'ok']);
    const b = recordingProvider('b', 'b-model', ['ok']);
    // No timer is advanced: a backoff anywhere on this path would hang the drain.
    const { chunks, error } = await drain(new ChainedProvider([a, b]), {
      providerEntry: { key: 'a', pinned: false },
    });

    expect(error).toBeUndefined();
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'from b' });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
