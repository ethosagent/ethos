// UBP-034 — the Responses API transport (shared by codex and xai) must not end
// a failed, incomplete or cut-off response as a silent successful turn.
// UBP-030 — the request itself is retried on a transient failure before the
// first byte. Recorded-shape SSE bodies (synthetic, built to the Responses
// API event names and payloads — not captured live).

import type { CompletionChunk } from '@ethosagent/types';
import { validateToolCallBuffering } from '@ethosagent/wiring/conformance';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ResponsesApiBody, ResponsesApiError, streamResponsesApi } from '../transport';

const BODY: ResponsesApiBody = { model: 'gpt-5.4-mini', input: [], stream: true };
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

function sse(events: Array<[string, unknown]>): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stubFetch(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function drain(iter: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const run = (retry?: Parameters<typeof streamResponsesApi>[6]) =>
  drain(streamResponsesApi(ENDPOINT, 'tok', BODY, undefined, undefined, 'Codex', retry));

const USAGE = { input_tokens: 10, output_tokens: 4 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Responses API terminal events (UBP-034)', () => {
  it('maps a completed tool-call response to start/delta/end, usage and a tool_use done', async () => {
    stubFetch(
      sse([
        ['response.created', { response: { id: 'resp_1' } }],
        [
          'response.output_item.added',
          { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file' } },
        ],
        ['response.function_call_arguments.delta', { delta: '{"path":"a"}' }],
        [
          'response.output_item.done',
          { item: { type: 'function_call', call_id: 'call_1', arguments: '{"path":"a"}' } },
        ],
        ['response.completed', { response: { usage: USAGE } }],
      ]),
    );
    const chunks = await run();
    expect(chunks.map((c) => c.type)).toEqual([
      'tool_use_start',
      'tool_use_delta',
      'tool_use_end',
      'usage',
      'done',
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'done', finishReason: 'tool_use' });
    expect(validateToolCallBuffering(chunks).passed).toBe(true);
  });

  it('throws on response.failed with the vendor code and message', async () => {
    stubFetch(
      sse([
        ['response.output_text.delta', { delta: 'partial ans' }],
        [
          'response.failed',
          {
            response: {
              status: 'failed',
              error: { code: 'server_error', message: 'The server had an error' },
            },
          },
        ],
      ]),
    );
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponsesApiError);
    expect((err as ResponsesApiError).code).toBe('server_error');
    expect((err as Error).message).toBe(
      'Codex Responses API response failed (server_error): The server had an error',
    );
  });

  it('carries context_length_exceeded as the error code, so overflow compaction can act', async () => {
    stubFetch(
      sse([
        [
          'response.failed',
          {
            response: {
              error: { code: 'context_length_exceeded', message: 'Your input exceeds the window' },
            },
          },
        ],
      ]),
    );
    const err = await run().catch((e: unknown) => e);
    expect((err as ResponsesApiError).code).toBe('context_length_exceeded');
  });

  it('throws on a lone error event', async () => {
    stubFetch(
      sse([['error', { type: 'error', code: 'rate_limit_exceeded', message: 'Slow down' }]]),
    );
    await expect(run()).rejects.toThrow(
      'Codex Responses API stream error (rate_limit_exceeded): Slow down',
    );
  });

  it('maps response.incomplete(max_output_tokens) to usage and a max_tokens done', async () => {
    stubFetch(
      sse([
        ['response.output_text.delta', { delta: 'partial ans' }],
        [
          'response.incomplete',
          {
            response: {
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              usage: USAGE,
            },
          },
        ],
      ]),
    );
    const chunks = await run();
    expect(chunks.map((c) => c.type)).toEqual(['text_delta', 'usage', 'done']);
    expect(chunks.at(-1)).toEqual({ type: 'done', finishReason: 'max_tokens' });
  });

  it('throws on response.incomplete(content_filter) rather than delivering it', async () => {
    stubFetch(
      sse([
        ['response.output_text.delta', { delta: 'partial' }],
        ['response.incomplete', { response: { incomplete_details: { reason: 'content_filter' } } }],
      ]),
    );
    const err = await run().catch((e: unknown) => e);
    expect((err as ResponsesApiError).code).toBe('content_filter');
    expect((err as Error).message).toContain('response incomplete (content_filter)');
  });

  it('throws on a stream cut short with no terminal event', async () => {
    stubFetch(sse([['response.output_text.delta', { delta: 'partial ans' }]]));
    await expect(run()).rejects.toThrow(/ended without response.completed/);
  });
});

describe('Responses API transient retry (UBP-030)', () => {
  const COMPLETED = (): Response =>
    sse([
      ['response.output_text.delta', { delta: 'hi' }],
      ['response.completed', { response: { usage: USAGE } }],
    ]);

  it('retries a 429 honouring retry-after, then streams', async () => {
    const sleeps: number[] = [];
    const fn = stubFetch(
      new Response('slow', { status: 429, headers: { 'retry-after': '1' } }),
      COMPLETED(),
    );
    const chunks = await run({
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'hi' });
  });

  it('caps a long retry-after at 10s', async () => {
    const sleeps: number[] = [];
    stubFetch(new Response('', { status: 503, headers: { 'retry-after': '120' } }), COMPLETED());
    await run({
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([10_000]);
  });

  it('retries a network error, then streams', async () => {
    const fn = stubFetch(new TypeError('fetch failed'), COMPLETED());
    const chunks = await run({ sleep: async () => undefined });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });

  it('never retries a 400', async () => {
    const fn = stubFetch(new Response('bad', { status: 400 }));
    await expect(run({ sleep: async () => undefined })).rejects.toThrow(/error 400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never retries an abort', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const fn = stubFetch(abort);
    await expect(run({ sleep: async () => undefined })).rejects.toBe(abort);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
