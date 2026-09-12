import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ChainedProvider } from '../providers/chained-provider';

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
