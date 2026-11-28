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

describe('settleDraft', () => {
  it('settles a pending draft once and keeps the refusal', () => {
    const store = open();
    const { draftId } = store.proposeInitiativeDraft({
      parentId: 'ini-1',
      draftYaml: 'title: t',
      why: 'w',
    });
    store.settleDraft(draftId, 'refused', 'pool is empty');
    store.settleDraft(draftId, 'materialised', null);
    expect(store.drafts('pending')).toEqual([]);
    expect(store.drafts('refused')).toEqual([
      expect.objectContaining({ id: draftId, refusal: 'pool is empty' }),
    ]);
    expect(store.drafts('materialised')).toEqual([]);
  });
});

describe('reactionClock', () => {
  it('starts with no reaction and moves only on a decision', () => {
    const store = open();
    expect(store.reactionClock('ini-1')).toEqual({
      createdAt: '2026-11-28T10:00:00.000Z',
      lastReactionAt: null,
      stopReason: null,
    });
    const e = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 0.1,
      days: 1,
    });
    // An automatic start is a plain transition: the owner has not reacted.
    store.transitionExploration(e.id, 'exploring', 'auto-started');
    expect(store.reactionClock('ini-1')?.lastReactionAt).toBeNull();

    store.recordDecision({
      target: e.id,
      gate: 'gate1_explore',
      verdict: 'snooze',
      reason: null,
      option: null,
      decidedBy: 'owner_ui',
    });
    expect(store.reactionClock('ini-1')?.lastReactionAt).toBe('2026-11-28T10:00:00.000Z');
  });

  it('keeps the stop reason', () => {
    const store = open();
    store.upsertInitiative({
      id: 'kid',
      personalityId: 'ada',
      origin: 'agent',
      parentId: 'ini-1',
      state: 'self_started',
      configPath: 'k.yaml',
      configHash: 'h',
      version: 1,
    });
    store.recordDecision({
      target: 'kid',
      gate: 'self_start',
      verdict: 'stop',
      reason: 'not useful',
      option: null,
      decidedBy: 'owner_ui',
    });
    expect(store.reactionClock('kid')).toMatchObject({ stopReason: 'not useful' });
    expect(store.reactionClock('nope')).toBeNull();
  });
});

describe('exploration budget clamp', () => {
  it('a $1e6 estimate gets the per-exploration cap, not the estimate', () => {
    const store = new SQLiteInitiativeStore(':memory:', {
      now: () => Date.parse('2026-11-28T10:00:00Z'),
      explorationCapFor: () => 1.5,
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
    const big = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 1e6,
      days: 1,
    });
    expect(big.budgetUsd).toBe(1.5);
    expect(big.estimateUsd).toBe(1e6);
    const small = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q2',
      estimateUsd: 0.4,
      days: 1,
    });
    expect(small.budgetUsd).toBe(0.4);
  });
});
