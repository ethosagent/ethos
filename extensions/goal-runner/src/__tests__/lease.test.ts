import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent, GoalStore } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalRunner } from '../index';

// F05 follow-up — ownership lease. `buildAgentLoop` calls `recoverOrphans()`
// on every loop it builds. Before the lease that interrupted every active goal
// in the shared goals.db this runner was not itself executing — so `ethos chat`
// started beside a live `ethos serve`, or a second loop built in the same
// process, killed goals another live runner was mid-way through. A runner now
// leases each goal it executes and heartbeats it; recovery only takes goals
// whose lease went quiet.

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** A turn that parks until aborted, then ends the way AgentLoop does. */
async function* parkedTurn(
  _sk: string,
  _fm: string,
  opts: { abortSignal: AbortSignal },
): AsyncGenerator<AgentEvent> {
  yield { type: 'text_delta', text: 'working' };
  await waitForAbort(opts.abortSignal);
  yield { type: 'error', error: 'Aborted', code: 'aborted' };
}

async function waitForStatus(store: GoalStore, id: string, status: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (store.get(id)?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`goal ${id} never reached "${status}"`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeGoal(store: GoalStore) {
  return store.create({
    userId: 'u',
    personalityId: 'p',
    origin: 'cli',
    title: 't',
    goalText: 'g',
  });
}

describe('GoalRunner — ownership lease', () => {
  let store: SQLiteGoalStore;
  const runners: GoalRunner[] = [];

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  afterEach(async () => {
    for (const r of runners.splice(0)) await r.shutdown();
    vi.restoreAllMocks();
    store.close();
  });

  function runner(opts: { heartbeatMs?: number; staleMs?: number } = {}) {
    const r = new GoalRunner({ store, runAttempt: parkedTurn, ...opts });
    runners.push(r);
    return r;
  }

  it("a second runner's recoverOrphans leaves a goal the first runner is executing running", async () => {
    const a = runner({ heartbeatMs: 10 });
    const goal = makeGoal(store);
    await a.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'running');

    // Past B's stale threshold several times over: only A's heartbeats keep it.
    await sleep(120);
    const b = runner({ staleMs: 50 });
    b.recoverOrphans();

    expect(store.get(goal.id)?.status).toBe('running');
  });

  it('interrupts a goal whose owner stopped heartbeating', async () => {
    const goal = makeGoal(store);
    // Claimed by a runner that then died without a graceful shutdown.
    store.claimGoal(goal.id, 'dead-runner');

    await sleep(80);
    runner({ staleMs: 50 }).recoverOrphans();

    expect(store.get(goal.id)?.status).toBe('interrupted');
  });

  it('leaves a just-created goal no runner has claimed yet (create → startGoal window)', () => {
    const goal = makeGoal(store);
    runner({ staleMs: 50 }).recoverOrphans();
    expect(store.get(goal.id)?.status).toBe('running');
  });

  it('stops heartbeating once shutdown() resolves', async () => {
    const a = runner({ heartbeatMs: 10 });
    const beats = vi.spyOn(store, 'heartbeatGoal');
    const goal = makeGoal(store);
    await a.startGoal(goal.id);
    await sleep(50);
    expect(beats).toHaveBeenCalled();

    await a.shutdown();
    const afterShutdown = beats.mock.calls.length;
    await sleep(50);
    expect(beats.mock.calls.length).toBe(afterShutdown);
  });
});

describe('GoalRunner.canExecute after shutdown', () => {
  it('reports false once shutdown() has been called, so hosts refuse instead of writing a row', async () => {
    const store = new SQLiteGoalStore(':memory:');
    const r = new GoalRunner({ store, runAttempt: parkedTurn });
    expect(r.canExecute()).toBe(true);
    await r.shutdown();
    expect(r.canExecute()).toBe(false);
    store.close();
  });
});

// Two processes resuming the same goal: resume used to read the status, then
// write it, so a second process that read before the first one wrote resumed
// it too — two runs on one goal. The claim is now one conditional UPDATE
// (`LeasedGoalStore.resumeGoal`): only from a resumable status, so exactly one
// resumer wins and the other refuses at once.
describe('GoalRunner.resume across processes', () => {
  it('lets exactly one of two runners resume the same goal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-resume-race-'));
    const path = join(dir, 'goals.db');
    const storeA = new SQLiteGoalStore(path);
    const storeB = new SQLiteGoalStore(path);
    const goal = makeGoal(storeA);
    storeA.updateStatus(goal.id, 'failed');
    const a = new GoalRunner({ store: storeA, runAttempt: parkedTurn });
    const b = new GoalRunner({ store: storeB, runAttempt: parkedTurn });

    // B read the goal before A's resume landed — the interleaving two
    // processes can produce.
    const stale = storeB.get(goal.id);
    const realGet = storeB.get.bind(storeB);
    let first = true;
    vi.spyOn(storeB, 'get').mockImplementation((id: string) => {
      if (first && id === goal.id) {
        first = false;
        return stale;
      }
      return realGet(id);
    });

    const resumedA = await a.resume(goal.id);
    const resumedB = await b.resume(goal.id);

    expect([resumedA, resumedB]).toEqual([true, false]);
    expect(storeA.get(goal.id)?.resumeCount).toBe(1);
    await a.shutdown();
    await b.shutdown();
    storeA.close();
    storeB.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// A store error on the boundary check used to end the run silently: the
// `endIfStopped` heartbeat threw (a peer's write lock, before goals.db had a
// busy timeout), `track()`'s catch swallowed it, `runAttempt` was never called
// and the goal sat `running` — not even `shutdown()` moved it. A beat that
// cannot be written only ages the lease, which is what `beat()` has always
// done; the stale sweep is the backstop.
describe('GoalRunner — a heartbeat the store refuses', () => {
  it('keeps the run going instead of stranding the goal as running', async () => {
    const store = new SQLiteGoalStore(':memory:');
    const busy = () => {
      const err = new Error('database is locked') as Error & { code?: string };
      err.code = 'SQLITE_BUSY';
      throw err;
    };
    let refuse = false;
    const flaky = new Proxy(store, {
      get(target, prop: string) {
        const value = (target as unknown as Record<string, unknown>)[prop];
        if (typeof value !== 'function') return value;
        if (prop === 'heartbeatGoal') {
          return (...args: unknown[]) =>
            refuse ? busy() : (value as (...a: unknown[]) => unknown).apply(target, args);
        }
        return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
      },
    }) as unknown as SQLiteGoalStore;

    let attempts = 0;
    const runner = new GoalRunner({
      store: flaky,
      heartbeatMs: 10,
      runAttempt: () =>
        (async function* (): AsyncGenerator<AgentEvent> {
          attempts++;
          yield { type: 'done', text: 'output', turnCount: 1 };
        })(),
    });
    const goal = makeGoal(store);
    refuse = true;
    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(attempts).toBe(1);
    await runner.shutdown();
    expect(store.get(goal.id)?.status).toBe('completed');
    store.close();
  });
});
