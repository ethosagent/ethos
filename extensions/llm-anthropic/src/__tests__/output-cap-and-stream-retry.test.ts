// UBP-033 — the provider ignored the model profile's `maxOutputTokens` that
// wiring hands the factory, so every request capped output at 8096 tokens.
// UBP-037 — an `overloaded_error` / `rate_limit_error` that arrives as an SSE
// `error` event AFTER HTTP 200 is an `APIError` with no status: the SDK's own
// retries never see it, `AuthRotatingProvider.classifyError` read only the
// status and did not rotate, and a single provider (no chain) surfaced it to
// the user even though nothing had been emitted yet. The wire bytes are
// asserted through the SDK's fetch seam (no network).

import Anthropic from '@anthropic-ai/sdk';
import type { CompletionChunk, CompletionOptions, LLMProvider, Message } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  type AnthropicProviderConfig,
  AuthRotatingProvider,
  anthropicFactory,
} from '../index';

const MODEL = 'claude-sonnet-4-5';

function sse(events: Array<Record<string, unknown>>): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`;
}

const MESSAGE_START = {
  type: 'message_start',
  message: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [],
    model: MODEL,
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};

const okBody = sse([
  MESSAGE_START,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: 'message_stop' },
]);

/** HTTP 200, `message_start`, then an SSE `error` event — nothing a caller sees. */
const streamError = (type: 'overloaded_error' | 'rate_limit_error' | 'api_error') =>
  sse([MESSAGE_START, { type: 'error', error: { type, message: 'Overloaded' } }]);

/** A text delta reaches the caller BEFORE the error. */
const errorAfterText = sse([
  MESSAGE_START,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } },
  { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
]);

function fetchStub(bodies: string[], captured: string[]): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    captured.push(String(init?.body ?? ''));
    return new Response(bodies.shift() ?? okBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

const hello: Message[] = [{ role: 'user', content: 'hello' }];

function provider(
  bodies: string[],
  captured: string[],
  config: Partial<AnthropicProviderConfig> = {},
): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'test-key',
    model: MODEL,
    fetchImpl: fetchStub(bodies, captured),
    ...config,
  });
}

async function drain(stream: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

/** Drain while stepping fake timers through the retry backoff. */
async function drainWithTimers(stream: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  let settled = false;
  const p = drain(stream).finally(() => {
    settled = true;
  });
  p.catch(() => {});
  for (let i = 0; i < 50 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
  return p;
}

describe('UBP-033 — max_tokens comes from the model profile', () => {
  it('sends the configured maxOutputTokens', async () => {
    const captured: string[] = [];
    await drain(provider([], captured, { maxOutputTokens: 32_000 }).complete(hello, [], {}));
    expect(JSON.parse(captured[0] ?? '{}').max_tokens).toBe(32_000);
  });

  it('a per-call maxTokens still wins', async () => {
    const captured: string[] = [];
    const p = provider([], captured, { maxOutputTokens: 32_000 });
    await drain(p.complete(hello, [], { maxTokens: 500 }));
    expect(JSON.parse(captured[0] ?? '{}').max_tokens).toBe(500);
  });

  it('falls back to 8096 with no profile', async () => {
    const captured: string[] = [];
    await drain(provider([], captured).complete(hello, [], {}));
    expect(JSON.parse(captured[0] ?? '{}').max_tokens).toBe(8096);
  });

  it('the factory reads the maxOutputTokens wiring passes', async () => {
    const p = await anthropicFactory({
      config: { model: MODEL, apiKey: 'k', maxOutputTokens: 64_000 },
      secrets: { get: async () => null },
      logger: { warn: () => {} },
    } as unknown as Parameters<typeof anthropicFactory>[0]);
    expect((p as unknown as { maxOutputTokens?: number }).maxOutputTokens).toBe(64_000);
  });

  it('AuthRotatingProvider hands maxOutputTokens to every pooled key', async () => {
    const pool = new AuthRotatingProvider([{ id: 'a', apiKey: 'k', priority: 1 }], MODEL, {
      maxOutputTokens: 16_000,
    });
    const slots = (pool as unknown as { providers: Array<{ maxOutputTokens?: number }> }).providers;
    expect(slots.map((s) => s.maxOutputTokens)).toEqual([16_000]);
  });
});

// The profile cap belongs to the configured model. A `modelOverride` to a
// different model (a personality role, think_deeper) must not inherit it:
// Opus's 128000 sent to Haiku 4.5 (64000) is refused by the API.
describe('max_tokens follows the model a modelOverride requests', () => {
  const capFor = (model: string) => (model === 'claude-haiku-4-5' ? 64_000 : undefined);
  const sent = (captured: string[]) => JSON.parse(captured[0] ?? '{}').max_tokens;

  it('uses maxOutputTokensFor(override) for a different model', async () => {
    const captured: string[] = [];
    const p = provider([], captured, { maxOutputTokens: 128_000, maxOutputTokensFor: capFor });
    await drain(p.complete(hello, [], { modelOverride: 'claude-haiku-4-5' }));
    expect(sent(captured)).toBe(64_000);
  });

  it('an override the resolver does not know falls back to 8096, not the configured cap', async () => {
    const captured: string[] = [];
    const p = provider([], captured, { maxOutputTokens: 128_000, maxOutputTokensFor: capFor });
    await drain(p.complete(hello, [], { modelOverride: 'claude-unknown-9' }));
    expect(sent(captured)).toBe(8096);
  });

  it('an override without a resolver falls back to 8096', async () => {
    const captured: string[] = [];
    const p = provider([], captured, { maxOutputTokens: 128_000 });
    await drain(p.complete(hello, [], { modelOverride: 'claude-haiku-4-5' }));
    expect(sent(captured)).toBe(8096);
  });

  it('an override naming the configured model keeps the configured cap', async () => {
    const captured: string[] = [];
    const p = provider([], captured, { maxOutputTokens: 128_000, maxOutputTokensFor: capFor });
    await drain(p.complete(hello, [], { modelOverride: MODEL }));
    expect(sent(captured)).toBe(128_000);
  });

  it('a per-call maxTokens still wins over the override cap', async () => {
    const captured: string[] = [];
    const p = provider([], captured, { maxOutputTokensFor: capFor });
    await drain(p.complete(hello, [], { modelOverride: 'claude-haiku-4-5', maxTokens: 300 }));
    expect(sent(captured)).toBe(300);
  });

  it('the factory passes the resolver through', async () => {
    const p = await anthropicFactory({
      config: { model: MODEL, apiKey: 'k', maxOutputTokensFor: capFor },
      secrets: { get: async () => null },
      logger: { warn: () => {} },
    } as unknown as Parameters<typeof anthropicFactory>[0]);
    const resolver = (p as unknown as { maxOutputTokensFor?: (m: string) => number | undefined })
      .maxOutputTokensFor;
    expect(resolver?.('claude-haiku-4-5')).toBe(64_000);
  });

  it('AuthRotatingProvider hands the resolver to every pooled key', async () => {
    const pool = new AuthRotatingProvider(
      [
        { id: 'a', apiKey: 'k', priority: 2 },
        { id: 'b', apiKey: 'k2', priority: 1 },
      ],
      MODEL,
      { maxOutputTokensFor: capFor },
    );
    const slots = (
      pool as unknown as {
        providers: Array<{ maxOutputTokensFor?: (m: string) => number | undefined }>;
      }
    ).providers;
    expect(slots.map((s) => s.maxOutputTokensFor?.('claude-haiku-4-5'))).toEqual([64_000, 64_000]);
  });
});

describe('UBP-037 — an in-stream overloaded/rate-limit error before any chunk is retried', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('overloaded_error after message_start → retried, the retry streams the answer', async () => {
    const captured: string[] = [];
    const chunks = await drainWithTimers(
      provider([streamError('overloaded_error')], captured).complete(hello, [], {}),
    );
    expect(captured).toHaveLength(2);
    expect(chunks.some((c) => c.type === 'text_delta' && c.text === 'ok')).toBe(true);
  });

  it('rate_limit_error is retried too', async () => {
    const captured: string[] = [];
    await drainWithTimers(
      provider([streamError('rate_limit_error')], captured).complete(hello, [], {}),
    );
    expect(captured).toHaveLength(2);
  });

  it('bounded: gives up after 3 attempts with the vendor error', async () => {
    const captured: string[] = [];
    const bodies = [1, 2, 3, 4].map(() => streamError('overloaded_error'));
    await expect(
      drainWithTimers(provider(bodies, captured).complete(hello, [], {})),
    ).rejects.toThrow(/overloaded_error/);
    expect(captured).toHaveLength(3);
  });

  it('not once a chunk reached the caller', async () => {
    const captured: string[] = [];
    await expect(
      drainWithTimers(provider([errorAfterText], captured).complete(hello, [], {})),
    ).rejects.toThrow(/overloaded_error/);
    expect(captured).toHaveLength(1);
  });

  it('not on a chain hop (maxRetries: 0) — the chain fails over instead', async () => {
    const captured: string[] = [];
    await expect(
      drainWithTimers(
        provider([streamError('overloaded_error')], captured, { maxRetries: 0 }).complete(
          hello,
          [],
          {},
        ),
      ),
    ).rejects.toThrow(/overloaded_error/);
    expect(captured).toHaveLength(1);
  });

  it('not other in-stream errors', async () => {
    const captured: string[] = [];
    await expect(
      drainWithTimers(provider([streamError('api_error')], captured).complete(hello, [], {})),
    ).rejects.toThrow();
    expect(captured).toHaveLength(1);
  });

  it('not after an abort', async () => {
    const captured: string[] = [];
    const controller = new AbortController();
    const stream = provider([streamError('overloaded_error')], captured).complete(hello, [], {
      abortSignal: controller.signal,
    });
    const it0 = stream[Symbol.asyncIterator]();
    const first = it0.next();
    first.catch(() => {});
    controller.abort();
    await expect(first).rejects.toBeDefined();
    expect(captured.length).toBeLessThanOrEqual(1);
  });
});

describe('UBP-037 — AuthRotatingProvider rotates on a status-less in-stream error', () => {
  function failing(calls: string[], id: string, err: unknown): LLMProvider {
    return {
      name: 'anthropic',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: true,
      supportsThinking: false,
      complete(): AsyncIterable<CompletionChunk> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<CompletionChunk>> => {
              calls.push(id);
              throw err;
            },
          }),
        };
      },
      async countTokens() {
        return 1;
      },
    };
  }

  function answering(calls: string[], id: string): LLMProvider {
    return {
      ...failing(calls, id, null),
      async *complete(): AsyncIterable<CompletionChunk> {
        calls.push(id);
        yield { type: 'text_delta', text: 'ok' };
      },
    };
  }

  const sseError = (type: 'overloaded_error' | 'rate_limit_error') =>
    new Anthropic.APIError(
      undefined,
      { type: 'error', error: { type, message: 'Overloaded' } },
      undefined,
      new Headers(),
      type,
    );

  for (const type of ['overloaded_error', 'rate_limit_error'] as const) {
    it(`rotates on an SSE ${type} (no status)`, async () => {
      const calls: string[] = [];
      const pool = new AuthRotatingProvider(
        [
          { id: 'p1', apiKey: 'k1', priority: 2 },
          { id: 'p2', apiKey: 'k2', priority: 1 },
        ],
        'mock-model',
      );
      (pool as unknown as { providers: LLMProvider[] }).providers = [
        failing(calls, 'first', sseError(type)),
        answering(calls, 'second'),
      ];
      const chunks = await drain(
        pool.complete([], [], { abortSignal: new AbortController().signal } as CompletionOptions),
      );
      expect(calls).toEqual(['first', 'second']);
      expect(chunks).toEqual([{ type: 'text_delta', text: 'ok' }]);
    });
  }
});
