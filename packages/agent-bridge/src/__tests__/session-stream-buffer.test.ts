import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStreamBuffer } from '../session-stream-buffer';

describe('SessionStreamBuffer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('assigns monotonic seq per session', () => {
    const buf = new SessionStreamBuffer<string>();
    expect(buf.append('s1', 'a')).toBe(1);
    expect(buf.append('s1', 'b')).toBe(2);
    expect(buf.append('s2', 'x')).toBe(1); // independent counter per session
    expect(buf.append('s1', 'c')).toBe(3);
    expect(buf.head('s1')).toBe(3);
    expect(buf.head('s2')).toBe(1);
  });

  it('replays events with seq > sinceSeq', () => {
    const buf = new SessionStreamBuffer<string>();
    buf.append('s1', 'a');
    buf.append('s1', 'b');
    buf.append('s1', 'c');

    expect(buf.replay('s1').events.map((e) => e.event)).toEqual(['a', 'b', 'c']);
    expect(buf.replay('s1', 1).events.map((e) => e.event)).toEqual(['b', 'c']);
    expect(buf.replay('s1', 3).events.map((e) => e.event)).toEqual([]);
    expect(buf.replay('unknown').events).toEqual([]);
  });

  it('evicts oldest when capacity is exceeded', () => {
    const buf = new SessionStreamBuffer<string>({ capacity: 3 });
    buf.append('s1', 'a');
    buf.append('s1', 'b');
    buf.append('s1', 'c');
    buf.append('s1', 'd'); // evicts 'a'
    buf.append('s1', 'e'); // evicts 'b'

    const replayed = buf.replay('s1').events.map((e) => `${e.seq}:${e.event}`);
    expect(replayed).toEqual(['3:c', '4:d', '5:e']);
    expect(buf.head('s1')).toBe(5); // head keeps incrementing past evictions
  });

  it('reports no gap on a fresh connect (sinceSeq=0) even after eviction', () => {
    const buf = new SessionStreamBuffer<string>({ capacity: 3 });
    buf.append('s1', 'a');
    buf.append('s1', 'b');
    buf.append('s1', 'c');
    buf.append('s1', 'd'); // evicts 'a'

    expect(buf.replay('s1').gap).toBe(false);
    expect(buf.replay('s1', 0).gap).toBe(false);
  });

  it('reports gap:true when sinceSeq predates what capacity eviction retained', () => {
    const buf = new SessionStreamBuffer<string>({ capacity: 1000 });
    for (let i = 0; i < 1200; i++) buf.append('s1', `e${i}`);
    // 1200 appends at capacity 1000: seq 1-200 evicted, 201-1200 retained.

    const stale = buf.replay('s1', 1);
    expect(stale.gap).toBe(true);
    expect(stale.events[0]?.seq).toBe(201);
    expect(stale.events).toHaveLength(1000);

    const fresh = buf.replay('s1', 1150);
    expect(fresh.gap).toBe(false);
    expect(fresh.events).toHaveLength(50);
  });

  it('reports gap:true when resuming a session this buffer has no record of at all', () => {
    const buf = new SessionStreamBuffer<string>();
    // Never appended, or already reaped — either way sinceSeq>0 can't be
    // proven lossless.
    expect(buf.replay('unknown-session', 5).gap).toBe(true);
    // But a fresh connect (sinceSeq=0) to an unknown session is not a
    // resume, so it's not a gap either — just nothing to replay.
    expect(buf.replay('unknown-session').gap).toBe(false);
  });

  it('reaps a disconnected session after the configured timeout', () => {
    vi.useFakeTimers();
    const buf = new SessionStreamBuffer<string>({ reapMs: 1000 });
    buf.append('s1', 'a');
    buf.disconnect('s1');

    vi.advanceTimersByTime(999);
    expect(buf.replay('s1').events).toHaveLength(1);

    vi.advanceTimersByTime(2);
    expect(buf.replay('s1').events).toHaveLength(0);
    expect(buf.head('s1')).toBe(0);
  });

  it('fires onReap when the timer expires (owner cleanup hook)', () => {
    vi.useFakeTimers();
    const buf = new SessionStreamBuffer<string>({ reapMs: 1000 });
    const reaped: string[] = [];
    buf.onReap = (id) => reaped.push(id);

    buf.append('s1', 'a');
    buf.disconnect('s1');
    expect(reaped).toEqual([]);

    vi.advanceTimersByTime(1100);
    expect(reaped).toEqual(['s1']);
  });

  it('does not fire onReap if touch cancels the timer', () => {
    vi.useFakeTimers();
    const buf = new SessionStreamBuffer<string>({ reapMs: 1000 });
    const reaped: string[] = [];
    buf.onReap = (id) => reaped.push(id);

    buf.append('s1', 'a');
    buf.disconnect('s1');
    vi.advanceTimersByTime(500);
    buf.touch('s1');
    vi.advanceTimersByTime(2000);

    expect(reaped).toEqual([]);
  });

  it('isolates onReap callback errors from the buffer', () => {
    vi.useFakeTimers();
    const buf = new SessionStreamBuffer<string>({ reapMs: 1000 });
    buf.onReap = () => {
      throw new Error('owner had a bad day');
    };

    buf.append('s1', 'a');
    buf.disconnect('s1');
    expect(() => vi.advanceTimersByTime(1100)).not.toThrow();
    // Buffer's own teardown still happened.
    expect(buf.head('s1')).toBe(0);
  });

  it('touch cancels a pending reap', () => {
    vi.useFakeTimers();
    const buf = new SessionStreamBuffer<string>({ reapMs: 1000 });
    buf.append('s1', 'a');
    buf.disconnect('s1');

    vi.advanceTimersByTime(500);
    buf.touch('s1'); // client reconnected
    vi.advanceTimersByTime(2000);

    expect(buf.replay('s1').events).toHaveLength(1); // not reaped
  });

  it('append re-touches automatically (so a write defers reap)', () => {
    vi.useFakeTimers();
    const buf = new SessionStreamBuffer<string>({ reapMs: 1000 });
    buf.append('s1', 'a');
    buf.disconnect('s1');

    vi.advanceTimersByTime(800);
    buf.append('s1', 'b');
    vi.advanceTimersByTime(800);

    expect(buf.replay('s1').events.map((e) => e.event)).toEqual(['a', 'b']);
  });

  it('clear immediately drops a session', () => {
    const buf = new SessionStreamBuffer<string>();
    buf.append('s1', 'a');
    buf.append('s1', 'b');

    buf.clear('s1');
    expect(buf.replay('s1').events).toHaveLength(0);
    expect(buf.head('s1')).toBe(0);

    // Subsequent appends restart at seq=1
    expect(buf.append('s1', 'c')).toBe(1);
  });

  it('destroy clears all timers and buffers', () => {
    vi.useFakeTimers();
    const buf = new SessionStreamBuffer<string>({ reapMs: 1000 });
    buf.append('s1', 'a');
    buf.append('s2', 'b');
    buf.disconnect('s1');
    buf.disconnect('s2');

    buf.destroy();

    vi.advanceTimersByTime(2000); // would have reaped, but destroy cleared timers
    expect(buf.replay('s1').events).toHaveLength(0);
    expect(buf.replay('s2').events).toHaveLength(0);
  });
});
