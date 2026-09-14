// Per-request deadline on the Anthropic SDK client — the seam this provider did
// not have. Before it was added, `new Anthropic({...})` was constructed with no
// `timeout`, so the client silently inherited `BaseAnthropic.DEFAULT_TIMEOUT`
// (600000) and no operator key could move it, while the sibling
// `OpenAICompatProvider` had honoured `requestTimeoutMs` since Lane 4a(d).
//
// What the number means HERE is narrower than it looks, and the assertions
// below say so explicitly: `complete()` always streams, and for a streaming
// body the SDK arms its timer around `fetch` and clears it once the response
// headers arrive. So this bounds time-to-headers, not stream duration — that is
// `DEFAULT_STREAMING_TIMEOUT_MS`'s job in `@ethosagent/core`.
//
// This file must NOT mock `@anthropic-ai/sdk` — the point is asserting what the
// real SDK client got at construction.

import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, type Logger } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, AuthRotatingProvider, anthropicFactory } from '../index';

/** The SDK's own default, which Ethos now replaces. */
const SDK_DEFAULT_TIMEOUT_MS = 600_000; // BaseAnthropic.DEFAULT_TIMEOUT

interface ClientView {
  client: { timeout: number };
}

function timeoutOf(provider: AnthropicProvider): number {
  return (provider as unknown as ClientView).client.timeout;
}

function pooledTimeouts(provider: AuthRotatingProvider): number[] {
  const providers = (provider as unknown as { providers: AnthropicProvider[] }).providers;
  return providers.map(timeoutOf);
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('AnthropicProvider — client retry count', () => {
  const retriesOf = (provider: unknown): number =>
    (provider as { client: { maxRetries: number } }).client.maxRetries;

  it('with no maxRetries the SDK default stands', () => {
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-4-20250514' });
    expect(retriesOf(provider)).toBe(2);
  });

  it('a configured maxRetries reaches the client, directly and through the factory', async () => {
    const direct = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-sonnet-4-20250514',
      maxRetries: 0,
    });
    expect(retriesOf(direct)).toBe(0);

    const viaFactory = await anthropicFactory({
      config: { apiKey: 'k', model: 'claude-sonnet-4-20250514', maxRetries: 0 },
      secrets: new InMemorySecretsResolver(),
      logger: fakeLogger(),
    });
    expect(retriesOf(viaFactory)).toBe(0);
  });
});

describe('AnthropicProvider — client request deadline', () => {
  it('with no requestTimeoutMs, the client carries the 20-minute Ethos default, not the SDK 10-minute one', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-4-20250514' });
    expect(timeoutOf(provider)).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(timeoutOf(provider)).toBe(1_200_000);

    // The override, stated as an assertion: exactly twice the SDK's default.
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const bare = new Anthropic({ apiKey: 'k' });
    expect(bare.timeout).toBe(SDK_DEFAULT_TIMEOUT_MS);
    expect(timeoutOf(provider)).toBe(bare.timeout * 2);
  });

  it('an explicit requestTimeoutMs reaches the client', () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-sonnet-4-20250514',
      requestTimeoutMs: 45_000,
    });
    expect(timeoutOf(provider)).toBe(45_000);
  });

  it('an explicit requestTimeoutMs of 0 is honoured as "no deadline", not replaced by the default', () => {
    // `??`, not truthiness. packages/config drops `0` before it reaches here,
    // but a programmatic caller must not be silently given 20 minutes.
    const provider = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-sonnet-4-20250514',
      requestTimeoutMs: 0,
    });
    expect(timeoutOf(provider)).toBe(0);
  });

  it('the factory threads requestTimeoutMs from config, and defaults without it', async () => {
    const configured = await anthropicFactory({
      config: { model: 'claude-sonnet-4-20250514', apiKey: 'sk-test', requestTimeoutMs: 90_000 },
      secrets: new InMemorySecretsResolver(),
      logger: fakeLogger(),
    });
    expect(timeoutOf(configured as AnthropicProvider)).toBe(90_000);

    const bare = await anthropicFactory({
      config: { model: 'claude-sonnet-4-20250514', apiKey: 'sk-test' },
      secrets: new InMemorySecretsResolver(),
      logger: fakeLogger(),
    });
    expect(timeoutOf(bare as AnthropicProvider)).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
  });
});

describe('AuthRotatingProvider — every pooled key gets the deadline', () => {
  // Each profile builds its own AnthropicProvider, so a deadline applied only
  // on the single-key path would silently not apply to a rotation deployment.
  const profiles = [
    { id: 'primary', apiKey: 'k1', priority: 100 },
    { id: 'backup', apiKey: 'k2', priority: 50 },
  ];

  it('defaults every pooled client to the 20-minute default', () => {
    const pool = new AuthRotatingProvider(profiles, 'claude-sonnet-4-20250514');
    expect(pooledTimeouts(pool)).toEqual([
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    ]);
  });

  it('applies a configured requestTimeoutMs to every pooled client', () => {
    const pool = new AuthRotatingProvider(profiles, 'claude-sonnet-4-20250514', {
      requestTimeoutMs: 30_000,
    });
    expect(pooledTimeouts(pool)).toEqual([30_000, 30_000]);
  });

  it('applies an explicit 0 to every pooled client rather than falling back', () => {
    const pool = new AuthRotatingProvider(profiles, 'claude-sonnet-4-20250514', {
      requestTimeoutMs: 0,
    });
    expect(pooledTimeouts(pool)).toEqual([0, 0]);
  });
});
