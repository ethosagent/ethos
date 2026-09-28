// gemini-native transport, driven by recorded-shape SSE bodies (synthetic —
// built to the streamGenerateContent?alt=sse event shape, not captured live).
//
//   UBP-031 — one tool-call id per functionCall part, unique across requests;
//             functionResponse.name is the function's name.
//   UBP-032 — a thoughtSignature on a functionCall part is replayed byte for
//             byte on the next request (D5: provider-held map, no contract change).
//   UBP-030 — pre-first-byte transient retry.

import type { CompletionChunk, Message } from '@ethosagent/types';
import { validateToolCallBuffering } from '@ethosagent/wiring/conformance';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiNativeProvider } from '../index';
import { buildGeminiBody, createGeminiStreamState, streamGeminiGenerate } from '../transport';

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(iter: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const TWO_CALLS_ONE_EVENT = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'read_file', args: { path: 'a' } },
            thoughtSignature: 'c2lnLUFCQw==',
          },
          { functionCall: { name: 'write_file', args: { path: 'b', content: 'x' } } },
        ],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
};

/** Captures every request body; answers each call with the next queued response. */
function stubFetch(...responses: Response[]): { bodies: unknown[]; fn: ReturnType<typeof vi.fn> } {
  const bodies: unknown[] = [];
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next;
  });
  vi.stubGlobal('fetch', fn);
  return { bodies, fn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gemini-native tool-call ids (UBP-031)', () => {
  it('gives each functionCall part in one event its own id and its own args', async () => {
    stubFetch(sse([TWO_CALLS_ONE_EVENT]));
    const chunks = await drain(
      streamGeminiGenerate({ apiKey: 'k', model: 'gemini-3-pro-preview' }, [], [], {}),
    );
    const starts = chunks.filter((c) => c.type === 'tool_use_start');
    const ends = chunks.filter((c) => c.type === 'tool_use_end');
    expect(starts).toHaveLength(2);
    const [first, second] = starts;
    expect(first?.toolCallId).not.toBe(second?.toolCallId);
    expect(ends.map((e) => e.type === 'tool_use_end' && [e.toolCallId, e.inputJson])).toEqual([
      [first?.toolCallId, '{"path":"a"}'],
      [second?.toolCallId, '{"path":"b","content":"x"}'],
    ]);
    expect(validateToolCallBuffering(chunks).passed).toBe(true);
    // A STOP that carried calls is a tool_use stop.
    expect(chunks.find((c) => c.type === 'done')).toEqual({
      type: 'done',
      finishReason: 'tool_use',
    });
  });

  it('never repeats an id across complete() calls on one provider', async () => {
    stubFetch(sse([TWO_CALLS_ONE_EVENT]), sse([TWO_CALLS_ONE_EVENT]));
    const provider = new GeminiNativeProvider({ apiKey: 'k', model: 'gemini-3-pro-preview' });
    const ids = new Set<string>();
    let count = 0;
    for (let turn = 0; turn < 2; turn++) {
      for (const c of await drain(provider.complete([], [], {}))) {
        if (c.type === 'tool_use_start') {
          ids.add(c.toolCallId);
          count++;
        }
      }
    }
    expect(count).toBe(4);
    expect(ids.size).toBe(4);
  });

  it('sends functionResponse.name as the function name, not the call id', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'gemini-x-0', name: 'read_file', input: { path: 'a' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'gemini-x-0', content: 'file body' }],
      },
    ];
    const body = buildGeminiBody(history, [], {}) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[2]?.parts[0]).toEqual({
      functionResponse: { name: 'read_file', response: { result: 'file body' } },
    });
  });
});

describe('gemini-native thought signatures (UBP-032)', () => {
  it('replays a turn-1 functionCall signature byte for byte on the turn-2 request', async () => {
    const { bodies } = stubFetch(
      sse([TWO_CALLS_ONE_EVENT]),
      sse([{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }]),
    );
    const provider = new GeminiNativeProvider({ apiKey: 'k', model: 'gemini-3-pro-preview' });
    const turn1 = await drain(provider.complete([{ role: 'user', content: 'go' }], [], {}));
    const calls = turn1.flatMap((c) =>
      c.type === 'tool_use_end' ? [{ id: c.toolCallId, input: JSON.parse(c.inputJson) }] : [],
    );
    const names = ['read_file', 'write_file'];

    // What the loop persists and sends back: the assistant tool_use blocks and
    // the user tool_result blocks answering them.
    const history: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: calls.map((c, i) => ({
          type: 'tool_use' as const,
          id: c.id,
          name: names[i] ?? '',
          input: c.input,
        })),
      },
      {
        role: 'user',
        content: calls.map((c) => ({
          type: 'tool_result' as const,
          tool_use_id: c.id,
          content: 'ok',
        })),
      },
    ];
    await drain(provider.complete(history, [], {}));

    const turn2 = bodies[1] as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(turn2.contents[1]?.parts).toEqual([
      {
        functionCall: { name: 'read_file', args: { path: 'a' } },
        thoughtSignature: 'c2lnLUFCQw==',
      },
      // Only the part Gemini signed carries one.
      { functionCall: { name: 'write_file', args: { path: 'b', content: 'x' } } },
    ]);
  });

  it('sends no thoughtSignature for a call the provider never saw signed', () => {
    const body = buildGeminiBody(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'other-1', name: 'read_file', input: {} }],
        },
      ],
      [],
      {},
      createGeminiStreamState(),
    );
    expect(JSON.stringify(body)).not.toContain('thoughtSignature');
  });
});

describe('gemini-native transient retry (UBP-030)', () => {
  const retryConfig = (sleeps: number[]) => ({
    apiKey: 'k',
    model: 'gemini-2.5-flash',
    retry: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  });

  it('retries a 429 honouring retry-after, then streams', async () => {
    const sleeps: number[] = [];
    const { fn } = stubFetch(
      new Response('quota', { status: 429, headers: { 'retry-after': '1' } }),
      sse([{ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }]),
    );
    const chunks = await drain(streamGeminiGenerate(retryConfig(sleeps), [], [], {}));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'hi' });
  });

  it('gives up after two retries of a 503', async () => {
    const sleeps: number[] = [];
    const { fn } = stubFetch(
      new Response('', { status: 503 }),
      new Response('', { status: 503 }),
      new Response('', { status: 503 }),
    );
    await expect(drain(streamGeminiGenerate(retryConfig(sleeps), [], [], {}))).rejects.toThrow(
      /Gemini API error 503/,
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it('never retries a 400', async () => {
    const sleeps: number[] = [];
    const { fn } = stubFetch(new Response('bad', { status: 400 }));
    await expect(drain(streamGeminiGenerate(retryConfig(sleeps), [], [], {}))).rejects.toThrow(
      /Gemini API error 400/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry with maxRetries: 0 (a chain hop)', async () => {
    const { fn } = stubFetch(new Response('', { status: 429 }));
    const provider = new GeminiNativeProvider({ apiKey: 'k', model: 'm', maxRetries: 0 });
    await expect(drain(provider.complete([], [], {}))).rejects.toThrow(/429/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
