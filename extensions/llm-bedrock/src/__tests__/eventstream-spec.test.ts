// Spec verification (2026-09-28, no live Bedrock test by owner decision).
//
// 1. The framing vectors below are the AWS event-stream codec's published test
//    vectors, copied byte-for-byte from smithy-typescript
//    packages/core/src/submodules/event-streams/eventstream-codec/TestVectors.fixture.ts
//    (main @ 24e39fa5, Apache-2.0). The decoded values are the reference
//    decoder's (`HeaderMarshaller.parse` in the same directory): a timestamp
//    header decodes to a `Date`, a uuid header to its 8-4-4-4-12 hex string.
// 2. The ConverseStream cases follow the Bedrock Runtime API reference
//    (API_runtime_ConverseStream, MessageStopEvent, TokenUsage,
//    ContentBlockDelta, ReasoningContentBlockDelta) as published on
//    docs.aws.amazon.com on 2026-09-28.

import type { CompletionChunk } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { EventStreamDecoder, EventStreamFramingError } from '../eventstream';
import { BedrockStreamError, parseBedrockEventStream } from '../transport';
import { concat, event, exception, frame, streamOf } from './eventstream-fixtures';

const FOO_BAR_BODY = Uint8Array.from([123, 39, 102, 111, 111, 39, 58, 39, 98, 97, 114, 39, 125]);

// biome-ignore format: byte vectors are kept in the reference's layout
const ALL_HEADERS = Uint8Array.from([
  0, 0, 0, 204, 0, 0, 0, 175, 15, 174, 100, 202, 10, 101, 118, 101, 110, 116, 45, 116, 121, 112, 101, 4, 0, 0, 160,
  12, 12, 99, 111, 110, 116, 101, 110, 116, 45, 116, 121, 112, 101, 7, 0, 16, 97, 112, 112, 108, 105, 99, 97, 116,
  105, 111, 110, 47, 106, 115, 111, 110, 10, 98, 111, 111, 108, 32, 102, 97, 108, 115, 101, 1, 9, 98, 111, 111, 108,
  32, 116, 114, 117, 101, 0, 4, 98, 121, 116, 101, 2, 207, 8, 98, 121, 116, 101, 32, 98, 117, 102, 6, 0, 20, 73, 39,
  109, 32, 97, 32, 108, 105, 116, 116, 108, 101, 32, 116, 101, 97, 112, 111, 116, 33, 9, 116, 105, 109, 101, 115,
  116, 97, 109, 112, 8, 0, 0, 0, 0, 0, 132, 95, 237, 5, 105, 110, 116, 49, 54, 3, 0, 42, 5, 105, 110, 116, 54, 52,
  5, 0, 0, 0, 0, 2, 135, 87, 178, 4, 117, 117, 105, 100, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  123, 39, 102, 111, 111, 39, 58, 39, 98, 97, 114, 39, 125, 171, 165, 241, 12,
]);

const EMPTY_MESSAGE = Uint8Array.from([
  0, 0, 0, 16, 0, 0, 0, 0, 5, 194, 72, 235, 125, 152, 200, 255,
]);

// biome-ignore format: byte vectors are kept in the reference's layout
const INT32_HEADER = Uint8Array.from([
  0, 0, 0, 45, 0, 0, 0, 16, 65, 196, 36, 184, 10, 101, 118, 101, 110, 116, 45, 116, 121, 112, 101, 4, 0, 0, 160, 12,
  123, 39, 102, 111, 111, 39, 58, 39, 98, 97, 114, 39, 125, 54, 244, 128, 160,
]);

// biome-ignore format: byte vectors are kept in the reference's layout
const PAYLOAD_NO_HEADERS = Uint8Array.from([
  0, 0, 0, 29, 0, 0, 0, 0, 253, 82, 140, 90, 123, 39, 102, 111, 111, 39, 58, 39, 98, 97, 114, 39, 125, 195, 101, 57,
  54,
]);

// biome-ignore format: byte vectors are kept in the reference's layout
const PAYLOAD_ONE_STR_HEADER = Uint8Array.from([
  0, 0, 0, 61, 0, 0, 0, 32, 7, 253, 131, 150, 12, 99, 111, 110, 116, 101, 110, 116, 45, 116, 121, 112, 101, 7, 0,
  16, 97, 112, 112, 108, 105, 99, 97, 116, 105, 111, 110, 47, 106, 115, 111, 110, 123, 39, 102, 111, 111, 39, 58,
  39, 98, 97, 114, 39, 125, 141, 156, 8, 177,
]);

