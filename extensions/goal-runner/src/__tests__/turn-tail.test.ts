// F07 (plan/phases/architecture-suggestions-2026-09-10.md). `runPlan` and
// `runAttempt` are `AgentLoop.run()` (packages/wiring/src/build-agent-loop.ts),
// which yields `error` BEFORE its usage flush and trace close and `done` BEFORE
// its turn-end work. The runner used to `return` (planning, non-transient
// attempt error) or `break` (transient attempt error) inside the `for await`,
// which closes the generator and skips that work. It now drains first.

import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent, GoalStore } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { GoalRunner, type GoalRunnerConfig } from '../index';

async function waitForStatus(store: GoalStore, id: string, status: string): Promise<void> {
  const start = Date.now();
  while (store.get(id)?.status !== status) {
    if (Date.now() - start > 2000) throw new Error(`goal ${id} never reached "${status}"`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Each call yields its scripted events, then runs a tail only a draining
 * consumer reaches. `log` records the order runs start and tails finish.
 */
function tailedRuns(perRun: AgentEvent[][]) {
  const log: string[] = [];
  let n = 0;
  const fn = (): AsyncGenerator<AgentEvent> => {
    const i = ++n;
    const events = perRun[i - 1] ?? perRun[perRun.length - 1] ?? [];
    return (async function* () {
      log.push(`run ${i}`);
      for (const event of events) yield event;
      await new Promise((r) => setTimeout(r, 5));
      log.push(`tail ${i}`);
    })();
  };
  return { fn, log };
}

describe('GoalRunner drains AgentLoop past its terminal event (F07)', () => {
  let store: SQLiteGoalStore;
  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  function makeGoal() {
    return store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });
  }

  it('a planning error fails the goal only after the planning turn has drained', async () => {
    const plan = tailedRuns([[{ type: 'error', error: 'boom', code: 'execution_failed' }]]);
    const attempt = tailedRuns([[{ type: 'done', text: 'never', turnCount: 1 }]]);
    const goal = makeGoal();
    const runner = new GoalRunner({
      store,
      runPlan: plan.fn as GoalRunnerConfig['runPlan'],
      runAttempt: attempt.fn as GoalRunnerConfig['runAttempt'],
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    expect(plan.log).toEqual(['run 1', 'tail 1']);
    expect(store.get(goal.id)?.errorText).toBe('Planning failed: boom');
    // No plan, no execution.
    expect(attempt.log).toEqual([]);
  });

  it('a non-transient attempt error fails the goal only after the attempt has drained', async () => {
    const attempt = tailedRuns([[{ type: 'error', error: 'boom', code: 'execution_failed' }]]);
    const goal = makeGoal();
    const runner = new GoalRunner({
      store,
      runAttempt: attempt.fn as GoalRunnerConfig['runAttempt'],
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    expect(attempt.log).toEqual(['run 1', 'tail 1']);
    expect(store.get(goal.id)?.errorText).toBe('boom');
  });

  it('a transient retry starts on the same session only after the failed run has drained', async () => {
    const attempt = tailedRuns([
      [{ type: 'error', error: 'Rate limit exceeded (429)', code: 'llm_error' }],
      [{ type: 'done', text: 'finished after retry', turnCount: 1 }],
    ]);
    const goal = makeGoal();
    const runner = new GoalRunner({
      store,
      runAttempt: attempt.fn as GoalRunnerConfig['runAttempt'],
      sleepFn: async () => {},
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(attempt.log).toEqual(['run 1', 'tail 1', 'run 2', 'tail 2']);
    expect(store.get(goal.id)?.outputMd).toBe('finished after retry');
  });
});
