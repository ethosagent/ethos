import type { GoalRunner } from '@ethosagent/goal-runner';
import type { SQLiteGoalStore } from '@ethosagent/goal-store';
import { describe, expect, it } from 'vitest';
import type { ComposeToolsResult } from '../compose-tools';
import type { CreateAgentLoopResult } from '../index';

// Regression: web-created goals never executed for a personality whose toolset
// lacked goal_* tools, because compose-tools only built the shared goalStore
// when the personality exposed goal_* tools. No store → build-agent-loop never
// built the loop-bearing GoalRunner → GoalsService fell back to a loop-less
// runner → web goals sat in `running` forever.
//
// The fix makes the goalStore (and therefore the loop-bearing runner) shared
// infrastructure that exists for ANY personality; only the agent-facing goal_*
// tool *registration* stays gated by the toolset. These type-level assertions
// lock that invariant at the contract surface: if either field is loosened back
// to optional (the shape that allowed the toolset gate to skip construction),
// this test stops compiling.

/** Compile-time assertion that `T` is exactly `Expected` (no `| undefined`). */
type Exact<T, Expected> = [T] extends [Expected] ? ([Expected] extends [T] ? true : false) : false;

describe('goal store is always wired (toolset-independent)', () => {
  it('ComposeToolsResult.goalStore is required (not gated by toolset)', () => {
    const goalStoreIsRequired: Exact<ComposeToolsResult['goalStore'], SQLiteGoalStore> = true;
    expect(goalStoreIsRequired).toBe(true);
  });

  it('CreateAgentLoopResult.goalRunner is required (loop-bearing runner always built)', () => {
    const goalRunnerIsRequired: Exact<CreateAgentLoopResult['goalRunner'], GoalRunner> = true;
    expect(goalRunnerIsRequired).toBe(true);
  });
});
