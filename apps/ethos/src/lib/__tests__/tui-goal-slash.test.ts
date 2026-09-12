import { SQLiteGoalStore } from '@ethosagent/goal-store';
import { describe, expect, it } from 'vitest';
import { GOAL_EXECUTION_UNAVAILABLE, type LoopGoals } from '../goal-slash';
import { makeTuiSlashCommands } from '../tui-capabilities';

// An interactive `ethos chat` on a TTY runs the TUI, and the TUI had no goal
// case at all — so `/goal` and `/goals` only ever worked in the non-TTY
// readline fallback. They go through the TUI's external-slash seam now, driving
// the same handler (lib/goal-slash.ts) with the same refusal.

function pair(canExecute: boolean): LoopGoals & { started: string[]; store: SQLiteGoalStore } {
  const started: string[] = [];
  return {
    started,
    store: new SQLiteGoalStore(':memory:'),
    executor: {
      canExecute: () => canExecute,
      startGoal: async (id) => {
        started.push(id);
      },
      steer: () => true,
      cancel: () => true,
      resume: async () => true,
    },
  };
}

const ctx = { sessionKey: 'cli:test', personalityId: 'researcher' };

describe('TUI slash commands — goals', () => {
  it('creates a goal on the loop’s pair and reports it', async () => {
    const goals = pair(true);
    const commands = makeTuiSlashCommands(undefined, goals);

    const out = await commands.dispatch('goal', 'Review this repository', ctx);

    const [goal] = goals.store.list();
    expect(goal?.goalText).toBe('Review this repository');
    expect(goal?.personalityId).toBe('researcher');
    expect(goals.started).toEqual([goal?.id]);
    expect(out).toContain(`Goal created: ${goal?.id}`);
    goals.store.close();
  });

  it('refuses when nothing can run the goal, writing no row', async () => {
    const goals = pair(false);
    const commands = makeTuiSlashCommands(undefined, goals);

    const out = await commands.dispatch('goal', 'Review this repository', ctx);

    expect(out).toContain(GOAL_EXECUTION_UNAVAILABLE);
    expect(goals.store.list()).toEqual([]);
    expect(goals.started).toEqual([]);
    goals.store.close();
  });

  it('lists recent goals for /goals', async () => {
    const goals = pair(true);
    goals.store.create({
      userId: 'u',
      personalityId: 'researcher',
      origin: 'cli',
      title: 'Listed goal',
      goalText: 'g',
    });
    const commands = makeTuiSlashCommands(undefined, goals);

    const out = await commands.dispatch('goals', '', ctx);

    expect(out).toContain('Listed goal');
    goals.store.close();
  });

  it('still declines commands it does not handle', async () => {
    const commands = makeTuiSlashCommands(undefined, pair(true));
    expect(await commands.dispatch('nope', '', ctx)).toBeNull();
  });
});
