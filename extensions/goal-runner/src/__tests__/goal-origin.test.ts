// plan personality-memory-boundary step 5 — a goal has no audience column; the
// wiring derives it from `Goal.origin` (`goalRoomAudience`,
// packages/wiring/src/goal-audience.ts), so the runner must hand the origin to
// both the planning turn and every attempt.

import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { GoalRunner } from '../index';

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
}

function done(): AsyncGenerator<AgentEvent> {
  return (async function* () {
    yield { type: 'done', text: 'done', turnCount: 1 } as AgentEvent;
  })();
}

describe('GoalRunner — goal origin reaches the turn callbacks', () => {
  it('passes Goal.origin to runPlan and runAttempt', async () => {
    const store = new SQLiteGoalStore(':memory:');
    const seen: Array<{ phase: string; origin?: string }> = [];
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'telegram:-100200',
      title: 'Group goal',
      goalText: 'Do the thing',
    });
    const runner = new GoalRunner({
      store,
      runPlan: (_k, _m, o) => {
        seen.push({ phase: 'plan', ...(o.origin !== undefined ? { origin: o.origin } : {}) });
        return done();
      },
      runAttempt: (_k, _m, o) => {
        seen.push({ phase: 'attempt', ...(o.origin !== undefined ? { origin: o.origin } : {}) });
        return done();
      },
    });
    await runner.startGoal(goal.id);
    await waitFor(() => store.get(goal.id)?.status === 'completed');
    expect(seen).toContainEqual({ phase: 'plan', origin: 'telegram:-100200' });
    expect(seen).toContainEqual({ phase: 'attempt', origin: 'telegram:-100200' });
  });
});
