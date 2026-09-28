// V5-1 — a current Claude model whose input plus `max_tokens` exceeds its
// window answers with `stop_reason: 'model_context_window_exceeded'` instead of
// a 400. The output was cut off by the window, the same consequence as the
// output cap, so it must reach the loop as `max_tokens` (cut-off notice,
// truncated tool calls rejected by `rejectCutOffToolCalls` in
// packages/core/src/agent-loop/stages/stream-step.ts) — as the Bedrock
// transport already maps it. Before this it fell through to `end_turn`.
// Also pins `capabilities.maxOutputTokens`: the cap the provider actually
// sends, which the compaction gate reserves from the window.

import type { CompletionChunk, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, AuthRotatingProvider, DEFAULT_MAX_OUTPUT_TOKENS } from '../index';
import { toFinishReason } from '../transport';

const MODEL = 'claude-haiku-4-5';

function sse(events: Array<Record<string, unknown>>): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`;
}

function bodyStoppingWith(stopReason: string): string {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 150_000, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 50_000 },
    },
    { type: 'message_stop' },
  ]);
}

function haiku(body: string, maxOutputTokens?: number): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'test-key',
    model: MODEL,
    maxContextTokens: 200_000,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
}

const hello: Message[] = [{ role: 'user', content: 'hello' }];

describe('model_context_window_exceeded is reported as max_tokens', () => {
  it('Haiku 4.5 (200K window, 64K cap): the window-cut reply ends with max_tokens', async () => {
    const out: CompletionChunk[] = [];
    const p = haiku(bodyStoppingWith('model_context_window_exceeded'), 64_000);
    for await (const c of p.complete(hello, [], {})) out.push(c);
    expect(out.at(-1)).toEqual({ type: 'done', finishReason: 'max_tokens' });
  });

  it.each([
    ['end_turn', 'end_turn'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    ['stop_sequence', 'stop_sequence'],
    ['model_context_window_exceeded', 'max_tokens'],
  ])('toFinishReason(%s) → %s', (reason, expected) => {
    expect(toFinishReason(reason)).toBe(expected);
  });
});

describe('capabilities.maxOutputTokens is the cap the provider sends', () => {
  it('reports the profile cap', () => {
    expect(haiku('', 64_000).capabilities.maxOutputTokens).toBe(64_000);
  });

  it('reports the default cap when no profile cap was passed', () => {
    expect(haiku('').capabilities.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("a rotation pool reports its keys' cap too", () => {
    const pool = new AuthRotatingProvider(
      [
        { id: 'a', apiKey: 'k1', priority: 100 },
        { id: 'b', apiKey: 'k2', priority: 50 },
      ],
      MODEL,
      { maxOutputTokens: 64_000 },
    );
    expect(pool.capabilities.maxOutputTokens).toBe(64_000);
    // Vision is still not advertised by the pool (unchanged).
    expect(pool.capabilities.visionImages).toBeUndefined();
  });
});
