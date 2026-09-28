// UBP-005 — ConverseStream decoding, driven by correctly framed binary AWS
// event-stream bodies (./eventstream-fixtures). UBP-030 — the pre-first-byte
// transient retry around the request.
//
// The fixtures are synthetic: built to the AWS event-stream spec and the
// ConverseStream event shapes, not captured from a live Bedrock response.

import type { CompletionChunk } from '@ethosagent/types';
import { validateToolCallBuffering } from '@ethosagent/wiring/conformance';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32, EventStreamDecoder, EventStreamFramingError } from '../eventstream';
import { BedrockProvider } from '../provider';
import { staticCredentials } from '../sigv4';
import { BedrockStreamError, streamBedrockConverse } from '../transport';
import {
  concat,
  event,
  exception,
  MINIMAL_FRAMES,
  streamOf,
  TEXT_AND_TOOL_FRAMES,
} from './eventstream-fixtures';

const CONFIG = {
  region: 'us-east-1',
  modelId: 'us.anthropic.claude-sonnet-4-5',
  sigv4: { region: 'us-east-1', credentials: staticCredentials('AKID', 'secret') },
};

function eventStreamResponse(frames: Uint8Array[], chunkSize?: number): Response {
  return new Response(streamOf(concat(frames), chunkSize), {
    status: 200,
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  });
}

async function drain(iter: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
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

const noSleep = { sleep: async () => undefined };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('crc32', () => {
  it('matches the IEEE check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('EventStreamDecoder', () => {
  it('decodes frames split across arbitrary chunk boundaries', () => {
    const bytes = concat(MINIMAL_FRAMES);
    const decoder = new EventStreamDecoder();
    const messages = [];
    for (let i = 0; i < bytes.byteLength; i += 3) {
      messages.push(...decoder.push(bytes.subarray(i, i + 3)));
    }
    expect(messages.map((m) => m.headers[':event-type'])).toEqual([
      'messageStart',
      'messageStop',
      'metadata',
    ]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('refuses a frame whose message CRC does not match', () => {
    const bad = event('messageStop', { stopReason: 'end_turn' });
    const last = bad.byteLength - 1;
    bad[last] = (bad[last] ?? 0) ^ 0xff;
    expect(() => new EventStreamDecoder().push(bad)).toThrow(EventStreamFramingError);
  });

  it('refuses a frame whose prelude CRC does not match', () => {
    const bad = event('messageStop', { stopReason: 'end_turn' });
    bad[9] = (bad[9] ?? 0) ^ 0xff;
    expect(() => new EventStreamDecoder().push(bad)).toThrow(/prelude CRC/);
  });
});

describe('streamBedrockConverse — recorded-shape fixtures', () => {
  it('maps text + one toolUse to text, a real-id tool call, done and usage', async () => {
    stubFetch(eventStreamResponse(TEXT_AND_TOOL_FRAMES));
    const chunks = await drain(streamBedrockConverse(CONFIG, [], [], {}));

    expect(chunks.map((c) => c.type)).toEqual([
      'text_delta',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_delta',
      'tool_use_end',
      'done',
      'usage',
    ]);
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'Let me check.' });
    expect(chunks[1]).toEqual({
      type: 'tool_use_start',
      toolCallId: 'tooluse_abc123',
      toolName: 'read_file',
    });
    for (const c of chunks) {
      if (c.type === 'tool_use_delta') expect(c.toolCallId).toBe('tooluse_abc123');
    }
    expect(chunks[4]).toEqual({
      type: 'tool_use_end',
      toolCallId: 'tooluse_abc123',
      inputJson: '{"path":"a.txt"}',
    });
    expect(chunks[5]).toEqual({ type: 'done', finishReason: 'tool_use' });
    const usage = chunks[6];
    expect(usage?.type === 'usage' && usage.usage.inputTokens).toBe(120);
    expect(usage?.type === 'usage' && usage.usage.outputTokens).toBe(30);
    expect(validateToolCallBuffering(chunks).passed).toBe(true);
  });

  it('keeps two parallel tool calls apart by contentBlockIndex', async () => {
    stubFetch(
      eventStreamResponse([
        event('messageStart', { role: 'assistant' }),
        event('contentBlockStart', {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 'tooluse_1', name: 'read_file' } },
        }),
        event('contentBlockStart', {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: 'tooluse_2', name: 'write_file' } },
        }),
        event('contentBlockDelta', {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"path":"b","content":"x"}' } },
        }),
        event('contentBlockDelta', {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"path":"a"}' } },
        }),
        event('contentBlockStop', { contentBlockIndex: 0 }),
        event('contentBlockStop', { contentBlockIndex: 1 }),
        event('messageStop', { stopReason: 'tool_use' }),
      ]),
    );
    const chunks = await drain(streamBedrockConverse(CONFIG, [], [], {}));
    const ends = chunks.filter((c) => c.type === 'tool_use_end');
    expect(ends).toEqual([
      { type: 'tool_use_end', toolCallId: 'tooluse_1', inputJson: '{"path":"a"}' },
      { type: 'tool_use_end', toolCallId: 'tooluse_2', inputJson: '{"path":"b","content":"x"}' },
    ]);
    expect(validateToolCallBuffering(chunks).passed).toBe(true);
  });

  it('maps max_tokens and stop_sequence stop reasons', async () => {
    for (const stopReason of ['max_tokens', 'stop_sequence'] as const) {
      stubFetch(eventStreamResponse([event('messageStop', { stopReason })]));
      const chunks = await drain(streamBedrockConverse(CONFIG, [], [], {}));
      expect(chunks).toEqual([{ type: 'done', finishReason: stopReason }]);
    }
  });

  it('throws on a stream that ends without messageStop', async () => {
    stubFetch(eventStreamResponse([event('messageStart', { role: 'assistant' })]));
    await expect(drain(streamBedrockConverse(CONFIG, [], [], {}))).rejects.toThrow(
      /ended without messageStop/,
    );
  });

  it('throws on an empty body', async () => {
    stubFetch(new Response(new Uint8Array(), { status: 200 }));
    await expect(drain(streamBedrockConverse(CONFIG, [], [], {}))).rejects.toThrow(
      BedrockStreamError,
    );
  });

  it('throws on a throttlingException frame, carrying status 429 for failover', async () => {
    stubFetch(
      eventStreamResponse([
        event('messageStart', { role: 'assistant' }),
        exception('throttlingException', 'Too many requests, please wait'),
      ]),
    );
    const err = await drain(streamBedrockConverse(CONFIG, [], [], {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BedrockStreamError);
    expect((err as BedrockStreamError).status).toBe(429);
    expect((err as BedrockStreamError).code).toBe('throttlingException');
    expect((err as Error).message).toContain('Too many requests, please wait');
  });

  it('throws on a modelStreamErrorException frame', async () => {
    stubFetch(
      eventStreamResponse([
        event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'par' } }),
        exception('modelStreamErrorException', 'model stream failed'),
      ]),
    );
    await expect(drain(streamBedrockConverse(CONFIG, [], [], {}))).rejects.toThrow(
      /modelStreamErrorException.*model stream failed/,
    );
  });

  it('refuses a tool call still streaming at messageStop', async () => {
    stubFetch(
      eventStreamResponse([
        event('contentBlockStart', {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 'tooluse_1', name: 'write_file' } },
        }),
        event('contentBlockDelta', {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"path":' } },
        }),
        event('messageStop', { stopReason: 'max_tokens' }),
      ]),
    );
    await expect(drain(streamBedrockConverse(CONFIG, [], [], {}))).rejects.toThrow(
      /truncated tool call/,
    );
  });
});

