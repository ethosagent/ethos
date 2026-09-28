// Builds correctly framed AWS event-stream bodies (prelude + headers + payload
// + both CRC32s) in the shape Bedrock ConverseStream sends: the event type in
// the `:event-type` header, the event object as a bare JSON payload.
//
// The CRC here is written independently of ../eventstream's `crc32`, so a
// wrong table or seed in the decoder cannot also make every fixture agree.

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type Header = [name: string, value: string];

function encodeHeaders(headers: Header[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: number[] = [];
  for (const [name, value] of headers) {
    const n = encoder.encode(name);
    const v = encoder.encode(value);
    parts.push(n.byteLength, ...n, 7, (v.byteLength >> 8) & 0xff, v.byteLength & 0xff, ...v);
  }
  return new Uint8Array(parts);
}

export function frame(headers: Header[], payload: unknown): Uint8Array {
  const headerBytes = encodeHeaders(headers);
  const payloadBytes =
    payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload));
  const total = 12 + headerBytes.byteLength + payloadBytes.byteLength + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.byteLength);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  out.set(headerBytes, 12);
  out.set(payloadBytes, 12 + headerBytes.byteLength);
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}

export function event(eventType: string, payload: unknown): Uint8Array {
  return frame(
    [
      [':event-type', eventType],
      [':content-type', 'application/json'],
      [':message-type', 'event'],
    ],
    payload,
  );
}

export function exception(exceptionType: string, message: string): Uint8Array {
  return frame(
    [
      [':exception-type', exceptionType],
      [':content-type', 'application/json'],
      [':message-type', 'exception'],
    ],
    { message },
  );
}

export function concat(frames: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.byteLength, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.byteLength;
  }
  return out;
}

/** A body delivered in `chunkSize`-byte reads, so frames straddle chunk boundaries. */
export function streamOf(bytes: Uint8Array, chunkSize = 7): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + chunkSize));
      at += chunkSize;
    },
  });
}

/** A text + one toolUse turn, in the event order ConverseStream emits. */
export const TEXT_AND_TOOL_FRAMES: Uint8Array[] = [
  event('messageStart', { role: 'assistant' }),
  event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Let me check.' } }),
  event('contentBlockStop', { contentBlockIndex: 0 }),
  event('contentBlockStart', {
    contentBlockIndex: 1,
    start: { toolUse: { toolUseId: 'tooluse_abc123', name: 'read_file' } },
  }),
  event('contentBlockDelta', {
    contentBlockIndex: 1,
    delta: { toolUse: { input: '{"path":' } },
  }),
  event('contentBlockDelta', {
    contentBlockIndex: 1,
    delta: { toolUse: { input: '"a.txt"}' } },
  }),
  event('contentBlockStop', { contentBlockIndex: 1 }),
  event('messageStop', { stopReason: 'tool_use' }),
  event('metadata', {
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    metrics: { latencyMs: 812 },
  }),
];

/** The smallest complete stream: a stop and its usage. */
export const MINIMAL_FRAMES: Uint8Array[] = [
  event('messageStart', { role: 'assistant' }),
  event('messageStop', { stopReason: 'end_turn' }),
  event('metadata', { usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } }),
];