// biome-ignore format: byte vectors are kept in the reference's layout
const CORRUPTED_HEADERS = Uint8Array.from([
  0, 0, 0, 61, 0, 0, 0, 32, 7, 253, 131, 150, 12, 99, 111, 110, 116, 101, 110, 116, 45, 116, 121, 112, 101, 7, 0,
  16, 97, 112, 112, 108, 105, 99, 97, 116, 105, 111, 110, 47, 106, 115, 111, 110, 123, 97, 102, 111, 111, 39, 58,
  39, 98, 97, 114, 39, 125, 141, 156, 8, 177,
]);

// biome-ignore format: byte vectors are kept in the reference's layout
const CORRUPTED_HEADER_LEN = Uint8Array.from([
  0, 0, 0, 61, 0, 0, 0, 33, 7, 253, 131, 150, 12, 99, 111, 110, 116, 101, 110, 116, 45, 116, 121, 112, 101, 7, 0,
  16, 97, 112, 112, 108, 105, 99, 97, 116, 105, 111, 110, 47, 106, 115, 111, 110, 123, 39, 102, 111, 111, 39, 58,
  39, 98, 97, 114, 39, 125, 141, 156, 8, 177,
]);

// biome-ignore format: byte vectors are kept in the reference's layout
const CORRUPTED_LENGTH = Uint8Array.from([
  0, 0, 0, 62, 0, 0, 0, 32, 7, 253, 131, 150, 12, 99, 111, 110, 116, 101, 110, 116, 45, 116, 121, 112, 101, 7, 0,
  16, 97, 112, 112, 108, 105, 99, 97, 116, 105, 111, 110, 47, 106, 115, 111, 110, 123, 39, 102, 111, 111, 39, 58,
  39, 98, 97, 114, 39, 125, 141, 156, 8, 177,
]);

// biome-ignore format: byte vectors are kept in the reference's layout
const CORRUPTED_PAYLOAD = Uint8Array.from([
  0, 0, 0, 29, 0, 0, 0, 0, 253, 82, 140, 90, 91, 39, 102, 111, 111, 39, 58, 39, 98, 97, 114, 39, 125, 195, 101, 57,
  54,
]);

function decodeOne(bytes: Uint8Array) {
  const decoder = new EventStreamDecoder();
  const messages = decoder.push(bytes);
  expect(messages).toHaveLength(1);
  expect(decoder.pendingBytes).toBe(0);
  const [message] = messages;
  if (!message) throw new Error('unreachable');
  return message;
}

describe('EventStreamDecoder — smithy-typescript reference test vectors', () => {
  it('all_headers: every header value type 0–9 decodes to the reference value', () => {
    const message = decodeOne(ALL_HEADERS);
    expect(message.headers).toEqual({
      'event-type': 40972,
      'content-type': 'application/json',
      'bool false': false,
      'bool true': true,
      byte: -49,
      'byte buf': new TextEncoder().encode("I'm a little teapot!"),
      timestamp: new Date(8675309),
      int16: 42,
      int64: 42424242n,
      uuid: '01020304-0506-0708-090a-0b0c0d0e0f10',
    });
    expect(message.payload).toEqual(FOO_BAR_BODY);
  });

  it('empty_message: no headers, no body', () => {
    const message = decodeOne(EMPTY_MESSAGE);
    expect(message.headers).toEqual({});
    expect(message.payload).toEqual(new Uint8Array(0));
  });

  it('int32_header', () => {
    const message = decodeOne(INT32_HEADER);
    expect(message.headers).toEqual({ 'event-type': 40972 });
    expect(message.payload).toEqual(FOO_BAR_BODY);
  });

  it('payload_no_headers', () => {
    const message = decodeOne(PAYLOAD_NO_HEADERS);
    expect(message.headers).toEqual({});
    expect(message.payload).toEqual(FOO_BAR_BODY);
  });

  it('payload_one_str_header', () => {
    const message = decodeOne(PAYLOAD_ONE_STR_HEADER);
    expect(message.headers).toEqual({ 'content-type': 'application/json' });
    expect(message.payload).toEqual(FOO_BAR_BODY);
  });

  it('the reference vectors also decode back-to-back in one byte-at-a-time stream', () => {
    const decoder = new EventStreamDecoder();
    const all = concat([EMPTY_MESSAGE, INT32_HEADER, ALL_HEADERS, PAYLOAD_ONE_STR_HEADER]);
    const out = [];
    for (const byte of all) out.push(...decoder.push(Uint8Array.of(byte)));
    expect(out).toHaveLength(4);
    expect(out[2]?.headers.uuid).toBe('01020304-0506-0708-090a-0b0c0d0e0f10');
  });

  it.each([
    ['corrupted_headers', CORRUPTED_HEADERS],
    ['corrupted_header_len', CORRUPTED_HEADER_LEN],
    ['corrupted_length', CORRUPTED_LENGTH],
    ['corrupted_payload', CORRUPTED_PAYLOAD],
  ])('%s: refused, as the reference decoder refuses it', (_name, bytes) => {
    expect(() => new EventStreamDecoder().push(bytes)).toThrow(EventStreamFramingError);
  });
});

