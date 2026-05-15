import { describe, expect, it, vi } from 'vitest';
import { EventStream } from '../stream';

describe('EventStream', () => {
  it('returns a subscription with close() and lastSeq', () => {
    const ac = new AbortController();
    const onEvent = vi.fn();

    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test',
      sessionId: 'sess-1',
      onEvent,
      signal: ac.signal,
    });

    expect(sub.lastSeq).toBe(0);
    expect(sub.closed).toBe(false);

    sub.close();
    expect(sub.closed).toBe(true);
  });

  it('starts from sinceSeq when provided', () => {
    const ac = new AbortController();

    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-ethos-test',
      sessionId: 'sess-1',
      sinceSeq: 42,
      onEvent: vi.fn(),
      signal: ac.signal,
    });

    expect(sub.lastSeq).toBe(42);
    sub.close();
  });
});
