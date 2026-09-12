import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GOAL_EXECUTION_UNAVAILABLE,
  type LoopGoals,
  runGoalSlash,
  runGoalsSlash,
} from '../goal-slash';

// F05 follow-up (plan architecture-suggestions-2026-09-10) — `ethos chat`'s
// `/goal` opened its own SQLiteGoalStore and a GoalRunner with no
// `runAttempt`, so `/goal <text>` stored a `running` goal that nothing ever
// executed, and `/goal resume` flipped a goal back to `running` the same way.
// The handler now drives the store + executor pair the chat loop was built
// with, and refuses create/resume when that executor cannot run anything.

const c = { reset: '', dim: '', green: '', red: '', yellow: '' };

function executor(canExecute: boolean) {
  const calls = { started: [] as string[], resumed: [] as string[], cancelled: [] as string[] };
  return {
    calls,
    canExecute: () => canExecute,
    startGoal: async (id: string) => {
      calls.started.push(id);
    },
    steer: () => true,
    cancel: (id: string) => {
      calls.cancelled.push(id);
      return true;
    },
    resume: async (id: string) => {
      calls.resumed.push(id);
      return true;
    },
  };
}

describe('/goal in ethos chat', () => {
  let store: SQLiteGoalStore;
  let printed: string;
  const out = (s: string) => {
    printed += s;
  };

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
    printed = '';
  });

  afterEach(() => {
    store.close();
  });

  it('creates the goal in the injected store and starts THAT goal on the injected executor', async () => {
    const ex = executor(true);
    const goals: LoopGoals = { store, executor: ex };

    await runGoalSlash('Review this repository', { goals, personalityId: 'researcher', out, c });

    const [goal] = store.list();
    expect(goal?.goalText).toBe('Review this repository');
    expect(goal?.personalityId).toBe('researcher');
    expect(goal?.origin).toBe('cli');
    expect(ex.calls.started).toEqual([goal?.id]);
    expect(printed).toContain(`Goal created: ${goal?.id}`);
  });

  it('refuses create when the executor cannot execute, writing no row', async () => {
    const ex = executor(false);

    await runGoalSlash('Review this repository', {
      goals: { store, executor: ex },
      personalityId: 'researcher',
      out,
      c,
    });

    expect(store.list()).toEqual([]);
    expect(ex.calls.started).toEqual([]);
    expect(printed).toContain(GOAL_EXECUTION_UNAVAILABLE);
  });

  it('refuses resume when the executor cannot execute, leaving the goal as it was', async () => {
    const goal = store.create({
      userId: 'u',
      personalityId: 'p',
      origin: 'cli',
      title: 't',
      goalText: 'g',
    });
    store.updateStatus(goal.id, 'failed');
    const ex = executor(false);

    await runGoalSlash(`resume ${goal.id}`, {
      goals: { store, executor: ex },
      personalityId: 'p',
      out,
      c,
    });

    expect(ex.calls.resumed).toEqual([]);
    expect(store.get(goal.id)?.status).toBe('failed');
    expect(printed).toContain(GOAL_EXECUTION_UNAVAILABLE);
  });

  it('routes cancel to the injected executor', async () => {
    const ex = executor(true);
    await runGoalSlash('cancel g-1', {
      goals: { store, executor: ex },
      personalityId: 'p',
      out,
      c,
    });
    expect(ex.calls.cancelled).toEqual(['g-1']);
    expect(printed).toContain('Goal cancelled.');
  });

  it('/goals lists from the injected store', () => {
    store.create({
      userId: 'u',
      personalityId: 'p',
      origin: 'cli',
      title: 'Listed',
      goalText: 'g',
    });
    runGoalsSlash({ goals: { store, executor: executor(true) }, out, c });
    expect(printed).toContain('Listed');
  });
});

describe('chat.ts — /goal wiring', () => {
  it('drives the goal pair from resolveActiveLoop instead of building its own', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
    const chat = await readFile(join(root, 'apps/ethos/src/commands/chat.ts'), 'utf8');
    expect(chat).not.toMatch(/new (GoalRunner|SQLiteGoalStore)\b/);
    expect(chat).toContain('runGoalSlash(arg, {');
    expect(chat).toContain('goals: ctx.goals,');
    const wiring = await readFile(join(root, 'apps/ethos/src/wiring.ts'), 'utf8');
    // Both resolveActiveLoop branches (team + solo) forward the pair.
    expect(wiring).toContain('goals: teamResult.goals,');
    expect(wiring).toContain('goals: result.goals,');
  });
});
