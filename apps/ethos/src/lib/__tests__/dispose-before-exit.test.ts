import { describe, expect, it, vi } from 'vitest';
import { disposeBeforeExit } from '../dispose-before-exit';

describe('disposeBeforeExit (F06)', () => {
  it('runs the steps in order and skips absent ones', async () => {
    const order: string[] = [];
    const warnings: string[] = [];
    await disposeBeforeExit(
      [
        ['web api', async () => void order.push('web api')],
        ['absent', undefined],
        ['loop', async () => void order.push('loop')],
      ],
      (m) => warnings.push(m),
    );
    expect(order).toEqual(['web api', 'loop']);
    expect(warnings).toEqual([]);
  });

  it('reports a failing step and still runs the next one', async () => {
    const order: string[] = [];
    const warnings: string[] = [];
    await disposeBeforeExit(
      [
        [
          'web api',
          async () => {
            throw new Error('cards.db busy');
          },
        ],
        ['loop', async () => void order.push('loop')],
      ],
      (m) => warnings.push(m),
    );
    expect(order).toEqual(['loop']);
    expect(warnings).toEqual(['[shutdown] web api: dispose failed: cards.db busy']);
  });

  it('gives up on a hung step after the grace period instead of holding the exit', async () => {
    const warnings: string[] = [];
    await disposeBeforeExit(
      [['loop', () => new Promise<void>(() => {})]],
      (m) => warnings.push(m),
      5,
    );
    expect(warnings).toEqual(['[shutdown] loop: did not finish within 5ms — left behind']);
  });

  // F06 follow-up — the store closes after a hung runtime dispose must still
  // run: they are what leaves no -wal behind.
  it('still runs the steps after one that hung', async () => {
    const order: string[] = [];
    await disposeBeforeExit(
      [
        ['agent loop', () => new Promise<void>(() => {})],
        ['sessions.db', async () => void order.push('sessions.db')],
        ['observability.db', async () => void order.push('observability.db')],
      ],
      () => {},
      20,
    );
    expect(order).toEqual(['sessions.db', 'observability.db']);
  });

  it('keeps its grace timer referenced while it waits', async () => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const t = realSetTimeout(fn, ms);
      timers.push(t);
      return t;
    }) as never);
    const waiting = disposeBeforeExit([['loop', () => new Promise<void>(() => {})]], () => {}, 20);
    await Promise.resolve();
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.every((t) => t.hasRef())).toBe(true);
    spy.mockRestore();
    await waiting;
  });
});
