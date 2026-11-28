import type { InitiativeRow } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { SQLiteInitiativeStore } from '../index';

function ini(id: string, overrides: Partial<InitiativeRow> = {}): InitiativeRow {
  return {
    id,
    personalityId: 'ada',
    origin: 'human',
    parentId: null,
    state: 'active',
    configPath: `initiatives/${id}.yaml`,
    configHash: 'h',
    version: 1,
    ...overrides,
  };
}

function seeded() {
  const store = new SQLiteInitiativeStore(':memory:', { now: () => Date.UTC(2026, 10, 27) });
  store.upsertInitiative(ini('self-serve-activation'));
  store.upsertInitiative(ini('agent-idea', { origin: 'agent', state: 'self_started' }));
  store.upsertInitiative(ini('old', { state: 'ended' }));
  store.upsertInitiative(ini('paused-one', { state: 'paused' }));
  store.upsertInitiative(ini('bob-thing', { personalityId: 'bob' }));
  const e1 = store.propose({
    initiativeId: 'self-serve-activation',
    ideaId: null,
    question: 'Why do trials stall at step three?',
    estimateUsd: 2,
    days: 4,
  });
  store.transitionExploration(e1.id, 'exploring', 'go');
  const e2 = store.propose({
    initiativeId: 'self-serve-activation',
    ideaId: null,
    question: 'Pricing page experiments',
    estimateUsd: 1,
    days: 2,
  });
  store.propose({
    initiativeId: 'bob-thing',
    ideaId: null,
    question: 'Bob only question about trials',
    estimateUsd: 1,
    days: 2,
  });
  store.addFinding({
    explorationId: e1.id,
    claim: 'Step three requires a card, 40% abandon there',
    sourceRef: 'https://x',
    confidence: 0.8,
  });
  store.submitBrief({
    explorationId: e1.id,
    bodyMd: '# Brief\n\nRemove the card requirement from onboarding.',
    recommendedOption: 'A',
    partial: false,
  });
  return { store, e1, e2 };
}

describe('SQLiteInitiativeStore: recall', () => {
  it('list filters by personality and states', () => {
    const { store } = seeded();
    expect(store.list({ personalityId: 'ada' }).map((i) => i.id)).toEqual([
      'self-serve-activation',
      'agent-idea',
      'old',
      'paused-one',
    ]);
    expect(
      store.list({ personalityId: 'ada', states: ['active', 'self_started'] }).map((i) => i.id),
    ).toEqual(['self-serve-activation', 'agent-idea']);
    store.close();
  });

  it('get returns the initiative with its explorations, briefs and findings, or null', () => {
    const { store, e1 } = seeded();
    const got = store.get('self-serve-activation');
    expect(got?.initiative.id).toBe('self-serve-activation');
    expect(got?.explorations).toHaveLength(2);
    expect(got?.briefs.map((b) => b.explorationId)).toEqual([e1.id]);
    expect(got?.findings.map((f) => f.id)).toEqual(['F-1']);
    expect(store.get('nope')).toBeNull();
    store.close();
  });

  it('search finds a brief by a word in its body', () => {
    const { store } = seeded();
    const hits = store.search('ada', 'onboarding', 10);
    expect(hits).toEqual([
      { kind: 'brief', id: 'B-1', snippet: expect.stringContaining('onboarding') },
    ]);
    store.close();
  });

  it('search covers findings and explorations, is case-insensitive and scoped to the personality', () => {
    const { store } = seeded();
    const hits = store.search('ada', 'TRIALS', 10);
    expect(hits.map((h) => [h.kind, h.id])).toEqual([['exploration', 'EXP-0001']]);
    expect(store.search('ada', 'card', 10).map((h) => h.kind)).toEqual(['finding', 'brief']);
    expect(store.search('bob', 'trials', 10).map((h) => h.id)).toEqual(['EXP-0003']);
    store.close();
  });

  it('search treats LIKE wildcards literally and honours limit', () => {
    const { store } = seeded();
    expect(store.search('ada', '_', 10)).toEqual([]);
    expect(store.search('ada', '%', 10).map((h) => h.id)).toEqual(['F-1']);
    expect(store.search('ada', '40%', 10).map((h) => h.id)).toEqual(['F-1']);
    expect(store.search('ada', 'card', 1)).toHaveLength(1);
    expect(store.search('ada', '', 10)).toEqual([]);
    store.close();
  });

  it('indexLines is stable for unchanged state', () => {
    const { store } = seeded();
    const a = store.indexLines('ada', 20);
    const b = store.indexLines('ada', 20);
    expect(a.join('\n')).toBe(b.join('\n'));
    store.close();
  });

  it('indexLines lists active and self_started initiatives with their open explorations, capped at max', () => {
    const { store } = seeded();
    const lines = store.indexLines('ada', 20);
    expect(lines).toEqual([
      'INI self-serve-activation (active)',
      'EXP-0001 exploring: Why do trials stall at step three? (due 2026-12-01)',
      'EXP-0002 proposed: Pricing page experiments (due 2026-11-29)',
      'INI agent-idea (self_started)',
    ]);
    expect(store.indexLines('ada', 2)).toEqual(lines.slice(0, 2));
    expect(store.indexLines('ada', 0)).toEqual([]);
    store.close();
  });
});
