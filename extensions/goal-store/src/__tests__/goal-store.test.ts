import { describe, expect, it } from 'vitest';
import { SQLiteGoalStore } from '../index';

describe('SQLiteGoalStore — maxToolCallsPerTurn', () => {
  it('round-trips maxToolCallsPerTurn through create/get', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      maxToolCallsPerTurn: 50,
    });

    const fetched = store.get(goal.id);
    expect(fetched?.maxToolCallsPerTurn).toBe(50);
  });

  it('yields undefined when maxToolCallsPerTurn is absent', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });

    const fetched = store.get(goal.id);
    expect(fetched?.maxToolCallsPerTurn).toBeUndefined();
  });
});

describe('SQLiteGoalStore — maxRecoveryAttempts', () => {
  it('round-trips maxRecoveryAttempts through create/get', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      maxRecoveryAttempts: 5,
    });

    const fetched = store.get(goal.id);
    expect(fetched?.maxRecoveryAttempts).toBe(5);
  });

  it('yields undefined when maxRecoveryAttempts is absent', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });

    const fetched = store.get(goal.id);
    expect(fetched?.maxRecoveryAttempts).toBeUndefined();
  });
});

describe('SQLiteGoalStore — allowDangerousToolCalls', () => {
  it('round-trips allowDangerousToolCalls=true through create/get', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      allowDangerousToolCalls: true,
    });

    const fetched = store.get(goal.id);
    expect(fetched?.allowDangerousToolCalls).toBe(true);
  });

  it('defaults to false when allowDangerousToolCalls is absent', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });

    const fetched = store.get(goal.id);
    expect(fetched?.allowDangerousToolCalls).toBe(false);
  });
});
