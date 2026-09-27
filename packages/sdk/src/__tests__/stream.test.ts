import { ActivityEventSchema } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStream, STALL_MS } from '../stream';

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

// Builds a fake SSE `Response` whose body streams the given raw frame
// strings (each including its own trailing blank-line terminator) as
// separate chunks, in order, then closes.
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

// A response body that never enqueues or closes — `reader.read()` hangs
// until the request's AbortSignal fires, same as a genuinely stalled
// connection.
function stalledResponse(signal: AbortSignal): Response {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal.addEventListener('abort', () => {
    try {
      controller.error(new DOMException('aborted', 'AbortError'));
    } catch {
      /* already closed */
    }
  });
  return new Response(stream, { status: 200 });
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('EventStreamOptions — path, fetch, Last-Event-ID (S2/T1)', () => {
  it('defaults to /sse/sessions/:sessionId when no path is given', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([]));
    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
    });
    await flush();
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0]?.[0];
    expect(url).toBe('http://localhost:3000/sse/sessions/sess-1');
    sub.close();
  });

  it('uses the custom path when given, in place of the session default', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([]));
    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      path: '/sse/activity',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
    });
    await flush();
    const url = fetchMock.mock.calls[0]?.[0];
    expect(url).toBe('http://localhost:3000/sse/activity');
    sub.close();
  });

  it('sends Last-Event-ID as a header (in addition to the ?lastEventId query) when sinceSeq > 0', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([]));
    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      sinceSeq: 7,
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
    });
    await flush();
    const [url, init] = fetchMock.mock.calls[0] ?? ['', {} as RequestInit];
    expect(url).toContain('lastEventId=7');
    expect((init.headers as Record<string, string>)['Last-Event-ID']).toBe('7');
    sub.close();
  });

  it('omits the Last-Event-ID header when sinceSeq is 0 or absent', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([]));
    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
    });
    await flush();
    const [, init] = fetchMock.mock.calls[0] ?? ['', {} as RequestInit];
    expect((init.headers as Record<string, string>)['Last-Event-ID']).toBeUndefined();
    sub.close();
  });

  it('uses the injected fetch, not the global one', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([]));
    const globalFetchSpy = vi.spyOn(globalThis, 'fetch');

    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
    });
    await flush();

    expect(fetchMock).toHaveBeenCalled();
    expect(globalFetchSpy).not.toHaveBeenCalled();
    globalFetchSpy.mockRestore();
    sub.close();
  });
});

describe('EventStream — gap frame (D13, T1)', () => {
  it('surfaces a gap frame via onGap without advancing lastSeq or calling onEvent for it', async () => {
    const frames = [
      'event: gap\ndata: {}\n\n',
      'id: 5\ndata: {"type":"text_delta","text":"hi"}\n\n',
    ];
    const fetchMock = vi.fn(async () => sseResponse(frames));
    const onEvent = vi.fn();
    const onGap = vi.fn();

    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent,
      onGap,
    });
    await flush();
    await flush();

    expect(onGap).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(sub.lastSeq).toBe(5);
    sub.close();
  });

  it('an app with no onGap simply never sees the frame (old-client safety)', async () => {
    const frames = [
      'event: gap\ndata: {}\n\n',
      'id: 5\ndata: {"type":"text_delta","text":"hi"}\n\n',
    ];
    const fetchMock = vi.fn(async () => sseResponse(frames));
    const onEvent = vi.fn();

    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent,
    });
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledTimes(1);
    sub.close();
  });
});

describe('EventStream — stall watchdog and retry policy (R6b-R6d)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts and reconnects after STALL_MS with no bytes', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(stalledResponse(init.signal as AbortSignal)),
    );
    const onError = vi.fn();

    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    // No bytes for STALL_MS: the watchdog aborts the attempt.
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(onError).toHaveBeenCalledTimes(1);

    // Default fixed retry (3s) then reconnects.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    sub.close();
  });

  it('default retry is a fixed 3s delay', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));

    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    sub.close();
  });

  it('backoff retry delay grows with a full-jitter bound, capped at 30s, and resetBackoff() restarts it', async () => {
    vi.useFakeTimers();
    // Pin the jitter at its max (random() = 1) so each delay is exactly
    // min(cap, base * 2^attempt) — deterministic, so advancing by exactly
    // that many ms is what triggers the next attempt (a random value could
    // let several cycles fit inside one wide advance and defeat the
    // per-attempt assertions below).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));

    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      retry: 'backoff',
      onEvent: vi.fn(),
      onError: vi.fn(),
    });

    // attempt 1: min(30s, 1s*2^1) = 2s
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // attempt 2: min(30s, 4s) = 4s
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // attempt 3: min(30s, 8s) = 8s
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // attempt 4: min(30s, 16s) = 16s
    await vi.advanceTimersByTimeAsync(16_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // attempt 5: min(30s, 32s) = 30s — the cap kicks in.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // attempt 6 would be min(30s, 64s) — stays at the 30s cap, not 64s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);

    // Reset: the next bound drops back to attempt 1's 2s, not the 30s the
    // un-reset counter would have produced. The pending pre-reset 30s sleep
    // (scheduled by attempt 6's failure, before resetBackoff() ran) still
    // has to elapse on its own — resetBackoff() only affects the NEXT
    // computation, after that sleep fires and this attempt fails too.
    sub.resetBackoff();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(8);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(8); // 2s bound not yet elapsed
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(9); // now it has — proves the reset, not a stale 30s bound

    randomSpy.mockRestore();
    sub.close();
  });
});

