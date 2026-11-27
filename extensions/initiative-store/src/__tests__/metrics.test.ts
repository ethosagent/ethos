import { describe, expect, it } from 'vitest';
import { SQLiteInitiativeStore } from '../index';
import { computeGateMetrics } from '../metrics';

function seed(store: SQLiteInitiativeStore) {
  store.upsertInitiative({
    id: 'ini',
    personalityId: 'ada',
    origin: 'human',
    parentId: null,
    state: 'active',
    configPath: 'p',
    configHash: 'h',
    version: 1,
  });
  store.upsertInitiative({
    id: 'other',
    personalityId: 'bob',
    origin: 'human',
    parentId: null,
    state: 'active',
    configPath: 'p',
    configHash: 'h',
    version: 1,
  });
  const mk = (initiativeId: string) =>
    store.propose({ initiativeId, ideaId: null, question: 'q', estimateUsd: 1, days: 1 }).id;
  const decide = (
    target: string,
    gate: 'gate1_explore' | 'gate2_adopt',
    verdict: 'approve' | 'reject' | 'snooze' | 'adopt' | 'park',
  ) => store.recordDecision({ target, gate, verdict, reason: null, option: null, decidedBy: 'u' });
  return { mk, decide };
}

describe('computeGateMetrics', () => {
  it('gate rates count decisions from day one', () => {
    const store = new SQLiteInitiativeStore(':memory:', { now: () => Date.UTC(2026, 10, 27) });
    const { mk, decide } = seed(store);
    for (let i = 0; i < 3; i++) decide(mk('ini'), 'gate1_explore', 'approve');
    decide(mk('ini'), 'gate1_explore', 'reject');
    decide(mk('ini'), 'gate1_explore', 'snooze'); // not an answer
    decide(mk('other'), 'gate1_explore', 'approve'); // another personality
    const m = computeGateMetrics(store, 'ada', '2026-11-01T00:00:00.000Z');
    expect(m.gate1).toEqual({ asked: 4, approved: 3, rate: 0.75 });
    expect(m.gate2).toEqual({ briefs: 0, adopted: 0, rate: 0 });
    store.close();
  });

  it('gate 2 counts adopt against park, and self-start counts kept and stopped', () => {
    const store = new SQLiteInitiativeStore(':memory:', { now: () => Date.UTC(2026, 10, 27) });
    const { mk, decide } = seed(store);
    for (const verdict of ['adopt', 'park'] as const) {
      const id = mk('ini');
      store.transitionExploration(id, 'exploring', 'go');
      store.transitionExploration(id, 'briefed', 'done');
      decide(id, 'gate2_adopt', verdict);
    }
    for (const [id, verdict] of [
      ['s1', 'keep'],
      ['s2', 'make_mine'],
      ['s3', 'stop'],
    ] as const) {
      store.upsertInitiative({
        id,
        personalityId: 'ada',
        origin: 'agent',
        parentId: null,
        state: 'self_started',
        configPath: 'p',
        configHash: 'h',
        version: 1,
      });
      store.recordDecision({
        target: id,
        gate: 'self_start',
        verdict,
        reason: null,
        option: null,
        decidedBy: 'u',
      });
    }
    const m = computeGateMetrics(store, 'ada', '2026-11-01T00:00:00.000Z');
    expect(m.gate2).toEqual({ briefs: 2, adopted: 1, rate: 0.5 });
    expect(m.selfStart).toEqual({ started: 3, kept: 2, stopped: 1 });
    store.close();
  });

  it('ignores decisions before sinceIso', () => {
    let now = Date.UTC(2026, 9, 1);
    const store = new SQLiteInitiativeStore(':memory:', { now: () => now });
    const { mk, decide } = seed(store);
    decide(mk('ini'), 'gate1_explore', 'approve');
    now = Date.UTC(2026, 10, 27);
    decide(mk('ini'), 'gate1_explore', 'reject');
    expect(computeGateMetrics(store, 'ada', '2026-11-01T00:00:00.000Z').gate1).toEqual({
      asked: 1,
      approved: 0,
      rate: 0,
    });
    store.close();
  });
});
