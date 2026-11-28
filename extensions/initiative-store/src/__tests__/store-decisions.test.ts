import { describe, expect, it } from 'vitest';
import { SQLiteInitiativeStore } from '../index';
import { initiative, rawDb } from './fixtures';

describe('SQLiteInitiativeStore: transitions', () => {
  function seeded(opts: ConstructorParameters<typeof SQLiteInitiativeStore>[1] = {}) {
    const store = new SQLiteInitiativeStore(':memory:', opts);
    store.upsertInitiative(initiative());
    const e = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 1,
      days: 1,
    });
    return { store, e };
  }

  it('illegal transition throws', () => {
    const { store, e } = seeded();
    expect(() => store.transitionExploration(e.id, 'adopted', 'skip')).toThrowError(
      expect.objectContaining({ name: 'EthosError', code: 'INITIATIVE_ILLEGAL_TRANSITION' }),
    );
    expect(store.getExploration(e.id)?.state).toBe('proposed');
    expect(() => store.transitionInitiative('ini-1', 'ended', 'skip')).toThrowError(
      expect.objectContaining({ code: 'INITIATIVE_ILLEGAL_TRANSITION' }),
    );
    store.close();
  });

  it('a missing target throws NOT_FOUND', () => {
    const { store } = seeded();
    expect(() => store.transitionExploration('EXP-9999', 'exploring', 'x')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(() => store.transitionInitiative('nope', 'paused', 'x')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    store.close();
  });

  it('legal transitions apply, and explorationsOpen counts proposed, exploring and stalled', () => {
    const { store, e } = seeded();
    const open = () => store.budget('ini-1', '2026-11-27').explorationsOpen;
    expect(open()).toBe(1);
    store.transitionExploration(e.id, 'exploring', 'go');
    expect(open()).toBe(1);
    store.transitionExploration(e.id, 'stalled', 'out of budget');
    expect(open()).toBe(1);
    store.transitionExploration(e.id, 'briefed', 'partial brief');
    expect(open()).toBe(0);
    expect(store.explorations('ini-1', ['briefed']).map((x) => x.id)).toEqual([e.id]);
    store.transitionInitiative('ini-1', 'paused', 'owner away');
    expect(store.getInitiative('ini-1')?.state).toBe('paused');
    store.close();
  });
});

