import { describe, expect, it } from 'vitest';
import { COMMAND_DRAIN_MS, releaseCommandRuntime } from '../release-command-runtime';

describe('releaseCommandRuntime', () => {
  it('drains before disposing', async () => {
    const order: string[] = [];
    await releaseCommandRuntime({
      drain: async () => {
        order.push('drain');
      },
      dispose: async () => {
        order.push('dispose');
      },
    });
    expect(order).toEqual(['drain', 'dispose']);
  });

  it('disposes host-owned stores after the loop', async () => {
    const order: string[] = [];
    await releaseCommandRuntime(
      {
        dispose: async () => {
          order.push('loop');
        },
      },
      {
        drainMs: 0,
        also: [['sessions.db', async () => void order.push('sessions.db')]],
      },
    );
    expect(order).toEqual(['loop', 'sessions.db']);
  });

  it('stops waiting on a drain that never settles, and still disposes', async () => {
    const warnings: string[] = [];
    let disposed = false;
    const started = Date.now();
    await releaseCommandRuntime(
      {
        drain: () => new Promise<void>(() => {}),
        dispose: async () => {
          disposed = true;
        },
      },
      { drainMs: 40, warn: (m) => warnings.push(m) },
    );
    expect(disposed).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    // A bounded drain is not a failure — the work stays in the store for the
    // next process to claim, so nothing is warned about.
    expect(warnings).toEqual([]);
  });

  it('reports a failing dispose instead of throwing', async () => {
    const warnings: string[] = [];
    await expect(
      releaseCommandRuntime(
        {
          dispose: async () => {
            throw new Error('boom');
          },
        },
        { drainMs: 0, warn: (m) => warnings.push(m) },
      ),
    ).resolves.toBeUndefined();
    expect(warnings.join('\n')).toContain('boom');
  });

  it('skips the drain when drainMs is 0', async () => {
    let drained = false;
    await releaseCommandRuntime(
      {
        drain: async () => {
          drained = true;
        },
        dispose: async () => {},
      },
      { drainMs: 0 },
    );
    expect(drained).toBe(false);
  });

  it('has a drain bound short enough for an interactive command', () => {
    expect(COMMAND_DRAIN_MS).toBeLessThanOrEqual(10_000);
  });
});