describe('streamBedrockConverse — transient retry (UBP-030)', () => {
  it('retries a 429 honouring retry-after, then streams', async () => {
    const sleeps: number[] = [];
    const fetchMock = stubFetch(
      new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      eventStreamResponse(MINIMAL_FRAMES),
    );
    const chunks = await drain(
      streamBedrockConverse(
        {
          ...CONFIG,
          retry: {
            sleep: async (ms: number) => {
              sleeps.push(ms);
            },
          },
        },
        [],
        [],
        {},
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
  });

  it('retries a network error and a 503 at most twice', async () => {
    const fetchMock = stubFetch(
      new TypeError('fetch failed'),
      new Response('', { status: 503 }),
      new Response('', { status: 503 }),
    );
    await expect(
      drain(streamBedrockConverse({ ...CONFIG, retry: noSleep }, [], [], {})),
    ).rejects.toThrow(/Bedrock API error 503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries a 400', async () => {
    const fetchMock = stubFetch(new Response('bad request', { status: 400 }));
    await expect(
      drain(streamBedrockConverse({ ...CONFIG, retry: noSleep }, [], [], {})),
    ).rejects.toThrow(/Bedrock API error 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry at all with maxRetries: 0 (a chain hop)', async () => {
    const fetchMock = stubFetch(new Response('', { status: 429 }));
    const provider = new BedrockProvider({ ...CONFIG, maxRetries: 0 });
    await expect(drain(provider.complete([], [], {}))).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
