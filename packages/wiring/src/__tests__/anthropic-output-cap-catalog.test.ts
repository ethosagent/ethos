// Anthropic models were capped at 8096 output tokens because no catalog row
// carried `profile.maxOutputTokens`, so `AnthropicProvider` fell back to
// `DEFAULT_MAX_OUTPUT_TOKENS`. The catalog now records each documented cap
// (Anthropic model reference, 2026-06-24), and this file pins that the number
// reaches the wire: `MODEL_CATALOG` → `lookupProfile` → `createLLM` →
// `anthropicFactory` / `AuthRotatingProvider` → the request body's `max_tokens`.
// The SDK's fetch is stubbed globally, so nothing touches the network.

import { ChainedProvider } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLLM, type WiringConfig } from '../index';
import { getModelsForProvider, lookupContextWindow, lookupProfile } from '../model-catalog';

const DOCUMENTED: Array<[model: string, contextWindow: number, maxOutput: number]> = [
  ['claude-fable-5-1', 1_000_000, 128_000],
  ['claude-mythos-5-1', 1_000_000, 128_000],
  ['claude-fable-5', 1_000_000, 128_000],
  ['claude-mythos-5', 1_000_000, 128_000],
  ['claude-opus-5-5', 1_000_000, 128_000],
  ['claude-opus-5', 1_000_000, 128_000],
  ['claude-opus-4-8', 1_000_000, 128_000],
  ['claude-opus-4-7', 1_000_000, 128_000],
  ['claude-opus-4-6', 1_000_000, 128_000],
  ['claude-sonnet-5', 1_000_000, 128_000],
  ['claude-sonnet-4-6', 1_000_000, 128_000],
  ['claude-haiku-4-5', 200_000, 64_000],
  ['claude-haiku-4-5-20251001', 200_000, 64_000],
  // Legacy 200K rows: 64K max output per each model's own page (2026-09-28).
  ['claude-sonnet-4-5-20250929', 200_000, 64_000],
  ['claude-opus-4-5-20251101', 200_000, 64_000],
];