async function drain(iter: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const MODEL = 'us.anthropic.claude-sonnet-4-5';

function run(frames: Uint8Array[]) {
  return drain(parseBedrockEventStream(streamOf(concat(frames), 11), MODEL));
}

describe('parseBedrockEventStream — ConverseStream API reference shapes', () => {
  it('maps reasoningContent text deltas to thinking and ignores signature / redactedContent deltas', async () => {
    const chunks = await run([
      event('messageStart', { role: 'assistant' }),
      event('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { reasoningContent: { text: 'Thinking it through.' } },
      }),
      event('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { reasoningContent: { signature: 'EqQBCkYIARgCIkD...' } },
      }),
      event('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { reasoningContent: { redactedContent: 'ZW5jcnlwdGVk' } },
      }),
      event('contentBlockStop', { contentBlockIndex: 0 }),
      event('contentBlockDelta', { contentBlockIndex: 1, delta: { text: 'Answer.' } }),
      event('contentBlockStop', { contentBlockIndex: 1 }),
      event('messageStop', { stopReason: 'end_turn' }),
    ]);
    expect(chunks).toEqual([
      { type: 'thinking_delta', thinking: 'Thinking it through.' },
      { type: 'text_delta', text: 'Answer.' },
      { type: 'done', finishReason: 'end_turn' },
    ]);
  });

  it.each([
    ['end_turn', 'end_turn'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    ['stop_sequence', 'stop_sequence'],
    ['guardrail_intervened', 'end_turn'],
    ['content_filtered', 'end_turn'],
    ['malformed_model_output', 'end_turn'],
    ['malformed_tool_use', 'end_turn'],
    // The context window cut the output off: same consequence as the output
    // cap, so the loop's max_tokens handling (continuation, cut-off tool-call
    // rejection) applies.
    ['model_context_window_exceeded', 'max_tokens'],
  ])('maps documented stopReason %s to finishReason %s', async (stopReason, finishReason) => {
    const chunks = await run([
      event('messageStart', { role: 'assistant' }),
      event('messageStop', { stopReason }),
    ]);
    expect(chunks).toEqual([{ type: 'done', finishReason }]);
  });

  it('reads cacheReadInputTokens / cacheWriteInputTokens from metadata.usage', async () => {
    const chunks = await run([
      event('messageStart', { role: 'assistant' }),
      event('messageStop', { stopReason: 'end_turn' }),
      event('metadata', {
        usage: {
          inputTokens: 22,
          outputTokens: 40,
          totalTokens: 1790,
          cacheReadInputTokens: 1528,
          cacheWriteInputTokens: 200,
          cacheDetails: [{ inputTokens: 200, ttl: '5m' }],
        },
        metrics: { latencyMs: 450 },
      }),
    ]);
    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage?.type === 'usage' ? usage.usage : undefined).toMatchObject({
      inputTokens: 22,
      outputTokens: 40,
      cacheReadTokens: 1528,
      cacheCreationTokens: 200,
    });
  });

  it.each([
    ['internalServerException', 500],
    ['modelStreamErrorException', 424],
    ['validationException', 400],
    ['throttlingException', 429],
    ['serviceUnavailableException', 503],
  ])(
    'throws %s as a BedrockStreamError with its documented HTTP status %d',
    async (type, status) => {
      const err = await run([
        event('messageStart', { role: 'assistant' }),
        exception(type, 'boom'),
      ]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BedrockStreamError);
      expect(err).toMatchObject({ code: type, status });
    },
  );

  it('throws an `error` message using its :error-code and :error-message headers', async () => {
    const err = await run([
      frame(
        [
          [':message-type', 'error'],
          [':error-code', 'InternalFailure'],
          [':error-message', 'something broke'],
        ],
        new Uint8Array(0),
      ),
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BedrockStreamError);
    expect(err).toMatchObject({ code: 'InternalFailure' });
    expect(String(err)).toContain('something broke');
  });
});
