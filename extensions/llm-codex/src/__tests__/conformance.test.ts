import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { CodexProvider } from '../index';

const CANONICAL_TYPES = new Set<CompletionChunk['type']>([
  'text_delta',
  'thinking_delta',
  'tool_use_start',
  'tool_use_delta',
  'tool_use_end',
  'usage',
  'done',
]);

/**
 * Build a ReadableStream that emits SSE-formatted events.
 * Each entry is [eventType, dataObject].
 */
function makeSSEStream(events: Array<[string, unknown]>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`)
    .join('\n');

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

function makeMockFetch(events: Array<[string, unknown]>): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    body: makeSSEStream(events),
    text: () => Promise.resolve(''),
    status: 200,
    statusText: 'OK',
  });
}

function _createProvider(_mockFetch: typeof fetch): CodexProvider {
  // Inject the mock fetch via getAccessToken (the provider uses global fetch for the API call,
  // so we need to mock globalThis.fetch).
  return new CodexProvider({
    model: 'gpt-5.4-mini',
    getAccessToken: async () => 'mock-token',
  });
}

async function collect(provider: LLMProvider): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const c of provider.complete([], [], {})) chunks.push(c);
  return chunks;
}

describe('CodexProvider conformance', () => {
  it('only yields canonical CompletionChunk types', async () => {
    const events: Array<[string, unknown]> = [
      ['response.output_text.delta', { delta: 'hello ' }],
      ['response.output_text.delta', { delta: 'world' }],
      [
        'response.output_item.added',
        { item: { type: 'function_call', id: 'call_1', name: 'echo' } },
      ],
      ['response.function_call_arguments.delta', { delta: '{"x":' }],
      ['response.function_call_arguments.delta', { delta: '1}' }],
      [
        'response.output_item.done',
        { item: { type: 'function_call', id: 'call_1', arguments: '{"x":1}' } },
      ],
      ['response.completed', { response: { usage: { input_tokens: 10, output_tokens: 5 } } }],
    ];

    const mockFetch = makeMockFetch(events);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const provider = new CodexProvider({
        model: 'gpt-5.4-mini',
        getAccessToken: async () => 'mock-token',
      });
      const chunks = await collect(provider);

      for (const c of chunks) {
        expect(CANONICAL_TYPES.has(c.type)).toBe(true);
      }
      expect(chunks.find((c) => c.type === 'text_delta')).toBeDefined();
      expect(chunks.find((c) => c.type === 'tool_use_start')).toBeDefined();
      expect(chunks.find((c) => c.type === 'tool_use_delta')).toBeDefined();
      expect(chunks.find((c) => c.type === 'tool_use_end')).toBeDefined();
      expect(chunks.find((c) => c.type === 'usage')).toBeDefined();
      expect(chunks.find((c) => c.type === 'done')).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits tool_use_start with correct id and name', async () => {
    const events: Array<[string, unknown]> = [
      [
        'response.output_item.added',
        { item: { type: 'function_call', id: 'call_X', name: 'lookup' } },
      ],
      ['response.function_call_arguments.delta', { delta: '{"q":' }],
      ['response.function_call_arguments.delta', { delta: '"hi"}' }],
      [
        'response.output_item.done',
        { item: { type: 'function_call', id: 'call_X', arguments: '{"q":"hi"}' } },
      ],
      ['response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } }],
    ];

    const mockFetch = makeMockFetch(events);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const provider = new CodexProvider({
        model: 'gpt-5.4-mini',
        getAccessToken: async () => 'mock-token',
      });
      const chunks = await collect(provider);

      const start = chunks.find((c) => c.type === 'tool_use_start') as Extract<
        CompletionChunk,
        { type: 'tool_use_start' }
      >;
      expect(start).toBeDefined();
      expect(start.toolName).toBe('lookup');
      expect(start.toolCallId).toBe('call_X');

      const deltas = chunks.filter((c) => c.type === 'tool_use_delta');
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      const concatenated = deltas
        .map((d) => (d as Extract<CompletionChunk, { type: 'tool_use_delta' }>).partialJson)
        .join('');
      expect(concatenated).toBe('{"q":"hi"}');

      const end = chunks.find((c) => c.type === 'tool_use_end') as Extract<
        CompletionChunk,
        { type: 'tool_use_end' }
      >;
      expect(end).toBeDefined();
      expect(end.inputJson).toBe('{"q":"hi"}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits usage with cacheReadTokens=0 and cacheCreationTokens=0', async () => {
    const events: Array<[string, unknown]> = [
      ['response.output_text.delta', { delta: 'ok' }],
      ['response.completed', { response: { usage: { input_tokens: 7, output_tokens: 3 } } }],
    ];

    const mockFetch = makeMockFetch(events);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const provider = new CodexProvider({
        model: 'gpt-5.4-mini',
        getAccessToken: async () => 'mock-token',
      });
      const chunks = await collect(provider);

      const usage = chunks.find((c) => c.type === 'usage') as Extract<
        CompletionChunk,
        { type: 'usage' }
      >;
      expect(usage).toBeDefined();
      expect(usage.usage.cacheReadTokens).toBe(0);
      expect(usage.usage.cacheCreationTokens).toBe(0);
      expect(usage.usage.inputTokens).toBe(7);
      expect(usage.usage.outputTokens).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits done with finishReason end_turn for text-only response', async () => {
    const events: Array<[string, unknown]> = [
      ['response.output_text.delta', { delta: 'fin.' }],
      ['response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } }],
    ];

    const mockFetch = makeMockFetch(events);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const provider = new CodexProvider({
        model: 'gpt-5.4-mini',
        getAccessToken: async () => 'mock-token',
      });
      const chunks = await collect(provider);
      const done = chunks.find((c) => c.type === 'done') as Extract<
        CompletionChunk,
        { type: 'done' }
      >;
      expect(done).toBeDefined();
      expect(done.finishReason).toBe('end_turn');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits done with finishReason tool_use when tool calls are present', async () => {
    const events: Array<[string, unknown]> = [
      ['response.output_item.added', { item: { type: 'function_call', id: 'c1', name: 'foo' } }],
      ['response.function_call_arguments.delta', { delta: '{}' }],
      ['response.output_item.done', { item: { type: 'function_call', id: 'c1', arguments: '{}' } }],
      ['response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } }],
    ];

    const mockFetch = makeMockFetch(events);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const provider = new CodexProvider({
        model: 'gpt-5.4-mini',
        getAccessToken: async () => 'mock-token',
      });
      const chunks = await collect(provider);
      const done = chunks.find((c) => c.type === 'done') as Extract<
        CompletionChunk,
        { type: 'done' }
      >;
      expect(done).toBeDefined();
      expect(done.finishReason).toBe('tool_use');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
