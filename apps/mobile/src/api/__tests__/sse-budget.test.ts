import type { EventStreamSubscription } from '@ethosagent/sdk';
import { describe, expect, it } from 'vitest';
import { createStreams, type OpenStream } from '../sse';

interface FakeSub extends EventStreamSubscription {
  path: string;
  sinceSeq: number | undefined;
  seq: number;
}

function fakeOpener() {
  const opened: FakeSub[] = [];
  const open: OpenStream = (path, sinceSeq) => {
    const sub: {
      path: string;
      sinceSeq: number | undefined;
      seq: number;
      closed: boolean;
      readonly lastSeq: number;
      close(): void;
      resetBackoff(): void;
    } = {
      path,
      sinceSeq,
      seq: 0,
      closed: false,
      get lastSeq() {
        return this.seq;
      },
      close() {
        this.closed = true;
      },
      resetBackoff() {},
    };
    opened.push(sub);
    return sub;
  };
  const live = () => opened.filter((s) => !s.closed).map((s) => s.path);
  return { open, opened, live };
}

describe('sse budget', () => {
  it('session stream plus one feed, never more than two (case 22)', () => {
    const s = createStreams();
    const f = fakeOpener();
    s.openSession('/sse/sessions/s1', f.open);
    s.openFeed('/sse/activity', f.open);
    expect(s.openCount()).toBe(2);
    s.openFeed('/sse/kanban/marketing', f.open);
    expect(f.live()).toEqual(['/sse/sessions/s1', '/sse/kanban/marketing']);
    expect(s.openCount()).toBe(2);
    const activitySub = f.opened[1];
    const sessionSub = f.opened[0];
    if (!activitySub || !sessionSub) throw new Error('setup');
    expect(activitySub.closed).toBe(true);
    expect(sessionSub.closed).toBe(false);
  });

  it('opening a feed never closes the session stream', () => {
    const s = createStreams();
    const f = fakeOpener();
    s.openSession('/sse/sessions/s1', f.open);
    s.openFeed('/sse/activity', f.open);
    expect(f.opened[0]?.closed).toBe(false);
    expect(s.openCount()).toBe(2);
    s.openFeed('/sse/system', f.open);
    expect(f.opened[0]?.closed).toBe(false);
    expect(s.openCount()).toBe(2);
    s.openFeed('/sse/activity', f.open);
    expect(f.opened[0]?.closed).toBe(false);
    expect(s.openCount()).toBe(2);
  });

  it('closeFeed only closes the feed it names', () => {
    const s = createStreams();
    const f = fakeOpener();
    s.openFeed('/sse/activity', f.open);
    s.openFeed('/sse/system', f.open);
    s.closeFeed('/sse/activity');
    expect(f.live()).toEqual(['/sse/system']);
    s.closeFeed('/sse/system');
    expect(f.live()).toEqual([]);
    expect(s.openCount()).toBe(0);
  });

  it('a new session replaces the old session stream', () => {
    const s = createStreams();
    const f = fakeOpener();
    s.openSession('/sse/sessions/a', f.open);
    s.openSession('/sse/sessions/b', f.open);
    expect(f.live()).toEqual(['/sse/sessions/b']);
  });

  it('suspend closes everything, resume reopens after the last seq', () => {
    const s = createStreams();
    const f = fakeOpener();
    s.openSession('/sse/sessions/s1', f.open);
    s.openFeed('/sse/activity', f.open);
    const [a, b] = f.opened;
    if (!a || !b) throw new Error('setup');
    a.seq = 41;
    b.seq = 7;
    s.suspend();
    expect(s.openCount()).toBe(0);
    s.resume(false);
    const newSession = f.opened[2];
    const newFeed = f.opened[3];
    if (!newSession || !newFeed) throw new Error('setup');
    expect(newSession.path).toBe('/sse/sessions/s1');
    expect(newSession.sinceSeq).toBe(41);
    expect(newFeed.path).toBe('/sse/activity');
    expect(newFeed.sinceSeq).toBe(7);
    expect(s.openCount()).toBe(2);
  });

  it('resume(true) opens fresh, without a seq', () => {
    const s = createStreams();
    const f = fakeOpener();
    s.openSession('/sse/sessions/s1', f.open);
    s.openFeed('/sse/activity', f.open);
    const [a] = f.opened;
    if (!a) throw new Error('setup');
    a.seq = 41;
    s.suspend();
    s.resume(true);
    const newSession = f.opened[2];
    if (!newSession) throw new Error('setup');
    expect(newSession.sinceSeq).toBeUndefined();
  });

  it('resume without a suspend opens nothing new', () => {
    const s = createStreams();
    const f = fakeOpener();
    s.openSession('/sse/sessions/s1', f.open);
    s.resume(false);
    expect(f.opened.length).toBe(1);
  });

  it('a stream that never saw a frame resumes fresh', () => {
    const s = createStreams();
    const f = fakeOpener();
    s.openSession('/sse/sessions/s1', f.open);
    s.suspend();
    s.resume(false);
    const newSession = f.opened[1];
    if (!newSession) throw new Error('setup');
    expect(newSession.sinceSeq).toBeUndefined();
  });
});
