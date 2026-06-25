import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { subscribeToSession as SubscribeToSession } from '../sse';

// Minimal fake EventSource: records every instance, exposes a `close` spy,
// and lets the test push a `message` event through whatever handler the
// subject assigned to `onmessage`.
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(data: unknown, lastEventId = ''): void {
    this.onmessage?.({ data: JSON.stringify(data), lastEventId });
  }
}

// A schema-valid SseEvent payload (the `notification` variant from
// @ethosagent/web-contracts is the simplest discriminated-union member).
const sampleEvent = { type: 'notification' as const, message: 'hi' };

// The shared-connection registry is module-level state, so each test gets a
// fresh copy of the module to stay isolated.
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

describe('subscribeToSession connection sharing', () => {
  it('creates exactly one EventSource for three subscribers to the same session', () => {
    subscribeToSession('s1', { onEvent: vi.fn() });
    subscribeToSession('s1', { onEvent: vi.fn() });
    subscribeToSession('s1', { onEvent: vi.fn() });

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('fans an emitted message out to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    subscribeToSession('s1', { onEvent: a });
    subscribeToSession('s1', { onEvent: b });
    subscribeToSession('s1', { onEvent: c });

    const source = FakeEventSource.instances[0];
    source?.emit(sampleEvent, '7');

    expect(a).toHaveBeenCalledWith(sampleEvent, 7);
    expect(b).toHaveBeenCalledWith(sampleEvent, 7);
    expect(c).toHaveBeenCalledWith(sampleEvent, 7);
  });

  it('closes the EventSource only when the last subscriber leaves', () => {
    const s1 = subscribeToSession('s1', { onEvent: vi.fn() });
    const s2 = subscribeToSession('s1', { onEvent: vi.fn() });
    const s3 = subscribeToSession('s1', { onEvent: vi.fn() });

    const source = FakeEventSource.instances[0];

    s1.close();
    s2.close();
    expect(source?.close).not.toHaveBeenCalled();

    s3.close();
    expect(source?.close).toHaveBeenCalledTimes(1);
  });

  it('opens a distinct EventSource for a different session', () => {
    subscribeToSession('s1', { onEvent: vi.fn() });
    subscribeToSession('s2', { onEvent: vi.fn() });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]?.url).not.toBe(FakeEventSource.instances[1]?.url);
  });

  it('re-opens a fresh EventSource after all subscribers close', () => {
    const s1 = subscribeToSession('s1', { onEvent: vi.fn() });
    s1.close();
    expect(FakeEventSource.instances).toHaveLength(1);

    subscribeToSession('s1', { onEvent: vi.fn() });
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
