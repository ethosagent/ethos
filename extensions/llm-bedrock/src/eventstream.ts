// AWS binary event-stream decoder (application/vnd.amazon.eventstream), the
// framing Bedrock's ConverseStream response uses. Hand-rolled because no
// eventstream codec is a dependency of this package (UBP-005).
//
// One message on the wire:
//
//   total length   uint32 BE   whole message, including both CRCs
//   headers length uint32 BE
//   prelude CRC    uint32 BE   CRC32 of the 8 bytes above
//   headers        `headers length` bytes
//   payload        total - headers - 16 bytes
//   message CRC    uint32 BE   CRC32 of everything before it
//
// A header is: name length (uint8), name (UTF-8), value type (uint8), value.
// Both CRCs are verified; a mismatch throws rather than guessing at a frame
// boundary, because every later frame would be misaligned too.

export type EventStreamHeaderValue = boolean | number | bigint | string | Uint8Array;

export interface EventStreamMessage {
  headers: Record<string, EventStreamHeaderValue>;
  payload: Uint8Array;
}

const PRELUDE_BYTES = 12;
const MIN_MESSAGE_BYTES = 16;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 (IEEE 802.3, the polynomial the event-stream spec names). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A frame that fails its CRC or declares an impossible length. */
export class EventStreamFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventStreamFramingError';
  }
}

function parseHeaders(bytes: Uint8Array): Record<string, EventStreamHeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const headers: Record<string, EventStreamHeaderValue> = {};
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.byteLength) {
      throw new EventStreamFramingError('event-stream header runs past the header block');
    }
  };
  while (at < bytes.byteLength) {
    need(1);
    const nameLength = view.getUint8(at);
    at += 1;
    need(nameLength + 1);
    const name = decoder.decode(bytes.subarray(at, at + nameLength));
    at += nameLength;
    const type = view.getUint8(at);
    at += 1;
    switch (type) {
      case 0:
        headers[name] = true;
        break;
      case 1:
        headers[name] = false;
        break;
      case 2:
        need(1);
        headers[name] = view.getInt8(at);
        at += 1;
        break;
      case 3:
        need(2);
        headers[name] = view.getInt16(at);
        at += 2;
        break;
      case 4:
        need(4);
        headers[name] = view.getInt32(at);
        at += 4;
        break;
      case 5:
      case 8:
        // long, timestamp (ms since epoch) — both int64
        need(8);
        headers[name] = view.getBigInt64(at);
        at += 8;
        break;
      case 6:
      case 7: {
        // byte array, string — uint16 length prefix
        need(2);
        const length = view.getUint16(at);
        at += 2;
        need(length);
        const value = bytes.subarray(at, at + length);
        headers[name] = type === 7 ? decoder.decode(value) : value.slice();
        at += length;
        break;
      }
      case 9:
        need(16);
        headers[name] = bytes.slice(at, at + 16);
        at += 16;
        break;
      default:
        throw new EventStreamFramingError(`unknown event-stream header type ${type} on "${name}"`);
    }
  }
  return headers;
}

/**
 * Incremental decoder: feed it the body's chunks in order, collect whole
 * messages. Chunk boundaries are arbitrary — a frame may span many chunks, and
 * one chunk may hold many frames.
 */
export class EventStreamDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): EventStreamMessage[] {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;

    const messages: EventStreamMessage[] = [];
    while (this.buffer.byteLength >= PRELUDE_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const totalLength = view.getUint32(0);
      const headersLength = view.getUint32(4);
      const preludeCrc = view.getUint32(8);
      if (crc32(this.buffer.subarray(0, 8)) !== preludeCrc) {
        throw new EventStreamFramingError('event-stream prelude CRC mismatch');
      }
      if (totalLength < MIN_MESSAGE_BYTES || headersLength > totalLength - MIN_MESSAGE_BYTES) {
        throw new EventStreamFramingError(
          `event-stream frame declares impossible lengths (total ${totalLength}, headers ${headersLength})`,
        );
      }
      if (this.buffer.byteLength < totalLength) break;

      const frame = this.buffer.subarray(0, totalLength);
      const messageCrc = view.getUint32(totalLength - 4);
      if (crc32(frame.subarray(0, totalLength - 4)) !== messageCrc) {
        throw new EventStreamFramingError('event-stream message CRC mismatch');
      }
      const headers = parseHeaders(frame.subarray(PRELUDE_BYTES, PRELUDE_BYTES + headersLength));
      const payload = frame.slice(PRELUDE_BYTES + headersLength, totalLength - 4);
      messages.push({ headers, payload });
      this.buffer = this.buffer.slice(totalLength);
    }
    return messages;
  }

  /** Bytes received that do not yet form a whole frame. */
  get pendingBytes(): number {
    return this.buffer.byteLength;
  }
}
