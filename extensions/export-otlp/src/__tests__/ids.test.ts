import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { otlpSpanId, otlpTraceId, rootSpanId } from '../ids';

describe('otlpTraceId', () => {
  it('strips dashes and lowercases a UUID trace id', () => {
    expect(otlpTraceId('4FB4B9C1-9B2A-4E0F-8D3C-1A2B3C4D5E6F')).toBe(
      '4fb4b9c19b2a4e0f8d3c1a2b3c4d5e6f',
    );
    expect(otlpTraceId('4fb4b9c1-9b2a-4e0f-8d3c-1a2b3c4d5e6f')).toBe(
      '4fb4b9c19b2a4e0f8d3c1a2b3c4d5e6f',
    );
  });

  it('is 32 lowercase hex chars for any input', () => {
    for (const input of ['not-a-uuid', 'cli:ethos', '']) {
      const id = otlpTraceId(input);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('hashes a non-UUID trace id to the first 32 hex chars of sha256', () => {
    const expected = createHash('sha256').update('not-a-uuid').digest('hex').slice(0, 32);
    expect(otlpTraceId('not-a-uuid')).toBe(expected);
  });
});

describe('otlpSpanId', () => {
  it('is 16 hex chars, deterministic across calls', () => {
    const a = otlpSpanId('span-abc');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(otlpSpanId('span-abc')).toBe(a);
    expect(otlpSpanId('span-xyz')).not.toBe(a);
  });

  it('is the first 8 bytes of sha256(spanId)', () => {
    const expected = createHash('sha256').update('span-abc').digest('hex').slice(0, 16);
    expect(otlpSpanId('span-abc')).toBe(expected);
  });
});

describe('rootSpanId', () => {
  it('is 16 hex chars, deterministic', () => {
    const a = rootSpanId('trace-1');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(rootSpanId('trace-1')).toBe(a);
  });

  it('never collides with otlpSpanId of the same trace id in a 10k-id sample', () => {
    for (let i = 0; i < 10_000; i++) {
      const id = `id-${i}`;
      expect(rootSpanId(id)).not.toBe(otlpSpanId(id));
    }
  });
});
