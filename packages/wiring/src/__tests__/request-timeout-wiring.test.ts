// Lane 4a(d) — requestTimeoutMs threads from WiringConfig through createLLM to
// BOTH provider families' SDK clients, and with no key set each one lands on
// DEFAULT_LLM_REQUEST_TIMEOUT_MS (20 minutes) rather than its SDK's inherited
// 10-minute default. `maxRetries` is OpenAI-compat only; Anthropic has no such
// knob wired, which the Anthropic cases here do not assert either way.
//
// The Anthropic half covers both construction paths, because they are separate
// code: the plugin factory (`anthropicFactory`, no rotation keys) and the
// inline `AuthRotatingProvider` pool that `createLLM` builds when
// `rotationKeys` is non-empty.

import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLM } from '../index';

const SDK_DEFAULT_MAX_RETRIES = 2;

function clientOf(provider: unknown): { timeout: number; maxRetries: number } {
  return (provider as { client: { timeout: number; maxRetries: number } }).client;
}

function pooledTimeouts(provider: unknown): number[] {
  const pool = (provider as { providers: unknown[] }).providers;
  return pool.map((p) => clientOf(p).timeout);
}

describe('createLLM — requestTimeoutMs threading (Lane 4a(d))', () => {
  it('openai-compat, no keys set → the 20-minute default, with the SDK retry count untouched', async () => {
    const provider = await createLLM({
      provider: 'openrouter',
      model: 'qwen/qwen3-8b',
      apiKey: 'k',
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    const client = clientOf(provider);
    expect(client.timeout).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(client.maxRetries).toBe(SDK_DEFAULT_MAX_RETRIES);
  });

  it('openai-compat, configured values reach the client', async () => {
    const provider = await createLLM({
      provider: 'openrouter',
      model: 'qwen/qwen3-8b',
      apiKey: 'k',
      requestTimeoutMs: 120_000,
      maxRetries: 0,
    });
    const client = clientOf(provider);
    expect(client.timeout).toBe(120_000);
    expect(client.maxRetries).toBe(0);
  });

  it('anthropic, no keys set → the 20-minute default', async () => {
    const provider = await createLLM({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'k',
    });
    expect(clientOf(provider).timeout).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
  });

  it('anthropic, a configured value reaches the client', async () => {
    const provider = await createLLM({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'k',
      requestTimeoutMs: 90_000,
    });
    expect(clientOf(provider).timeout).toBe(90_000);
  });

  it('anthropic rotation pool — every key gets the default, and every key gets an override', async () => {
    const base = {
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-20250514',
      apiKey: 'k1',
      rotationKeys: [{ apiKey: 'k2', priority: 50 }],
    };

    const defaulted = await createLLM(base);
    expect(pooledTimeouts(defaulted)).toEqual([
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    ]);

    const overridden = await createLLM({ ...base, requestTimeoutMs: 30_000 });
    expect(pooledTimeouts(overridden)).toEqual([30_000, 30_000]);
  });
});
