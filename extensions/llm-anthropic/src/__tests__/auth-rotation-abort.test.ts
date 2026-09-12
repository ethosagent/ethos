// Rotation is for a provider that failed, not for a turn the user cancelled.
// An abort mid-stream can surface as a rate-limit/auth-shaped error (the request
// dies while the platform is answering), and rotating on it re-issues the whole
// request on the next key — spend and a stream nobody is waiting for. The guard
// is explicit rather than relying on `classifyError` returning 'unknown' for
// `APIUserAbortError`: that is a fallthrough, not a decision.

import Anthropic from '@anthropic-ai/sdk';
import type { CompletionChunk, CompletionOptions, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AuthRotatingProvider } from '../index';

/** A provider slot that records its calls and throws `err` before any chunk. */
function failing(calls: string[], id: string, err: unknown): LLMProvider {
  return {
    name: 'anthropic',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: true,
    supportsThinking: false,
    // Fails on the FIRST pull, before any chunk — the shape rotation is allowed
    // to act on. Hand-rolled rather than an `async *` that only throws (which
    // `lint/correctness/useYield` refuses, rightly).
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

/**
 * Two profiles, then the real `AnthropicProvider` slots swapped for fakes. The
 * rotation logic is what is under test; a real slot would need a live API.
 */
function rotatingWith(slots: LLMProvider[]): AuthRotatingProvider {
  const provider = new AuthRotatingProvider(
    [
      { id: 'p1', apiKey: 'k1', priority: 2 },
      { id: 'p2', apiKey: 'k2', priority: 1 },
    ],
    'mock-model',
  );
  (provider as unknown as { providers: LLMProvider[] }).providers = slots;
  return provider;
}

async function drain(stream: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const rateLimited = () => new Anthropic.APIError(429, undefined, 'slow down', undefined);

describe('AuthRotatingProvider — an aborted turn does not rotate', () => {
  it('rethrows a rotatable failure once the abort signal has fired', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const provider = rotatingWith([
      failing(calls, 'first', rateLimited()),
      failing(calls, 'second', rateLimited()),
    ]);

    const options = { abortSignal: controller.signal } as CompletionOptions;
    await expect(drain(provider.complete([], [], options))).rejects.toThrow('slow down');
    expect(calls).toEqual(['first']);
  });

  it('still rotates on the same failure when nothing was aborted', async () => {
    const calls: string[] = [];
    const provider = rotatingWith([
      failing(calls, 'first', rateLimited()),
      failing(calls, 'second', rateLimited()),
    ]);

    const options = { abortSignal: new AbortController().signal } as CompletionOptions;
    await expect(drain(provider.complete([], [], options))).rejects.toThrow('slow down');
    expect(calls).toEqual(['first', 'second']);
  });
});
