// Lane 4a(d) — configurable timeout + retry, pinned at the construction site.
//
// With NO keys configured the client must carry DEFAULT_LLM_REQUEST_TIMEOUT_MS
// (20 minutes) — Ethos's own deadline, deliberately DOUBLE the OpenAI SDK's
// inherited 10-minute default, so a slow reasoning turn or a cold local model
// load is not cut off mid-request. Retries are NOT overridden: the SDK's 2
// still apply, which is asserted against a bare SDK client so drift in the
// SDK's retry default is caught rather than pinned to a stale literal.
//
// The default stays LONG on purpose: a cold local model load (Ollama paging
// weights into RAM/VRAM) legitimately takes minutes; a short default would
// break the first turn on every fresh server start.
//
// This file must NOT mock the `openai` module — the whole point is asserting
// what the real SDK client got at construction.

import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  type Logger,
  type SecretsResolver,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider, openaiCompatFactory } from '../index';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const noopSecrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

interface ClientView {
  client: { timeout: number; maxRetries: number };
}

function clientOf(provider: OpenAICompatProvider): ClientView['client'] {
  return (provider as unknown as ClientView).client;
}

// The SDK's own 10-minute default, which Ethos now REPLACES. Kept as a named
// literal so the assertion below states plainly that the two differ.
const SDK_DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const SDK_DEFAULT_MAX_RETRIES = 2;

describe('OpenAICompatProvider — client timeout/retries (Lane 4a(d))', () => {
  it("with NO keys set, the client carries the 20-minute Ethos default and the SDK's 2 retries", async () => {
    const provider = new OpenAICompatProvider({
      name: 'openrouter',
      model: 'qwen/qwen3-8b',
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const client = clientOf(provider);
    expect(client.timeout).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(client.timeout).toBe(1_200_000);
    expect(client.maxRetries).toBe(SDK_DEFAULT_MAX_RETRIES);

    // The point of the override, stated as an assertion: the deadline is no
    // longer the SDK's, and it is exactly twice as long.
    const OpenAI = (await import('openai')).default;
    const bare = new OpenAI({ apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1' });
    expect(bare.timeout).toBe(SDK_DEFAULT_TIMEOUT_MS);
    expect(client.timeout).toBe(bare.timeout * 2);
    // Retries ARE still the SDK's — nothing here touches them, so a move in
    // the SDK's retry default is caught rather than pinned to a stale literal.
    expect(client.maxRetries).toBe(bare.maxRetries);
  });

  it('an explicit requestTimeoutMs of 0 is honoured as "no deadline", not replaced by the default', () => {
    // `??`, not truthiness. The config parser in packages/config drops `0` as a
    // typo before it gets here, but a programmatic caller can pass it and must
    // not be silently given 20 minutes instead.
    const provider = new OpenAICompatProvider({
      name: 'ollama',
      model: 'qwen3:8b',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      maxContextTokens: 32_000,
      requestTimeoutMs: 0,
    });
    expect(clientOf(provider).timeout).toBe(0);
  });

  it('configured requestTimeoutMs and maxRetries reach the client', () => {
    const provider = new OpenAICompatProvider({
      name: 'ollama',
      model: 'qwen3:8b',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      maxContextTokens: 32_000,
      requestTimeoutMs: 120_000,
      maxRetries: 0,
    });
    const client = clientOf(provider);
    expect(client.timeout).toBe(120_000);
    expect(client.maxRetries).toBe(0);
  });

  it('the factory threads requestTimeoutMs/maxRetries from config to the provider', async () => {
    const provider = await openaiCompatFactory({
      config: {
        provider: 'openai-compat',
        model: 'gpt-4o',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        requestTimeoutMs: 45_000,
        maxRetries: 5,
      },
      secrets: noopSecrets,
      logger: noopLogger,
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    const client = clientOf(provider as OpenAICompatProvider);
    expect(client.timeout).toBe(45_000);
    expect(client.maxRetries).toBe(5);
  });

  it('the factory applies the 20-minute default when config carries no keys', async () => {
    const provider = await openaiCompatFactory({
      config: {
        provider: 'openai-compat',
        model: 'gpt-4o',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
      },
      secrets: noopSecrets,
      logger: noopLogger,
    });
    const client = clientOf(provider as OpenAICompatProvider);
    expect(client.timeout).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(client.maxRetries).toBe(SDK_DEFAULT_MAX_RETRIES);
  });
});
