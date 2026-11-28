// think-deeper-tier-switch Task 3.2 — a `modelOverride` (a `think_deeper`
// escalation, a personality role) is PRICED as the override model, not as the
// provider's configured one, so deep spend reaches the session budget at the
// deep rate (`transport.ts` prices `params.model`, which is `effectiveModel`).

import { estimateCost } from '@ethosagent/pricing';
import type { CompletionChunk, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../index';

const CONFIGURED = 'claude-sonnet-4-5';
const OVERRIDE = 'claude-haiku-4-5';

const body = `${[
  {
    type: 'message_start',
    message: {
      id: 'm',
      type: 'message',
      role: 'assistant',
      content: [],
      model: CONFIGURED,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 500 },
  },
  { type: 'message_stop' },
]
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`)
  .join('\n')}\n`;

const hello: Message[] = [{ role: 'user', content: 'hello' }];

async function costOf(modelOverride?: string): Promise<number | undefined> {
  const p = new AnthropicProvider({
    apiKey: 'k',
    model: CONFIGURED,
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  const chunks: CompletionChunk[] = [];
  for await (const c of p.complete(hello, [], modelOverride ? { modelOverride } : {})) {
    chunks.push(c);
  }
  const usage = chunks.find((c) => c.type === 'usage');
  return usage?.type === 'usage' ? usage.usage.estimatedCostUsd : undefined;
}

describe('estimatedCostUsd follows the model actually served', () => {
  const tokens = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  it('prices the configured model with no override', async () => {
    expect(await costOf()).toBeCloseTo(estimateCost(CONFIGURED, tokens).costUsd, 10);
  });

  it('prices the override model, not the configured one', async () => {
    const overridden = await costOf(OVERRIDE);
    expect(overridden).toBeCloseTo(estimateCost(OVERRIDE, tokens).costUsd, 10);
    expect(estimateCost(OVERRIDE, tokens).costUsd).not.toBe(
      estimateCost(CONFIGURED, tokens).costUsd,
    );
    expect(overridden).not.toBeCloseTo(estimateCost(CONFIGURED, tokens).costUsd, 10);
  });
});
