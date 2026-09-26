// Early exhaustion ("plateau") — `isPlateau` in ../index.ts. It used to compare
// `attempts.slice(-2)` against the current verdict, but `attempts` is read
// after the current verdict is persisted, so the slice held the current
// attempt itself: ANY non-improving second attempt exhausted a 3-attempt goal
// (g_a2d7260303f34059 went `exhausted` after attempt 2 of 3 with scores 0, 0).
// Plateau now means two consecutive non-improvements, and substring-fallback
// verdicts never count.

import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AcceptanceSpec, AgentEvent, GoalStore } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalRunner } from '../index';

/** One attempt per call; attempt i finishes with `outputs[i]` (last repeats). */
function attemptsWithOutputs(outputs: string[]) {
  let call = 0;
  return async function* (): AsyncGenerator<AgentEvent> {
    const text = outputs[call] ?? outputs[outputs.length - 1] ?? '';
    call++;
    yield { type: 'done', text, turnCount: 1 };
  };
}

async function waitForTerminal(store: GoalStore, id: string, timeoutMs = 3000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = store.get(id)?.status;
    if (status === 'exhausted' || status === 'completed' || status === 'failed') return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for goal ${id} to finish`);
}

function makeGoal(store: GoalStore, spec: AcceptanceSpec, maxAttempts: number) {
  return store.create({
    userId: 'user-1',
    personalityId: 'tester',
    origin: 'cli',
    title: 'Plateau goal',
    goalText: 'Do the thing',
    acceptanceCriteria: spec,
    maxAttempts,
  });
}

/** Rubric-only spec: the placeholder rubric scores 0.5 for non-empty output
 *  and 0 for empty output, below the 0.8 threshold either way. */
const rubricSpec: AcceptanceSpec = {
  checks: [],
  rubric: [{ id: 'r1', description: 'quality', weight: 1 }],
  threshold: 0.8,
};

const checkSpec: AcceptanceSpec = {
  checks: [{ id: 'c1', description: 'All CSV symbols are in the database' }],
  rubric: [],
  threshold: 0.8,
};

function scores(store: GoalStore, id: string): number[] {
  return store.getAttempts(id).map((a) => a.verdict?.score ?? Number.NaN);
}

describe('goal plateau (early exhaustion)', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  it('gives a 3-attempt goal scoring 0, 0 its third attempt', async () => {
    const goal = makeGoal(store, checkSpec, 3);
    const judgeCheck = vi.fn().mockResolvedValue({ pass: false, evidence: 'no rows shown' });
    const runner = new GoalRunner({
      store,
      judgeCheck,
      runAttempt: attemptsWithOutputs(['working on it']),
    });

    await runner.startGoal(goal.id);
    expect(await waitForTerminal(store, goal.id)).toBe('exhausted');

    expect(scores(store, goal.id)).toEqual([0, 0, 0]);
    expect(judgeCheck).toHaveBeenCalledTimes(3);
  });

  it('exhausts after the third attempt when scores stay 0.5, 0.5, 0.5', async () => {
    // maxAttempts 5, so the stop at 3 is the plateau, not the attempt cap.
    const goal = makeGoal(store, rubricSpec, 5);
    const runner = new GoalRunner({ store, runAttempt: attemptsWithOutputs(['some output']) });

    await runner.startGoal(goal.id);
    expect(await waitForTerminal(store, goal.id)).toBe('exhausted');

    expect(scores(store, goal.id)).toEqual([0.5, 0.5, 0.5]);
  });

  it('keeps going while scores improve', async () => {
    // 0, 0, 0.5, 0.5 — attempt 3 improved on both before it, attempt 4 did not
    // regress below attempt 2 — so only the attempt cap stops it.
    const goal = makeGoal(store, rubricSpec, 4);
    const runner = new GoalRunner({ store, runAttempt: attemptsWithOutputs(['', '', 'better']) });

    await runner.startGoal(goal.id);
    expect(await waitForTerminal(store, goal.id)).toBe('exhausted');

    expect(scores(store, goal.id)).toEqual([0, 0, 0.5, 0.5]);
  });

  it('never plateaus on substring-fallback verdicts', async () => {
    // No judgeCheck → the command-less check is settled by the substring
    // fallback, whose flat 0 says nothing about progress.
    const goal = makeGoal(store, checkSpec, 5);
    const runner = new GoalRunner({ store, runAttempt: attemptsWithOutputs(['working on it']) });

    await runner.startGoal(goal.id);
    expect(await waitForTerminal(store, goal.id)).toBe('exhausted');

    const attempts = store.getAttempts(goal.id);
    expect(attempts).toHaveLength(5);
    expect(attempts.every((a) => a.verdict?.perCriterion[0]?.method === 'substring')).toBe(true);
  });
});
