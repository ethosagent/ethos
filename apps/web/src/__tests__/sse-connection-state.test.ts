import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseConnectionState, subscribeToSession as SubscribeToSession } from '../sse';

// W2 (ux-feedback plan) — the shared EventSource's health is surfaced instead
// of a disconnect being silent: `open` / `reconnecting` / `closed`, reported
// to every subscriber and readable off the subscription handle. Same fake +
// module-reset harness as `sse.test.ts` (the registry is module state).

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  /** 0 CONNECTING / 1 OPEN / 2 CLOSED — the spec's numeric states. */
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(data: unknown, lastEventId = ''): void {
    this.onmessage?.({ data: JSON.stringify(data), lastEventId });
  }

  fail(final = false): void {
    this.readyState = final ? 2 : 0;
    this.onerror?.(new Error('drop'));
  }
}

const sampleEvent = { type: 'notification' as const, message: 'hi' };

await import('../sse');

let subscribeToSession: typeof SubscribeToSession;

beforeEach(async () => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  vi.resetModules();
  ({ subscribeToSession } = await import('../sse'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeToSession — connection state (W2)', () => {
  it('reports the current state on subscribe, then every transition', () => {
    const seen: SseConnectionState[] = [];
    const sub = subscribeToSession('s1', {
      onEvent: vi.fn(),
      onConnectionState: (state) => seen.push(state),
    });
    // Not yet open: the socket is connecting, spelled `reconnecting`.
    expect(seen).toEqual(['reconnecting']);
    expect(sub.connectionState).toBe('reconnecting');

    FakeEventSource.instances[0]?.open();
    expect(seen).toEqual(['reconnecting', 'open']);
    expect(sub.connectionState).toBe('open');

    FakeEventSource.instances[0]?.fail();
    expect(seen).toEqual(['reconnecting', 'open', 'reconnecting']);

    // The browser's retry succeeding shows up as the next open.
    FakeEventSource.instances[0]?.open();
    expect(sub.connectionState).toBe('open');
  });

  it('a frame counts as open even when onopen never fired', () => {
    const seen: SseConnectionState[] = [];
    subscribeToSession('s1', {
      onEvent: vi.fn(),
      onConnectionState: (state) => seen.push(state),
    });
    FakeEventSource.instances[0]?.emit(sampleEvent, '1');
    expect(seen).toEqual(['reconnecting', 'open']);
  });

  it('CLOSED readyState reports closed, not reconnecting', () => {
    const seen: SseConnectionState[] = [];
    const sub = subscribeToSession('s1', {
      onEvent: vi.fn(),
      onConnectionState: (state) => seen.push(state),
    });
    FakeEventSource.instances[0]?.open();
    FakeEventSource.instances[0]?.fail(true);
    expect(seen).toEqual(['reconnecting', 'open', 'closed']);
    expect(sub.connectionState).toBe('closed');
  });

  it('a late subscriber is told the state it joined in, and shares transitions', () => {
    subscribeToSession('s1', { onEvent: vi.fn() });
    FakeEventSource.instances[0]?.open();

    const seen: SseConnectionState[] = [];
    subscribeToSession('s1', {
      onEvent: vi.fn(),
      onConnectionState: (state) => seen.push(state),
    });
    expect(seen).toEqual(['open']);

    FakeEventSource.instances[0]?.fail();
    expect(seen).toEqual(['open', 'reconnecting']);
  });

  it('duplicate transitions are not re-announced', () => {
    const seen: SseConnectionState[] = [];
    subscribeToSession('s1', {
      onEvent: vi.fn(),
      onConnectionState: (state) => seen.push(state),
    });
    const source = FakeEventSource.instances[0];
    source?.open();
    source?.emit(sampleEvent, '1');
    source?.emit(sampleEvent, '2');
    expect(seen).toEqual(['reconnecting', 'open']);
  });
});
