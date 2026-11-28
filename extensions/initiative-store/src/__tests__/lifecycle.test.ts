import { describe, expect, it } from 'vitest';
import { SQLiteInitiativeStore } from '../index';

function open() {
  const store = new SQLiteInitiativeStore(':memory:', {
    now: () => Date.parse('2026-11-28T10:00:00Z'),
  });
  store.upsertInitiative({
    id: 'ini-1',
    personalityId: 'ada',
    origin: 'human',
    parentId: null,
    state: 'active',
    configPath: 'initiatives/ini-1.yaml',
    configHash: 'h',
    version: 1,
  });
  return store;
}

describe('extendExploration', () => {
  it('gives a reopened exploration spent + the new budget and a new deadline', () => {
    const store = open();
    const e = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 0.5,
      days: 1,
    });
    store.transitionExploration(e.id, 'exploring', 'go');
    const w = store.openWindow({ initiativeId: 'ini-1', explorationId: e.id, kind: 'window' });
    store.closeWindow(w, {
      spentUsd: 0.5,
      toolsUsed: [],
      reads: [],
      checkpoint: null,
      endReason: 'exploration',
    });

    const next = store.extendExploration(e.id, {
      addBudgetUsd: 1,
      deadline: '2026-12-05T10:00:00.000Z',
    });
    expect(next.budgetUsd).toBeCloseTo(1.5, 5);
    expect(next.spentUsd).toBeCloseTo(0.5, 5);
    expect(next.deadline).toBe('2026-12-05T10:00:00.000Z');
  });

  it('refuses an unknown exploration', () => {
    expect(() => open().extendExploration('EXP-9', { addBudgetUsd: 1, deadline: 'x' })).toThrow();
  });
});
