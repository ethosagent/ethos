// Presence §4 — `CompletionOptions.effort` becomes a `thinking` block through
// `EFFORT_THINKING_BUDGET` on a budget-mode model (`anthropicModelCapabilities`;
// adaptive models are covered by thinking-capabilities.test.ts). Wire bytes
// are asserted through the SDK's fetch seam (no network).

import type { CompletionChunk, CompletionOptions, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, EFFORT_THINKING_BUDGET } from '../index';

const THINKING_MODEL = 'claude-sonnet-4-5';
const PLAIN_MODEL = 'claude-mythos-5';

function sse(events: Array<Record<string, unknown>>): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`;
}

const okBody = sse([
  {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: THINKING_MODEL,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
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

const hello: Message[] = [{ role: 'user', content: 'hello' }];

async function requestBody(
  model: string,
  options: CompletionOptions,
  maxOutputTokens?: number,
): Promise<string> {
  const captured: string[] = [];
  const provider = new AnthropicProvider({
    apiKey: 'test-key',
    model,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      captured.push(String(init?.body ?? ''));
      return new Response(okBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete(hello, [], options)) chunks.push(c);
  const body = captured[0];
  if (body === undefined) throw new Error('no messages request was sent');
  return body;
}

describe('anthropic reasoning effort', () => {
  it('high on a thinking model sends a thinking block with the mapped budget', async () => {
    const body = JSON.parse(await requestBody(THINKING_MODEL, { effort: 'high' }, 32_000));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: EFFORT_THINKING_BUDGET.high });
    expect(body.max_tokens).toBe(32_000);
  });

  it('low and high produce different bodies for one model', async () => {
    const low = JSON.parse(await requestBody(THINKING_MODEL, { effort: 'low' }, 32_000));
    const high = JSON.parse(await requestBody(THINKING_MODEL, { effort: 'high' }, 32_000));
    expect(low.thinking.budget_tokens).toBe(EFFORT_THINKING_BUDGET.low);
    expect(low.thinking.budget_tokens).toBeLessThan(high.thinking.budget_tokens);
  });

  it('keeps the budget under max_tokens, leaving room for the answer', async () => {
    // Default cap 8096: `high` (16384) would be refused by the API.
    const body = JSON.parse(await requestBody(THINKING_MODEL, { effort: 'high' }));
    expect(body.thinking.budget_tokens).toBe(8096 - 1024);
    expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
  });

  it('sends no thinking block on a model outside the capability table', async () => {
    const body = JSON.parse(await requestBody(PLAIN_MODEL, { effort: 'high' }, 32_000));
    expect(body.thinking).toBeUndefined();
  });

  it("'off' sends no thinking block", async () => {
    const body = JSON.parse(await requestBody(THINKING_MODEL, { effort: 'off' }, 32_000));
    expect(body.thinking).toBeUndefined();
  });

  it('an explicit thinkingBudget wins over effort', async () => {
    const body = JSON.parse(
      await requestBody(THINKING_MODEL, { effort: 'high', thinkingBudget: 2000 }, 32_000),
    );
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
  });

  it('with no effort the body is byte-identical to an effort-off request', async () => {
    const without = await requestBody(THINKING_MODEL, {});
    expect(JSON.parse(without).thinking).toBeUndefined();
    expect(await requestBody(THINKING_MODEL, { effort: 'off' })).toBe(without);
  });
});
