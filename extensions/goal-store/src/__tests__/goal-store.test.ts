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

describe('SQLiteGoalStore — planMd', () => {
  it('defaults planMd to null on a freshly created goal', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });

    expect(store.get(goal.id)?.planMd).toBeNull();
  });

  it('round-trips planMd through updateStatus/get', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });

    store.updateStatus(goal.id, 'running', { planMd: '## Plan\n1. Do X\n2. Do Y' });

    expect(store.get(goal.id)?.planMd).toBe('## Plan\n1. Do X\n2. Do Y');
  });
});

describe('SQLiteGoalStore — maxIdenticalToolCalls', () => {
  it('round-trips maxIdenticalToolCalls through create/get', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      maxIdenticalToolCalls: 30,
    });

    const fetched = store.get(goal.id);
    expect(fetched?.maxIdenticalToolCalls).toBe(30);
  });

  it('yields undefined when maxIdenticalToolCalls is absent', () => {
    const store = new SQLiteGoalStore(':memory:');
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });

    const fetched = store.get(goal.id);
    expect(fetched?.maxIdenticalToolCalls).toBeUndefined();
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
