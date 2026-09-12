import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent, GoalStore } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalRunner } from '../index';

// F06 — the owning loop's `dispose()` closes goals.db. A goal attempt still
// running on that loop would write into the closed store (and keep running on
// a loop that no longer serves anyone after a desktop restart), so the loop
// first calls `GoalRunner.shutdown()`: no new starts, every in-flight run
// aborted and awaited, and each one left `interrupted` — the status the next
// boot's `recoverOrphans` and `resume` already understand.

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** A turn that parks until aborted, then ends the way AgentLoop does. */
function parkedTurn(seen: { aborted: boolean }) {
  return async function* (
    _sk: string,
    _fm: string,
    opts: { abortSignal: AbortSignal },
  ): AsyncGenerator<AgentEvent> {
    yield { type: 'text_delta', text: 'partial work' };
    await waitForAbort(opts.abortSignal);
    seen.aborted = true;
    yield { type: 'error', error: 'Aborted', code: 'aborted' };
  };
}

async function waitForStatus(store: GoalStore, id: string, status: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (store.get(id)?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`goal ${id} never reached "${status}"`);
}

function makeGoal(store: GoalStore) {
  return store.create({
    userId: 'user-1',
    personalityId: 'tester',
    origin: 'cli',
    title: 'Test goal',
    goalText: 'Do the thing',
  });
}

/** Records every store write made after `closed` flips — there must be none. */
function watchWritesAfterClose(store: SQLiteGoalStore) {
  const state = { closed: false, lateWrites: [] as string[] };
  for (const method of ['updateStatus', 'appendEvent', 'saveAttempt', 'updateAttempt'] as const) {
    const original = store[method].bind(store) as (...args: unknown[]) => unknown;
    vi.spyOn(store, method).mockImplementation(((...args: unknown[]) => {
      if (state.closed) state.lateWrites.push(method);
      return original(...args);
    }) as never);
  }
  return state;
}

describe('GoalRunner.shutdown (F06)', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts an in-flight attempt, awaits it, and leaves the goal interrupted', async () => {
    const seen = { aborted: false };
    const runner = new GoalRunner({ store, runAttempt: parkedTurn(seen) });
    const goal = makeGoal(store);
    const writes = watchWritesAfterClose(store);

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'running');
    await new Promise((r) => setTimeout(r, 20));

    await runner.shutdown();

    expect(seen.aborted).toBe(true);
    const final = store.get(goal.id);
    // Not `failed` (the aborted error event), not judged: interrupted, so the
    // next boot can resume it.
    expect(final?.status).toBe('interrupted');
    expect(final?.outputPartial).toContain('partial work');

    // What the loop's dispose does next: close the store. The run has fully
    // unwound, so nothing writes into it afterwards.
    writes.closed = true;
    store.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(writes.lateWrites).toEqual([]);
  });

  it('interrupts a run parked in its planning turn instead of failing it', async () => {
    const seen = { aborted: false };
    const runner = new GoalRunner({
      store,
      runAttempt: parkedTurn({ aborted: false }),
      runPlan: parkedTurn(seen),
    });
    const goal = makeGoal(store);

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'planning');
    await runner.shutdown();

    expect(seen.aborted).toBe(true);
    expect(store.get(goal.id)?.status).toBe('interrupted');
    // No attempt was opened after the abort.
    expect(store.getAttempts(goal.id)).toEqual([]);
  });

  it('refuses starts and resumes once shut down', async () => {
    const runner = new GoalRunner({ store, runAttempt: parkedTurn({ aborted: false }) });
    await runner.shutdown();

    const goal = makeGoal(store);
    await runner.startGoal(goal.id);
    expect(store.getEvents(goal.id).some((e) => e.eventType === 'run_start')).toBe(false);

    store.updateStatus(goal.id, 'interrupted');
    expect(await runner.resume(goal.id)).toBe(false);
    expect(store.get(goal.id)?.status).toBe('interrupted');
  });

  it('resolves at once when nothing is running', async () => {
    const runner = new GoalRunner({ store, runAttempt: parkedTurn({ aborted: false }) });
    await expect(runner.shutdown()).resolves.toBeUndefined();
  });
});
