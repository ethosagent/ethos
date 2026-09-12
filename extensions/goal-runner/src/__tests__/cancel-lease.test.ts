import { DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent, GoalStore } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalRunner } from '../index';

// F05 follow-up — cancel across runners. A cancel from another process (or
// another loop in this one) used to set `cancelled` in the store while the
// owning runner's run kept going — spending, and later overwriting `cancelled`
// with whatever it finished as. The owner now observes the cancel through its
// lease (each heartbeat, and each attempt/phase boundary), aborts the run, and
// never writes over `cancelled`.

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
    yield { type: 'text_delta', text: 'working' };
    await waitForAbort(opts.abortSignal);
    seen.aborted = true;
    yield { type: 'error', error: 'Aborted', code: 'aborted' };
  };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function makeGoal(store: GoalStore) {
  return store.create({
    userId: 'u',
    personalityId: 'p',
    origin: 'cli',
    title: 't',
    goalText: 'g',
  });
}

describe('GoalRunner — cancel observed through the lease', () => {
  let store: SQLiteGoalStore;
  const runners: GoalRunner[] = [];

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  afterEach(async () => {
    for (const r of runners.splice(0)) await r.shutdown();
    store.close();
  });

  it("runner B cancelling runner A's live goal aborts A's run within a heartbeat, and it stays cancelled", async () => {
    const hooks = new DefaultHookRegistry();
    const failed = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', failed);
    const seen = { aborted: false };
    const a = new GoalRunner({ store, hooks, runAttempt: parkedTurn(seen), heartbeatMs: 10 });
    const b = new GoalRunner({ store, runAttempt: parkedTurn({ aborted: false }) });
    runners.push(a, b);

    const goal = makeGoal(store);
    await a.startGoal(goal.id);
    // Let the attempt start and A beat a few times.
    await new Promise((r) => setTimeout(r, 30));

    // B holds no run for this goal; the cancel lands in the store only.
    expect(b.cancel(goal.id)).toBe(true);

    await waitFor(() => seen.aborted, "A's run to abort");
    // Let A's run unwind completely, past several more heartbeats.
    await new Promise((r) => setTimeout(r, 60));

    expect(store.get(goal.id)?.status).toBe('cancelled');
    expect(failed).not.toHaveBeenCalled();
  });

  it('a local cancel mid-attempt stays cancelled once the aborted turn unwinds', async () => {
    const hooks = new DefaultHookRegistry();
    const failed = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', failed);
    const seen = { aborted: false };
    const a = new GoalRunner({ store, hooks, runAttempt: parkedTurn(seen) });
    runners.push(a);

    const goal = makeGoal(store);
    await a.startGoal(goal.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(a.cancel(goal.id)).toBe(true);

    await waitFor(() => seen.aborted, 'the run to abort');
    await new Promise((r) => setTimeout(r, 30));

    expect(store.get(goal.id)?.status).toBe('cancelled');
    expect(failed).not.toHaveBeenCalled();
  });
});

// Final-pass verifier repro (scratchpad final-f04f05/d/race.ts), ported. The
// lease used to be per RUNNER, so after cancel → resume on the same runner the
// cancelled run, still unwinding, passed the lease checks as if it were the
// new run: it wrote `failed` over the resumed goal, fired `goal_failed`, and
// deleted the NEW run's controller from activeRuns — leaving that run with no
// heartbeat, uncancellable, and `shutdown()` waiting on it forever.
describe('GoalRunner — cancel then resume on the same runner', () => {
  it('the superseded run stands down without touching the resumed run', async () => {
    const store = new SQLiteGoalStore(':memory:');
    const hooks = new DefaultHookRegistry();
    const failed = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', failed);
    let calls = 0;
    let run2Aborted = false;
    const runner = new GoalRunner({
      store,
      hooks,
      heartbeatMs: 10,
      runAttempt: (_sk, _m, o) =>
        (async function* (): AsyncGenerator<AgentEvent> {
          const me = ++calls;
          yield { type: 'text_delta', text: `run${me}` };
          await waitForAbort(o.abortSignal);
          // Run 1 unwinds slowly — long after the resume has started run 2.
          if (me === 1) await new Promise((r) => setTimeout(r, 100));
          else run2Aborted = true;
          yield { type: 'error', error: 'Aborted', code: 'aborted' };
        })(),
    });
    const goal = makeGoal(store);

    await runner.startGoal(goal.id);
    await waitFor(() => calls === 1, 'run 1');
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.cancel(goal.id)).toBe(true);
    expect(await runner.resume(goal.id)).toBe(true);
    await waitFor(() => calls === 2, 'run 2');
    await new Promise((r) => setTimeout(r, 300)); // run 1 has fully unwound

    expect(store.get(goal.id)?.status).toBe('running');
    expect(run2Aborted).toBe(false);
    expect(failed).not.toHaveBeenCalled();

    // Run 2 is still the goal's run: cancellable, and shutdown can finish.
    expect(runner.cancel(goal.id)).toBe(true);
    await waitFor(() => run2Aborted, 'run 2 to abort');
    const settled = await Promise.race([
      runner.shutdown().then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    expect(settled).toBe('resolved');
    store.close();
  });

  it('shutdown aborts a run no longer in activeRuns instead of waiting on it forever', async () => {
    const store = new SQLiteGoalStore(':memory:');
    let unwound = false;
    const runner = new GoalRunner({
      store,
      runAttempt: (_sk, _m, o) =>
        (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text_delta', text: 'working' };
          await waitForAbort(o.abortSignal);
          unwound = true;
          yield { type: 'error', error: 'Aborted', code: 'aborted' };
        })(),
    });
    const goal = makeGoal(store);
    await runner.startGoal(goal.id);
    await new Promise((r) => setTimeout(r, 20));
    // Drop the bookkeeping the way a superseded run's cleanup used to.
    (runner as unknown as { activeRuns: Map<string, unknown> }).activeRuns.clear();

    const settled = await Promise.race([
      runner.shutdown().then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    expect(settled).toBe('resolved');
    expect(unwound).toBe(true);
    store.close();
  });
});
