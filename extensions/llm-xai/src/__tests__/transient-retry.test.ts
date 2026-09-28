// UBP-030 / UBP-034 — xAI rides llm-codex's `streamResponsesApi`, so it gets the
// pre-first-byte transient retry and the failed/incomplete handling from there.
// These pin that the provider threads `maxRetries` through and that a
// `response.failed` reaches the caller as an error.

import type { CompletionChunk } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XaiProvider } from '../index';

function sse(events: Array<[string, unknown]>): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(text, { status: 200 });
}

function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function drain(provider: XaiProvider): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const c of provider.complete([{ role: 'user', content: 'hi' }], [], {})) out.push(c);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('XaiProvider transient retry', () => {
  it('retries a 429 with retry-after: 0 once, then streams', async () => {
    const fn = stubFetch(
      new Response('', { status: 429, headers: { 'retry-after': '0' } }),
      sse([
        ['response.output_text.delta', { delta: 'ok' }],
        ['response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } }],
      ]),
    );
    const chunks = await drain(new XaiProvider({ model: 'grok-4.6', apiKey: 'k' }));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'ok' });
  });

  it('does not retry with maxRetries: 0 (a chain hop)', async () => {
    const fn = stubFetch(new Response('', { status: 429 }));
    await expect(
      drain(new XaiProvider({ model: 'grok-4.6', apiKey: 'k', maxRetries: 0 })),
    ).rejects.toThrow(/xAI Responses API error 429/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('surfaces response.failed as an error naming xAI', async () => {
    stubFetch(
      sse([
        ['response.output_text.delta', { delta: 'partial' }],
        ['response.failed', { response: { error: { code: 'server_error', message: 'boom' } } }],
      ]),
    );
    await expect(drain(new XaiProvider({ model: 'grok-4.6', apiKey: 'k' }))).rejects.toThrow(
      'xAI Responses API response failed (server_error): boom',
    );
  });
});
