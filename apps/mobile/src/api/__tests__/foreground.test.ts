import { describe, expect, it } from 'vitest';
import { createForegroundPolicy, FOREGROUND_REHYDRATE_MS } from '../foreground';

function harness(opts: { rehydrate?: () => Promise<void>; catchUp?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const reported: unknown[] = [];
  let now = 1_000_000;
  const policy = createForegroundPolicy({
    now: () => now,
    suspend: () => log.push('suspend'),
    resume: (fresh) => log.push(fresh ? 'subscribe:fresh' : 'subscribe:resume'),
    rehydrate:
      opts.rehydrate ??
      (async () => {
        log.push('sessions.messages');
        await Promise.resolve();
        log.push('dispatch:history-newest-merged');
      }),
    catchUp:
      opts.catchUp ??
      (async () => {
        log.push('tools.listPending');
        log.push('clarify.listPending');
        log.push('tasks.list');
      }),
    reportError: (err) => reported.push(err),
  });
  return {
    log,
    reported,
    policy,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('createForegroundPolicy', () => {
  it('backgrounded 61 s rehydrates, then subscribes, then catches up', async () => {
    const { log, policy, advance } = harness();
    await policy.onAppState('background');
    advance(61_000);
    await policy.onAppState('active');
    expect(log).toEqual([
      'suspend',
      'suspend',
      'sessions.messages',
      'dispatch:history-newest-merged',
      'subscribe:fresh',
      'tools.listPending',
      'clarify.listPending',
      'tasks.list',
    ]);
  });

  it('backgrounded 59 s only resumes the streams', async () => {
    const { log, policy, advance } = harness();
    await policy.onAppState('background');
    advance(59_000);
    await policy.onAppState('active');
    expect(log).toEqual(['suspend', 'subscribe:resume']);
  });

  it('exactly FOREGROUND_REHYDRATE_MS rehydrates', async () => {
    expect(FOREGROUND_REHYDRATE_MS).toBe(60_000);
    const { log, policy, advance } = harness();
    await policy.onAppState('background');
    advance(FOREGROUND_REHYDRATE_MS);
    await policy.onAppState('active');
    expect(log).toContain('sessions.messages');
  });

  it('active without a prior background does nothing', async () => {
    const { log, policy } = harness();
    await policy.onAppState('active');
    expect(log).toEqual([]);
  });

  it('inactive is ignored and does not end the background', async () => {
    const { log, policy, advance } = harness();
    await policy.onAppState('background');
    advance(30_000);
    await policy.onAppState('inactive');
    advance(40_000);
    await policy.onAppState('active');
    expect(log).toContain('sessions.messages');
    expect(log[0]).toBe('suspend');
    expect(log[1]).toBe('suspend');
  });

  it('the hydrate lands before any stream event (case 12)', async () => {
    let release: () => void = () => {};
    const h = harness({
      rehydrate: () =>
        new Promise<void>((r) => {
          release = () => {
            h.log.push('dispatch:history-newest-merged');
            r();
          };
        }),
    });
    await h.policy.onAppState('background');
    h.advance(120_000);
    const done = h.policy.onAppState('active');
    await Promise.resolve();
    expect(h.log).not.toContain('subscribe:fresh');
    release();
    await done;
    expect(h.log.indexOf('dispatch:history-newest-merged')).toBeLessThan(
      h.log.indexOf('subscribe:fresh'),
    );
  });

  it('a gap rehydrates even inside the 60 s window (case 20)', async () => {
    const { log, policy, advance } = harness();
    await policy.onAppState('background');
    advance(40_000);
    await policy.onAppState('active');
    expect(log).toEqual(['suspend', 'subscribe:resume']);
    await policy.onGap();
    expect(log.slice(2)).toEqual([
      'suspend',
      'sessions.messages',
      'dispatch:history-newest-merged',
      'subscribe:fresh',
      'tools.listPending',
      'clarify.listPending',
      'tasks.list',
    ]);
  });

  it('a failed rehydrate still reopens the streams, and reports instead of rejecting', async () => {
    const { log, reported, policy, advance } = harness({
      rehydrate: async () => {
        throw new TypeError('Could not connect to the server');
      },
    });
    await policy.onAppState('background');
    advance(90_000);
    await expect(policy.onAppState('active')).resolves.toBeUndefined();
    expect(log).toContain('subscribe:fresh');
    expect(log).not.toContain('tools.listPending');
    expect(reported).toEqual([new TypeError('Could not connect to the server')]);
  });

  it('a failed rehydrate after a gap resolves too (onGap is fired and forgotten)', async () => {
    const { reported, policy } = harness({
      rehydrate: async () => {
        throw new TypeError('Could not connect to the server');
      },
    });
    await expect(policy.onGap()).resolves.toBeUndefined();
    expect(reported).toHaveLength(1);
  });

  it('a catch-up that breaks its no-reject contract is reported, not rejected', async () => {
    const { log, reported, policy } = harness({
      catchUp: async () => {
        throw new TypeError('Could not connect to the server');
      },
    });
    await expect(policy.onGap()).resolves.toBeUndefined();
    expect(log).toContain('subscribe:fresh');
    expect(reported).toHaveLength(1);
  });
});
