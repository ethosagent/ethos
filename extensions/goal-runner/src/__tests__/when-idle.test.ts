import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { GoalRunner } from '../index';

// F06 follow-up — a host retiring a loop it replaced (the chat `/model`
// switch) waits for the goal runs still going on it to FINISH, rather than
// aborting them through `shutdown()`.
describe('GoalRunner.whenIdle (F06)', () => {
  it('resolves only once the in-flight goal run has finished, and aborts nothing', async () => {
    const store = new SQLiteGoalStore(':memory:');
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    let aborted = false;
    const runner = new GoalRunner({
      store,
      runAttempt: async function* (_sk, _fm, opts): AsyncGenerator<AgentEvent> {
        opts.abortSignal.addEventListener('abort', () => {
          aborted = true;
        });
        await gate;
        yield { type: 'done', text: 'result', turnCount: 1 };
      },
    });
    const goal = store.create({
      userId: 'u',
      personalityId: 'p',
      origin: 'cli',
      title: 't',
      goalText: 'do it',
    });
    await runner.startGoal(goal.id);

    let idle = false;
    const waiting = runner.whenIdle().then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(idle).toBe(false);

    finish?.();
    await waiting;
    expect(aborted).toBe(false);
    expect(store.get(goal.id)?.status).toBe('completed');
    await runner.shutdown();
    store.close();
  });

  it('resolves at once when nothing runs', async () => {
    const store = new SQLiteGoalStore(':memory:');
    const runner = new GoalRunner({ store });
    await expect(runner.whenIdle()).resolves.toBeUndefined();
    store.close();
  });
});
