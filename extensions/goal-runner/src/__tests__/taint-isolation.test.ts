// V3-1 — a goal run is DETACHED from the tool call that started it.
//
// `goal_create` calls `GoalRunner.startGoal` from inside a tool call, and the
// run it launches is fire-and-forget: its answer never flows back into that
// call. Launched in the call's async context, every attempt's `loop.run()`
// inherited the batch's run-taint link (packages/core/src/scoped/run-taint.ts)
// for as long as the batch stayed open — starting armed when a sibling call had
// tainted the run, and tainting it in turn. `GoalRunner.detached` (../index.ts)
// launches the run in the runner's construction context instead.

import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  activeRunTaint,
  type RunTaintLink,
  withRunTaint,
} from '../../../../packages/core/src/scoped/run-taint';
import { GoalRunner } from '../index';

describe('V3-1 — GoalRunner launches runs outside the caller’s async context', () => {
  for (const via of ['startGoal', 'resume'] as const) {
    it(`an attempt launched by ${via} from inside a tainted open link sees no link`, async () => {
      const store = new SQLiteGoalStore(':memory:');
      const seen: Array<RunTaintLink | undefined> = [];
      const runner = new GoalRunner({
        store,
        runAttempt: async function* (): AsyncGenerator<AgentEvent> {
          seen.push(activeRunTaint());
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
      if (via === 'resume') store.updateStatus(goal.id, 'interrupted');

      const link: RunTaintLink = { state: { untrustedSeen: true }, open: true, mark: () => {} };
      await withRunTaint(link, async () => {
        if (via === 'startGoal') await runner.startGoal(goal.id);
        else expect(await runner.resume(goal.id)).toBe(true);
        // The link stays open until the run has finished, as a long batch would.
        await runner.whenIdle();
      });
      await runner.shutdown();
      store.close();
      expect(seen).toEqual([undefined]);
    });
  }
});
