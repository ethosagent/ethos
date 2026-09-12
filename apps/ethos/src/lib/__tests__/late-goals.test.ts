import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import { describe, expect, it } from 'vitest';
import { createLateBoundGoals } from '../late-goals';

// F05 follow-up — onboarding-mode `ethos serve` builds its web API before any
// loop exists, so it had no goal pair to hand over, and web goal creation was
// refused even after onboarding booted the real loop in-process — until a
// restart. The late-bound pair reads empty and cannot execute until the booted
// loop's own pair is bound into it, then delegates to exactly that pair.

function executor(canExecute: boolean) {
  const started: string[] = [];
  return {
    started,
    canExecute: () => canExecute,
    startGoal: async (id: string) => {
      started.push(id);
    },
    steer: () => true,
    cancel: () => true,
    resume: async () => true,
  };
}

describe('createLateBoundGoals', () => {
  it('cannot execute and reads empty before the loop boots', () => {
    const late = createLateBoundGoals();
    expect(late.goals.executor.canExecute()).toBe(false);
    expect(late.goals.store.list()).toEqual([]);
    expect(late.goals.store.get('g_x')).toBeNull();
    expect(late.goals.store.getEvents('g_x')).toEqual([]);
    expect(late.goals.executor.cancel('g_x')).toBe(false);
  });

  it("delegates to the booted loop's pair once bound", async () => {
    const store = new SQLiteGoalStore(':memory:');
    const ex = executor(true);
    const late = createLateBoundGoals();
    late.bind({ store, executor: ex });

    expect(late.goals.executor.canExecute()).toBe(true);
    const goal = late.goals.store.create({
      userId: 'u',
      personalityId: 'p',
      origin: 'web',
      title: 't',
      goalText: 'g',
    });
    await late.goals.executor.startGoal(goal.id);

    expect(store.get(goal.id)?.goalText).toBe('g');
    expect(ex.started).toEqual([goal.id]);
    expect(late.goals.store.list().map((g) => g.id)).toEqual([goal.id]);
    store.close();
  });

  it("follows the bound executor's own availability (e.g. after its shutdown)", () => {
    const late = createLateBoundGoals();
    late.bind({ store: new SQLiteGoalStore(':memory:'), executor: executor(false) });
    expect(late.goals.executor.canExecute()).toBe(false);
  });
});

describe('serve.ts onboarding branch — goal pair', () => {
  it('hands the web API the late-bound pair and binds the booted loop into it', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
    const src = await readFile(join(root, 'apps/ethos/src/commands/serve.ts'), 'utf8');
    expect(src).toContain('const lateGoals = createLateBoundGoals();');
    // Bound (and on failure unbound) by adoptBootedLoop — lib/onboarding-boot.ts.
    expect(src).toMatch(/adoptBootedLoop\(agentResult, \{\s*goals: lateGoals,/);
    expect(src).toContain('goals: lateGoals.goals,');
  });
});

describe('createLateBoundGoals — unbind', () => {
  it('returns to "not booted" after a failed adoption', () => {
    const late = createLateBoundGoals();
    late.bind({ store: new SQLiteGoalStore(':memory:'), executor: executor(true) });
    late.unbind();
    expect(late.goals.executor.canExecute()).toBe(false);
    expect(late.goals.store.list()).toEqual([]);
  });
});
