export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Bytes cross JSON as `{ $bytes: <base64> }` (storage, document extractors, route bodies). */
export function encodeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeBytes);
  return value;
}

export function decodeBytes(value: unknown): unknown {
  if (isRecord(value) && typeof value.$bytes === 'string') {
    return new Uint8Array(Buffer.from(value.$bytes, 'base64'));
  }
  return value;
}
