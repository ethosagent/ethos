// V8 / D17 row 5 — when the vendor rejects the model at request time, Codex
// says something useful and Anthropic said nothing but the vendor's own bare
// error. These pin the sibling this provider gained: the vendor body kept
// verbatim and untruncated, the requested model id named, and a fix line.
//
// The last describe block is the interaction that makes the wording load-
// bearing. `classifyProviderError` in `packages/core/src/providers/
// chained-provider.ts` classifies by reading the message TEXT, and
// `model_not_found` is in `FAILOVER_REASONS` — so a message that drops the
// status code silently moves a 404 from `ALL_PROVIDERS_REJECT_MODEL` to
// `ALL_PROVIDERS_FAILED`. `@ethosagent/core` is a test-only import here,
// resolved through the tsconfig/vitest alias; nothing in `src/` reaches for it.

import Anthropic from '@anthropic-ai/sdk';
import { ChainedProvider } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../index';

const MODEL = 'claude-sonnet-4-5';

/** Exactly the body Anthropic returns for an unknown model id. */
const NOT_FOUND_BODY = {
  type: 'error',
  error: { type: 'not_found_error', message: `model: ${MODEL}` },
};

/** A 400 that is about something other than the model. */
const BAD_MAX_TOKENS_BODY = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than 0' },
};

function apiError(status: number, body: unknown): Error {
  return new Anthropic.APIError(status, body as object, undefined, undefined);
}

/**
 * A stand-in for the SDK client whose stream throws `err` on the first pull —
 * the shape a request-time rejection takes, since the vendor answers before any
 * chunk exists. Hand-rolled rather than an `async *` that only throws, which
 * `lint/correctness/useYield` refuses.
 */
function throwingClient(err: unknown): Anthropic {
  return {
    messages: {
      countTokens: async () => ({ input_tokens: 1 }),
      stream: () => ({
        request_id: null,
        abort() {},
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<CompletionChunk>> => {
            throw err;
          },
        }),
      }),
    },
  } as unknown as Anthropic;
}

/** Drives a real provider whose SDK client is swapped for a throwing one. */
async function completionError(err: unknown, model = MODEL): Promise<Error> {
  const provider = new AnthropicProvider({ apiKey: 'k', model });
  (provider as unknown as { client: Anthropic }).client = throwingClient(err);
  try {
    for await (const _chunk of provider.complete([{ role: 'user', content: 'hi' }], [], {})) {
      // The stream throws before the first chunk; reaching here is the failure.
    }
  } catch (thrown) {
    return thrown as Error;
  }
  throw new Error('expected the completion to throw');
}

describe('AnthropicProvider — model rejection (V8)', () => {
  it('an anthropic model rejection surfaces the vendor body verbatim and names the model', async () => {
    const err = await completionError(apiError(404, NOT_FOUND_BODY));

    // The vendor's own words, byte for byte — not a paraphrase.
    expect(err.message).toContain(JSON.stringify(NOT_FOUND_BODY));
    expect(err.message).toContain(`anthropic rejected the model "${MODEL}"`);
    expect(err.message).toContain('Nothing ran.');
    expect(err.message).toContain(
      'Fix: check the model id, or run `ethos models test <alias>` to see what this key can run.',
    );
    // Pre-fix, this was the whole experience.
    expect(err.message).not.toBe(apiError(404, NOT_FOUND_BODY).message);
    expect(err.cause).toBeInstanceOf(Anthropic.APIError);
  });

  it('matches a 400 that names the model, not only a 404', async () => {
    const body = {
      type: 'error',
      error: { type: 'invalid_request_error', message: `model: ${MODEL} is not supported` },
    };
    const err = await completionError(apiError(400, body));

    expect(err.message).toContain(`anthropic rejected the model "${MODEL}"`);
    expect(err.message).toContain(JSON.stringify(body));
  });

  it('names the model actually requested, not the one the provider was constructed with', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-4-5' });
    (provider as unknown as { client: Anthropic }).client = throwingClient(
      apiError(404, NOT_FOUND_BODY),
    );
    let message = '';
    try {
      for await (const _chunk of provider.complete([{ role: 'user', content: 'hi' }], [], {
        modelOverride: MODEL,
      })) {
        // unreachable
      }
    } catch (thrown) {
      message = (thrown as Error).message;
    }
    expect(message).toContain(`anthropic rejected the model "${MODEL}"`);
    expect(message).not.toContain('claude-haiku-4-5');
  });

  it('the vendor body is not truncated', async () => {
    // Long enough that any per-result trim would show, with a marker at each end.
    const long = `model: ${MODEL} — START${'x'.repeat(20_000)}END`;
    const body = { type: 'error', error: { type: 'not_found_error', message: long } };
    const err = await completionError(apiError(404, body));

    const serialized = JSON.stringify(body);
    expect(err.message).toContain(serialized);
    expect(err.message).toContain('END"}}');
    expect(err.message).not.toContain('truncated');
    // The whole body, not a prefix of it.
    expect(err.message.length).toBeGreaterThan(serialized.length);
  });

  it('a non-model 400 is not reported as a model rejection', async () => {
    const original = apiError(400, BAD_MAX_TOKENS_BODY);
    const err = await completionError(original);

    expect(err).toBe(original);
    expect(err.message).not.toContain('anthropic rejected the model');
  });

  it('a 429 whose body happens to name the model is left alone', async () => {
    // The status gate is what keeps a rate limit or an auth failure from being
    // dressed up as a model rejection.
    const original = apiError(429, {
      type: 'error',
      error: { type: 'rate_limit_error', message: `rate limit reached for model ${MODEL}` },
    });
    const err = await completionError(original);

    expect(err).toBe(original);
  });

  it('a 404 whose body does not echo the requested model is left alone', async () => {
    const original = apiError(404, {
      type: 'error',
      error: { type: 'not_found_error', message: 'workspace not found' },
    });
    const err = await completionError(original);

    expect(err).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// The classification interaction — the reason the status stays in the message
// ---------------------------------------------------------------------------

function throwingProvider(name: string, err: Error): LLMProvider {
  return {
    name,
    model: MODEL,
    maxContextTokens: 200_000,
    supportsCaching: true,
    supportsThinking: false,
    complete(): AsyncIterable<CompletionChunk> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<CompletionChunk>> => {
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

async function chainFailure(err: Error): Promise<string> {
  const chain = new ChainedProvider([throwingProvider('a', err), throwingProvider('b', err)]);
  try {
    for await (const _chunk of chain.complete([], [], {})) {
      // unreachable
    }
  } catch (thrown) {
    return (thrown as Error).message;
  }
  throw new Error('expected the chain to throw');
}

describe('classifyProviderError still reads the new message the old way', () => {
  it('a 404 model rejection still classifies as model_not_found', async () => {
    const before = await chainFailure(apiError(404, NOT_FOUND_BODY));
    const after = await chainFailure(await completionError(apiError(404, NOT_FOUND_BODY)));

    expect(before).toContain('ALL_PROVIDERS_REJECT_MODEL');
    expect(after).toContain('ALL_PROVIDERS_REJECT_MODEL');
  });

  it('a 400 model rejection still classifies as unknown, as the bare error did', async () => {
    const body = {
      type: 'error',
      error: { type: 'invalid_request_error', message: `model: ${MODEL} is not supported` },
    };
    const before = await chainFailure(apiError(400, body));
    const after = await chainFailure(await completionError(apiError(400, body)));

    expect(before).toContain('ALL_PROVIDERS_FAILED');
    expect(after).toContain('ALL_PROVIDERS_FAILED');
    expect(after).toContain('(unknown)');
  });
});
