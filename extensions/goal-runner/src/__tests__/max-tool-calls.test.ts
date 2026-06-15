import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent, GoalStore } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { GoalRunner, type GoalRunnerConfig } from '../index';

async function waitForStatus(
  store: GoalStore,
  id: string,
  status: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const goal = store.get(id);
    if (goal?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for goal ${id} to reach status "${status}"`);
}

describe('GoalRunner — maxToolCallsPerTurn passthrough', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  it('threads the goal maxToolCallsPerTurn into runAttempt opts', async () => {
    let capturedOpts: { maxToolCallsPerTurn?: number } | undefined;
    const capturingRunAttempt = (
      _sessionKey: string,
      _firstMessage: string,
      opts: { maxToolCallsPerTurn?: number },
    ): AsyncGenerator<AgentEvent> => {
      capturedOpts = opts;
      return (async function* () {
        yield { type: 'done', text: 'done', turnCount: 1 } as AgentEvent;
      })();
    };

    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      maxToolCallsPerTurn: 42,
    });

    const runner = new GoalRunner({
      store,
      runAttempt: capturingRunAttempt as GoalRunnerConfig['runAttempt'],
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(capturedOpts?.maxToolCallsPerTurn).toBe(42);
  });
});