describe('EventStreamOptions — schema (activity envelope)', () => {
  it('parses ActivityEvent envelope frames when schema is given, no sessionId needed', async () => {
    const frames = [
      'id: 1\ndata: {"sessionId":"sess-1","personalityId":"nova","event":{"type":"done","text":"hi","turnCount":1}}\n\n',
    ];
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(frames));
    const onEvent = vi.fn();

    const sub = EventStream({
      baseUrl: 'http://localhost:3000',
      path: '/sse/activity',
      schema: ActivityEventSchema,
      fetch: fetchMock as unknown as typeof fetch,
      onEvent,
    });
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const [event, seq] = onEvent.mock.calls[0] ?? [];
    expect(event).toEqual({
      sessionId: 'sess-1',
      personalityId: 'nova',
      event: { type: 'done', text: 'hi', turnCount: 1 },
    });
    expect(seq).toBe(1);
    sub.close();
  });
});

// An unreachable server (a phone reaching a server bound to 127.0.0.1): iOS
// rejects the fetch with "Could not connect to the server". Nothing awaits the
// stream's loop, so any rejection that escapes it is unhandled — under Expo Go
// a full-screen error. Each case collects `unhandledRejection` for its life.
describe('EventStream — unreachable server never leaks a rejection', () => {
  let leaked: unknown[] = [];
  const collect = (reason: unknown) => leaked.push(reason);
  beforeEach(() => {
    leaked = [];
    process.on('unhandledRejection', collect);
  });
  afterEach(() => {
    process.off('unhandledRejection', collect);
  });

  const refused = () =>
    vi.fn(async () => {
      throw new TypeError('Could not connect to the server');
    });

  it('reports a refused connection to onError and keeps retrying', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = refused();
      const onError = vi.fn();
      const sub = EventStream({
        baseUrl: 'http://192.168.1.20:3000',
        path: '/sse/activity',
        fetch: fetchMock as unknown as typeof fetch,
        onEvent: vi.fn(),
        onError,
      });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledWith(expect.any(TypeError));
      expect(sub.closed).toBe(false);
      sub.close();
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(leaked).toEqual([]);
  });

  it('a throwing onError neither rejects the loop nor stops the retries', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = refused();
      const sub = EventStream({
        baseUrl: 'http://192.168.1.20:3000',
        path: '/sse/activity',
        fetch: fetchMock as unknown as typeof fetch,
        onEvent: vi.fn(),
        onError: () => {
          throw new Error('handler bug');
        },
      });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      sub.close();
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(leaked).toEqual([]);
  });

  it('close() mid-read ends the loop without leaking the aborted body read', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      stalledResponse(init.signal as AbortSignal),
    );
    const onError = vi.fn();
    const sub = EventStream({
      baseUrl: 'http://192.168.1.20:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: vi.fn(),
      onError,
    });
    await flush();
    sub.close();
    await flush();
    await flush();
    expect(sub.closed).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(leaked).toEqual([]);
  });

  it('a throwing onGap is reported, not treated as a dropped connection', async () => {
    const frames = [
      'event: gap\ndata: {}\n\n',
      'id: 3\ndata: {"type":"text_delta","text":"x"}\n\n',
    ];
    const fetchMock = vi.fn(async () => sseResponse(frames));
    const onEvent = vi.fn();
    const onError = vi.fn();
    const sub = EventStream({
      baseUrl: 'http://192.168.1.20:3000',
      sessionId: 'sess-1',
      fetch: fetchMock as unknown as typeof fetch,
      onEvent,
      onError,
      onGap: () => {
        throw new Error('rehydrate failed');
      },
    });
    await flush();
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'rehydrate failed' }));
    expect(onEvent).toHaveBeenCalledTimes(1);
    sub.close();
    await flush();
    expect(leaked).toEqual([]);
  });
});