function sse(events: Array<Record<string, unknown>>): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`;
}

const OK_BODY = sse([
  {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'm',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
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

let bodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(OK_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const hello: Message[] = [{ role: 'user', content: 'hello' }];

async function sentMaxTokens(llm: LLMProvider, modelOverride?: string): Promise<unknown> {
  const out: CompletionChunk[] = [];
  for await (const c of llm.complete(hello, [], modelOverride ? { modelOverride } : {})) {
    out.push(c);
  }
  return bodies.at(-1)?.max_tokens;
}

function anthropic(model: string, extra: Partial<WiringConfig> = {}): WiringConfig {
  return { provider: 'anthropic', model, apiKey: 'k', ...extra };
}

describe('model catalog — documented Anthropic limits', () => {
  it.each(DOCUMENTED)('%s: context %d, max output %d', (model, contextWindow, maxOutput) => {
    expect(lookupContextWindow('anthropic', model)).toBe(contextWindow);
    expect(lookupProfile('anthropic', model)?.maxOutputTokens).toBe(maxOutput);
  });

  it('lists every Anthropic catalog row above, so none falls back to 8096', () => {
    const documented = new Set(DOCUMENTED.map(([model]) => model));
    const rows = getModelsForProvider('anthropic', new Date('2026-09-28T00:00:00Z'));
    for (const row of rows) expect(documented.has(row.modelId), row.modelId).toBe(true);
  });

  it('caps only anthropic rows — OpenRouter, Azure and Bedrock ids carry no Anthropic cap', () => {
    expect(lookupProfile('openrouter', 'anthropic/claude-opus-5')?.maxOutputTokens).toBeUndefined();
    expect(lookupProfile('azure', 'claude-opus-4-6')?.maxOutputTokens).toBeUndefined();
    expect(lookupProfile('bedrock', 'anthropic.claude-opus-5')?.maxOutputTokens).toBeUndefined();
  });
});

describe('createLLM — the catalog cap reaches the Anthropic request body', () => {
  it('claude-opus-5 sends max_tokens 128000', async () => {
    expect(await sentMaxTokens(await createLLM(anthropic('claude-opus-5')))).toBe(128_000);
  });

  it('claude-haiku-4-5 sends max_tokens 64000', async () => {
    expect(await sentMaxTokens(await createLLM(anthropic('claude-haiku-4-5')))).toBe(64_000);
  });

  it('a model the catalog does not know falls back to 8096', async () => {
    expect(await sentMaxTokens(await createLLM(anthropic('claude-unknown-9')))).toBe(8096);
  });

  it('models.anthropic/<id>.maxOutputTokens still beats the catalog', async () => {
    const llm = await createLLM(
      anthropic('claude-opus-5', {
        models: { 'anthropic/claude-opus-5': { maxOutputTokens: 20_000 } },
      }),
    );
    expect(await sentMaxTokens(llm)).toBe(20_000);
  });

  it('every key of a rotation pool sends the catalog cap', async () => {
    const llm = await createLLM(
      anthropic('claude-opus-5', { rotationKeys: [{ apiKey: 'k2', priority: 50 }] }),
    );
    expect(await sentMaxTokens(llm)).toBe(128_000);
    const pool = (llm as unknown as { providers: Array<{ maxOutputTokens?: number }> }).providers;
    expect(pool.map((p) => p.maxOutputTokens)).toEqual([128_000, 128_000]);
  });

  it('an anthropic hop of a provider chain sends its own model cap', async () => {
    const llm = await createLLM({
      ...anthropic('claude-opus-5'),
      providers: [
        { provider: 'anthropic', id: 'main', apiKey: 'k', model: 'claude-opus-5' },
        { provider: 'anthropic', id: 'cheap', apiKey: 'k', model: 'claude-haiku-4-5' },
      ],
    });
    expect(llm).toBeInstanceOf(ChainedProvider);
    const cheap = (llm as ChainedProvider).entryProvider('cheap');
    expect(cheap).toBeDefined();
    if (cheap) expect(await sentMaxTokens(cheap)).toBe(64_000);
  });

  // A personality role (or think_deeper) routes a turn to another model on the
  // same provider through `CompletionOptions.modelOverride`. The provider was
  // built for its configured model; sending Opus's 128000 to Haiku (64000)
  // would be refused, so the cap follows the model actually requested.
  it('a modelOverride uses the overriding model cap, not the configured one', async () => {
    const llm = await createLLM(anthropic('claude-opus-5'));
    expect(await sentMaxTokens(llm, 'claude-haiku-4-5')).toBe(64_000);
    expect(await sentMaxTokens(llm, 'claude-unknown-9')).toBe(8096);
  });

  it('a modelOverride honours a config override for the overriding model', async () => {
    const llm = await createLLM(
      anthropic('claude-opus-5', {
        models: { 'anthropic/claude-haiku-4-5': { maxOutputTokens: 12_000 } },
      }),
    );
    expect(await sentMaxTokens(llm, 'claude-haiku-4-5')).toBe(12_000);
  });

  it('a modelOverride on a rotation pool uses the overriding model cap', async () => {
    const llm = await createLLM(
      anthropic('claude-opus-5', { rotationKeys: [{ apiKey: 'k2', priority: 50 }] }),
    );
    expect(await sentMaxTokens(llm, 'claude-haiku-4-5')).toBe(64_000);
  });

  it('OpenRouter serving a Claude id gets no Anthropic catalog cap', async () => {
    const llm = await createLLM({
      provider: 'openrouter',
      model: 'anthropic/claude-opus-5',
      apiKey: 'k',
    });
    expect((llm as { maxOutputTokens?: number }).maxOutputTokens).toBeUndefined();
  });
});
