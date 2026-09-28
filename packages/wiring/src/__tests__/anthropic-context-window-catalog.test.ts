// `AnthropicProvider.maxContextTokens` reported 200_000 for every model
// (`anthropicContextTokens`), so the local compaction gate and the default
// server-compaction trigger ignored the 1M windows the model catalog records.
// The catalog window now reaches the provider the same way the output cap does:
// `MODEL_CATALOG` → `resolveContextWindow` (`contextWindow` config > catalog) →
// `createLLM` → `anthropicFactory` / `AuthRotatingProvider` → `maxContextTokens`,
// and a `modelOverride` to a smaller-window model scales the trigger down.
// The SDK's fetch is stubbed globally, so nothing touches the network.

import { pressureGateTokens } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLLM, type WiringConfig } from '../index';

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

/** The `compact_20260112` trigger the last request carried. */
async function sentTrigger(llm: LLMProvider, modelOverride?: string): Promise<unknown> {
  const out: CompletionChunk[] = [];
  for await (const c of llm.complete(hello, [], modelOverride ? { modelOverride } : {})) {
    out.push(c);
  }
  const cm = bodies.at(-1)?.context_management as
    | { edits: Array<{ trigger: { value: number } }> }
    | undefined;
  return cm?.edits[0]?.trigger.value;
}

function anthropic(model: string, extra: Partial<WiringConfig> = {}): WiringConfig {
  return { provider: 'anthropic', model, apiKey: 'k', ...extra };
}

function withServerCompaction(model: string, extra: Partial<WiringConfig> = {}): WiringConfig {
  return {
    ...anthropic(model, extra),
    providers: [{ provider: 'anthropic', model, apiKey: 'k', serverCompaction: true }],
  };
}

const ROTATION = { rotationKeys: [{ apiKey: 'k2', priority: 50 }] };

describe('createLLM — the catalog window reaches AnthropicProvider.maxContextTokens', () => {
  it('claude-opus-5 reports 1_000_000', async () => {
    expect((await createLLM(anthropic('claude-opus-5'))).maxContextTokens).toBe(1_000_000);
  });

  it('claude-haiku-4-5 reports 200_000', async () => {
    expect((await createLLM(anthropic('claude-haiku-4-5'))).maxContextTokens).toBe(200_000);
  });

  it('a model the catalog does not know falls back to 200_000', async () => {
    expect((await createLLM(anthropic('claude-unknown-9'))).maxContextTokens).toBe(200_000);
  });

  it('an explicit contextWindow in config wins over the catalog', async () => {
    const llm = await createLLM(anthropic('claude-opus-5', { contextWindow: 400_000 }));
    expect(llm.maxContextTokens).toBe(400_000);
  });

  it('a rotation pool reports the catalog window, and honours contextWindow', async () => {
    expect((await createLLM(anthropic('claude-opus-5', ROTATION))).maxContextTokens).toBe(
      1_000_000,
    );
    expect((await createLLM(anthropic('claude-haiku-4-5', ROTATION))).maxContextTokens).toBe(
      200_000,
    );
    const overridden = await createLLM(
      anthropic('claude-opus-5', { ...ROTATION, contextWindow: 300_000 }),
    );
    expect(overridden.maxContextTokens).toBe(300_000);
  });
});

describe('createLLM — the default server-compaction trigger follows the real window', () => {
  it('claude-opus-5 triggers at the local gate over 1M, not over 200K', async () => {
    const llm = await createLLM(withServerCompaction('claude-opus-5'));
    expect(await sentTrigger(llm)).toBe(pressureGateTokens(1_000_000));
  });

  it('claude-haiku-4-5 keeps the 200K trigger', async () => {
    const llm = await createLLM(withServerCompaction('claude-haiku-4-5'));
    expect(await sentTrigger(llm)).toBe(pressureGateTokens(200_000));
  });

  it('a modelOverride to a smaller-window model scales the trigger to its window', async () => {
    const llm = await createLLM(withServerCompaction('claude-opus-5'));
    const base = pressureGateTokens(1_000_000);
    expect(await sentTrigger(llm, 'claude-haiku-4-5')).toBe(Math.floor((base * 200_000) / 1e6));
    // An override to a same-window model keeps the configured trigger.
    expect(await sentTrigger(llm, 'claude-sonnet-5')).toBe(base);
  });

  it('a rotation pool scales the trigger for a modelOverride too', async () => {
    const llm = await createLLM(withServerCompaction('claude-opus-5', ROTATION));
    const base = pressureGateTokens(1_000_000);
    expect(await sentTrigger(llm)).toBe(base);
    expect(await sentTrigger(llm, 'claude-haiku-4-5')).toBe(Math.floor((base * 200_000) / 1e6));
  });
});