describe('SQLiteInitiativeStore: decisions', () => {
  function decisionRows(store: SQLiteInitiativeStore): number {
    return (rawDb(store).prepare('SELECT COUNT(*) AS n FROM decisions').all()[0] as { n: number })
      .n;
  }
  function briefed() {
    const store = new SQLiteInitiativeStore(':memory:', { now: () => Date.UTC(2026, 10, 27) });
    store.upsertInitiative(initiative());
    const e = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 1,
      days: 1,
    });
    store.transitionExploration(e.id, 'exploring', 'go');
    store.transitionExploration(e.id, 'briefed', 'done');
    return { store, e };
  }

  it('adopt records the decision and closes the exploration in one transaction', () => {
    const { store, e } = briefed();
    const d = store.recordDecision({
      target: e.id,
      gate: 'gate2_adopt',
      verdict: 'adopt',
      reason: null,
      option: 'A',
      decidedBy: 'owner_ui',
    });
    expect(d).toMatchObject({
      id: 'DEC-1',
      target: e.id,
      option: 'A',
      decidedBy: 'owner_ui',
      at: '2026-11-27T00:00:00.000Z',
    });
    expect(store.getExploration(e.id)?.state).toBe('adopted');
    expect(decisionRows(store)).toBe(1);
    store.close();
  });

  it('an illegal implied transition throws and writes no decision row', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    store.upsertInitiative(initiative());
    const e = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 1,
      days: 1,
    });
    // proposed -> adopted is not an edge.
    expect(() =>
      store.recordDecision({
        target: e.id,
        gate: 'gate2_adopt',
        verdict: 'adopt',
        reason: null,
        option: null,
        decidedBy: 'owner_ui',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INITIATIVE_ILLEGAL_TRANSITION' }));
    expect(decisionRows(store)).toBe(0);
    expect(store.getExploration(e.id)?.state).toBe('proposed');
    store.close();
  });

  it('decided_by is required', () => {
    const { store, e } = briefed();
    for (const decidedBy of ['', '   ']) {
      expect(() =>
        store.recordDecision({
          target: e.id,
          gate: 'gate2_adopt',
          verdict: 'adopt',
          reason: null,
          option: null,
          decidedBy,
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
    expect(decisionRows(store)).toBe(0);
    expect(store.getExploration(e.id)?.state).toBe('briefed');
    store.close();
  });

  it('a verdict that does not belong to its gate, or a missing target, is refused', () => {
    const { store, e } = briefed();
    expect(() =>
      store.recordDecision({
        target: e.id,
        gate: 'gate1_explore',
        verdict: 'adopt',
        reason: null,
        option: null,
        decidedBy: 'u',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() =>
      store.recordDecision({
        target: 'EXP-9999',
        gate: 'gate2_adopt',
        verdict: 'park',
        reason: null,
        option: null,
        decidedBy: 'u',
      }),
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(decisionRows(store)).toBe(0);
    store.close();
  });

  it('gate 1 and gate 2 verdicts drive the exploration', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    store.upsertInitiative(initiative());
    const mk = () =>
      store.propose({
        initiativeId: 'ini-1',
        ideaId: null,
        question: 'q',
        estimateUsd: 1,
        days: 1,
      });
    const decide = (
      target: string,
      gate: 'gate1_explore' | 'gate2_adopt',
      verdict: 'approve' | 'reject' | 'snooze' | 'park' | 'dig_deeper',
    ) =>
      store.recordDecision({ target, gate, verdict, reason: null, option: null, decidedBy: 'u' });
    const state = (id: string) => store.getExploration(id)?.state;

    const a = mk();
    decide(a.id, 'gate1_explore', 'snooze');
    expect(state(a.id)).toBe('proposed');
    decide(a.id, 'gate1_explore', 'approve');
    expect(state(a.id)).toBe('exploring');
    const b = mk();
    decide(b.id, 'gate1_explore', 'reject');
    expect(state(b.id)).toBe('rejected');

    store.transitionExploration(a.id, 'briefed', 'done');
    decide(a.id, 'gate2_adopt', 'dig_deeper');
    expect(state(a.id)).toBe('exploring');
    store.transitionExploration(a.id, 'briefed', 'done again');
    decide(a.id, 'gate2_adopt', 'park');
    expect(state(a.id)).toBe('parked');
    store.close();
  });

  it('self_start verdicts drive the initiative, stop keeps its reason, and any decision stamps last_reaction_at', () => {
    const store = new SQLiteInitiativeStore(':memory:', { now: () => Date.UTC(2026, 10, 27, 9) });
    store.upsertInitiative(initiative({ id: 'keep', state: 'self_started', origin: 'agent' }));
    store.upsertInitiative(initiative({ id: 'drop', state: 'self_started', origin: 'agent' }));
    store.upsertInitiative(initiative({ id: 'mine', state: 'self_started', origin: 'agent' }));
    const decide = (
      target: string,
      verdict: 'keep' | 'stop' | 'make_mine',
      reason: string | null = null,
    ) =>
      store.recordDecision({
        target,
        gate: 'self_start',
        verdict,
        reason,
        option: null,
        decidedBy: 'owner_chat',
      });
    decide('keep', 'keep');
    decide('drop', 'stop', 'not useful');
    decide('mine', 'make_mine');
    expect(store.getInitiative('keep')?.state).toBe('active');
    expect(store.getInitiative('drop')?.state).toBe('stopped');
    expect(store.getInitiative('mine')?.state).toBe('active');
    const cols = rawDb(store)
      .prepare(`SELECT id, stop_reason, last_reaction_at FROM initiatives ORDER BY id`)
      .all();
    expect(cols).toEqual([
      { id: 'drop', stop_reason: 'not useful', last_reaction_at: '2026-11-27T09:00:00.000Z' },
      { id: 'keep', stop_reason: null, last_reaction_at: '2026-11-27T09:00:00.000Z' },
      { id: 'mine', stop_reason: null, last_reaction_at: '2026-11-27T09:00:00.000Z' },
    ]);
    // A stopped initiative cannot be revived by a second stop.
    expect(() => decide('drop', 'stop')).toThrowError(
      expect.objectContaining({ code: 'INITIATIVE_ILLEGAL_TRANSITION' }),
    );
    store.close();
  });

  it('config_change records a decision with no transition and stamps last_reaction_at', () => {
    const store = new SQLiteInitiativeStore(':memory:', { now: () => Date.UTC(2026, 10, 27, 9) });
    store.upsertInitiative(initiative());
    store.recordDecision({
      target: 'ini-1',
      gate: 'config_change',
      verdict: 'approve',
      reason: null,
      option: null,
      decidedBy: 'owner_ui',
    });
    expect(store.getInitiative('ini-1')?.state).toBe('active');
    expect(rawDb(store).prepare('SELECT last_reaction_at AS t FROM initiatives').all()).toEqual([
      { t: '2026-11-27T09:00:00.000Z' },
    ]);
    store.close();
  });
});

describe('SQLiteInitiativeStore: ledgerPort', () => {
  it('R13 ledger tool port has no decision writer', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    const port = store.ledgerPort();
    const keys = Object.keys(port);
    for (const banned of [
      'recordDecision',
      'upsertInitiative',
      'transitionInitiative',
      'transitionExploration',
      'appendConfigVersion',
      'openWindow',
      'closeWindow',
    ]) {
      expect(keys).not.toContain(banned);
    }
    expect(keys.sort()).toEqual(
      [
        'addFinding',
        'addIdea',
        'addQuestion',
        'budget',
        'ideas',
        'ownerOf',
        'propose',
        'proposeInitiativeDraft',
        'submitBrief',
      ].sort(),
    );
    expect(Object.isFrozen(port)).toBe(true);
    store.close();
  });

  it('ownerOf names the owning initiative, or null for an unknown id', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    const port = store.ledgerPort();
    const idea = port.addIdea({
      initiativeId: 'ini-1',
      origin: 'agent',
      text: 'x',
      sourceRef: null,
    });
    const exp = port.propose({
      initiativeId: 'ini-2',
      ideaId: null,
      question: 'q',
      estimateUsd: 1,
      days: 1,
    });
    expect(port.ownerOf('idea', idea.id)).toBe('ini-1');
    expect(port.ownerOf('exploration', exp.id)).toBe('ini-2');
    expect(port.ownerOf('exploration', idea.id)).toBeNull();
    expect(port.ownerOf('idea', 'nope')).toBeNull();
    store.close();
  });

  it('the port methods work detached from the store', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    const { addIdea, ideas } = store.ledgerPort();
    addIdea({ initiativeId: 'ini-1', origin: 'agent', text: 'x', sourceRef: null });
    expect(ideas('ini-1')).toHaveLength(1);
    store.close();
  });
});
