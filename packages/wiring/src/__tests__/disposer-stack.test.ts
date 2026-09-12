import { describe, expect, it, vi } from 'vitest';
import { DisposerStack } from '../disposer-stack';

describe('DisposerStack (F06)', () => {
  it('runs cleanups newest first', async () => {
    const order: string[] = [];
    const stack = new DisposerStack();
    stack.push('store', () => order.push('store'));
    stack.push('worker', async () => {
      await Promise.resolve();
      order.push('worker');
    });
    await stack.dispose();
    expect(order).toEqual(['worker', 'store']);
  });

  it('attempts every cleanup when one throws, then rejects with an AggregateError', async () => {
    const ran: string[] = [];
    const stack = new DisposerStack();
    stack.push('a', () => ran.push('a'));
    stack.push('b', () => {
      throw new Error('boom');
    });
    stack.push('c', () => ran.push('c'));
    const err = await stack.dispose().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(1);
    expect((err as AggregateError).message).toContain('b: boom');
    expect(ran).toEqual(['c', 'a']);
  });

  it('is idempotent: a second dispose runs nothing again', async () => {
    let count = 0;
    const stack = new DisposerStack();
    stack.push('once', () => {
      count++;
    });
    const first = stack.dispose();
    const second = stack.dispose();
    expect(second).toBe(first);
    await first;
    await stack.dispose();
    expect(count).toBe(1);
  });

  // F06 follow-up — one hung cleanup (a plugin whose `deactivate` never
  // resolves) used to hold every cleanup after it: MCP children, goals.db, the
  // kanban store, sessions.db. Each step now has its own bound.
  it('bounds each step, reports the one that hung, and still runs the rest', async () => {
    const ran: string[] = [];
    const stack = new DisposerStack({ stepTimeoutMs: 20 });
    stack.push('sessions.db', () => ran.push('sessions.db'));
    stack.push('plugins', () => new Promise(() => {}));
    stack.push('scheduler', () => ran.push('scheduler'));
    const started = Date.now();
    const err = await stack.dispose().catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).message).toContain('plugins: did not finish within 20ms');
    expect(ran).toEqual(['scheduler', 'sessions.db']);
  });

  it('keeps its step timer referenced, so a hang holding no handle cannot end the process early', async () => {
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
    const stack = new DisposerStack({ stepTimeoutMs: 20 });
    stack.push('hung', () => new Promise(() => {}));
    const disposal = stack.dispose().catch(() => {});
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.every((t) => t.hasRef())).toBe(true);
    spy.mockRestore();
    await disposal;
  });

  it('refuses registration after disposal', async () => {
    const stack = new DisposerStack();
    await stack.dispose();
    expect(() => stack.push('late', () => {})).toThrow(/already disposed/);
  });
});
