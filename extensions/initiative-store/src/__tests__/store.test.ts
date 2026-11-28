import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InitiativeRow } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { initiativesDbPath, SQLiteInitiativeStore } from '../index';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'initiative-store-'));
  dirs.push(dir);
  return initiativesDbPath(dir);
}

function initiative(overrides: Partial<InitiativeRow> = {}): InitiativeRow {
  return {
    id: 'ini-1',
    personalityId: 'ada',
    origin: 'human',
    parentId: null,
    state: 'active',
    configPath: 'initiatives/ini-1.yaml',
    configHash: 'h1',
    version: 1,
    ...overrides,
  };
}

/** The raw handle, the way the other stores' durability tests reach it. */
function rawDb(store: unknown): {
  pragma(s: string): unknown;
  prepare(s: string): { all(): Array<Record<string, unknown>> };
} {
  return (store as { db: ReturnType<typeof rawDb> }).db;
}

describe('SQLiteInitiativeStore: schema', () => {
  it('initiativesDbPath puts the file in the data dir', () => {
    expect(initiativesDbPath('/x/.ethos')).toBe('/x/.ethos/initiatives.db');
  });

  it('creates the db file under a missing parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'initiative-store-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'initiatives.db');
    const store = new SQLiteInitiativeStore(path);
    expect(existsSync(path)).toBe(true);
    store.close();
  });

  it('schema is STRICT', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    const tables = rawDb(store)
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual([
      'briefs',
      'config_versions',
      'decisions',
      'drafts',
      'explorations',
      'findings',
      'ideas',
      'initiatives',
      'questions',
      'windows',
    ]);
    for (const t of tables) expect(t.sql.trimEnd(), t.name).toMatch(/\)\s*STRICT$/);
    store.close();
  });
});

describe('SQLiteInitiativeStore: durability posture', () => {
  it('durability posture is FULL', () => {
    // A decision row is a promise to the user, and spend rows enforce a cap the
    // operator was promised; a power cut must not roll either back. Pinned so a
    // blanket NORMAL sweep cannot take it silently
    // (.claude/rules/sqlite-durability.md). Asserted on the opened database.
    const path = tmpDb();
    const store = new SQLiteInitiativeStore(path);
    const sync = rawDb(store).pragma('synchronous') as Array<{ synchronous: number }>;
    expect(sync[0]?.synchronous).toBe(2);
    const journal = rawDb(store).pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(journal[0]?.journal_mode).toBe('wal');
    store.close();
  });
});

describe('SQLiteInitiativeStore: ledger rows', () => {
  it('ideas order by created_at, rowid', () => {
    // Same clock tick for every insert: only the rowid tie-break keeps order.
    const store = new SQLiteInitiativeStore(':memory:', { now: () => Date.UTC(2026, 10, 27) });
    store.upsertInitiative(initiative());
    const texts = ['c', 'a', 'b', 'z', 'y'];
    for (const text of texts) {
      store.addIdea({ initiativeId: 'ini-1', origin: 'agent', text, sourceRef: null });
    }
    store.addIdea({ initiativeId: 'other', origin: 'human', text: 'not mine', sourceRef: null });
    expect(store.ideas('ini-1').map((i) => i.text)).toEqual(texts);
    expect(store.ideas('ini-1')[0]?.id).toBe('I-1');
    store.close();
  });

  it('assigns readable monotonic ids per table', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    const e1 = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q1',
      estimateUsd: 1,
      days: 3,
    });
    const e2 = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q2',
      estimateUsd: 1,
      days: 3,
    });
    expect([e1.id, e2.id]).toEqual(['EXP-0001', 'EXP-0002']);
    const f = store.addFinding({
      explorationId: e1.id,
      claim: 'c',
      sourceRef: 's',
      confidence: 0.5,
    });
    expect(f.id).toBe('F-1');
    expect(
      store.addFinding({ explorationId: e1.id, claim: 'c2', sourceRef: 's', confidence: 1 }).id,
    ).toBe('F-2');
    store.close();
  });

  it('ids continue after a reopen', () => {
    const path = tmpDb();
    const a = new SQLiteInitiativeStore(path);
    a.propose({ initiativeId: 'ini-1', ideaId: null, question: 'q', estimateUsd: 1, days: 1 });
    a.close();
    const b = new SQLiteInitiativeStore(path);
    expect(
      b.propose({ initiativeId: 'ini-1', ideaId: null, question: 'q', estimateUsd: 1, days: 1 }).id,
    ).toBe('EXP-0002');
    b.close();
  });

  it('two handles on one file never mint the same id', () => {
    const path = tmpDb();
    const a = new SQLiteInitiativeStore(path);
    const b = new SQLiteInitiativeStore(path);
    const mint = (s: SQLiteInitiativeStore) =>
      s.propose({ initiativeId: 'ini-1', ideaId: null, question: 'q', estimateUsd: 1, days: 1 }).id;
    expect([mint(a), mint(b), mint(a), mint(b)]).toEqual([
      'EXP-0001',
      'EXP-0002',
      'EXP-0003',
      'EXP-0004',
    ]);
    a.close();
    b.close();
  });

  it('propose creates a proposed exploration with the estimate as its budget and a deadline', () => {
    const now = Date.UTC(2026, 10, 27, 12);
    const store = new SQLiteInitiativeStore(':memory:', { now: () => now });
    const e = store.propose({
      initiativeId: 'ini-1',
      ideaId: 'I-1',
      question: 'why?',
      estimateUsd: 2.5,
      days: 3,
    });
    expect(e).toMatchObject({
      state: 'proposed',
      question: 'why?',
      ideaId: 'I-1',
      budgetUsd: 2.5,
      estimateUsd: 2.5,
      spentUsd: 0,
      deadline: new Date(now + 3 * 86_400_000).toISOString(),
    });
    expect(store.getExploration(e.id)).toEqual(e);
    expect(store.getExploration('EXP-9999')).toBeNull();
    store.close();
  });

  it('rejects a finding confidence outside 0..1', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    expect(() =>
      store.addFinding({ explorationId: 'EXP-0001', claim: 'c', sourceRef: 's', confidence: 1.5 }),
    ).toThrow();
    store.close();
  });

  it('submitBrief versions per exploration', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    const b1 = store.submitBrief({
      explorationId: 'EXP-0001',
      bodyMd: 'one',
      recommendedOption: null,
      partial: true,
    });
    const b2 = store.submitBrief({
      explorationId: 'EXP-0001',
      bodyMd: 'two',
      recommendedOption: 'A',
      partial: false,
    });
    const other = store.submitBrief({
      explorationId: 'EXP-0002',
      bodyMd: 'x',
      recommendedOption: null,
      partial: false,
    });
    expect([b1.version, b2.version, other.version]).toEqual([1, 2, 1]);
    expect([b1.id, b2.id, other.id]).toEqual(['B-1', 'B-2', 'B-3']);
    expect(b1.partial).toBe(true);
    store.close();
  });

  it('proposeInitiativeDraft and addQuestion persist pending rows', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    const { draftId } = store.proposeInitiativeDraft({
      parentId: 'ini-1',
      draftYaml: 'a: 1',
      why: 'because',
    });
    expect(store.drafts('pending')).toMatchObject([
      { id: draftId, parentId: 'ini-1', status: 'pending', refusal: null },
    ]);
    const qid = store.addQuestion({
      initiativeId: 'ini-1',
      explorationId: null,
      text: 'which one?',
    });
    expect(store.questions('ini-1')).toMatchObject([
      { id: qid, text: 'which one?', answer: null, answeredAt: null },
    ]);
    store.close();
  });

  it('upsertInitiative inserts then updates in place and appendConfigVersion records history', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    store.upsertInitiative(initiative());
    store.upsertInitiative(initiative({ version: 2, configHash: 'h2', state: 'paused' }));
    expect(store.getInitiative('ini-1')).toEqual(
      initiative({ version: 2, configHash: 'h2', state: 'paused' }),
    );
    expect(store.getInitiative('nope')).toBeNull();
    store.appendConfigVersion({
      initiativeId: 'ini-1',
      version: 2,
      hash: 'h2',
      diff: '+x',
      sessionId: null,
      confirmedBy: 'owner_ui',
    });
    expect(() =>
      store.appendConfigVersion({
        initiativeId: 'ini-1',
        version: 2,
        hash: 'h2',
        diff: '+x',
        sessionId: null,
        confirmedBy: 'owner_ui',
      }),
    ).toThrow();
    store.close();
  });
});

describe('SQLiteInitiativeStore: windows and budget', () => {
  it('spend accumulates per exploration and per day', () => {
    let now = Date.UTC(2026, 10, 27, 23, 0);
    const store = new SQLiteInitiativeStore(':memory:', { now: () => now, capFor: () => 5 });
    const e = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 4,
      days: 7,
    });
    const done = { toolsUsed: ['web_search'], reads: ['a'], checkpoint: null, endReason: 'done' };

    const w1 = store.openWindow({ initiativeId: 'ini-1', explorationId: e.id, kind: 'window' });
    store.closeWindow(w1, { ...done, spentUsd: 0.5 });
    const w2 = store.openWindow({ initiativeId: 'ini-1', explorationId: e.id, kind: 'window' });
    store.closeWindow(w2, { ...done, spentUsd: 0.25 });
    // A survey window with no exploration still counts against the day.
    const w3 = store.openWindow({ initiativeId: 'ini-1', explorationId: null, kind: 'survey' });
    store.closeWindow(w3, { ...done, spentUsd: 0.1 });
    // Another initiative's spend never leaks in.
    const w4 = store.openWindow({ initiativeId: 'ini-2', explorationId: null, kind: 'scan' });
    store.closeWindow(w4, { ...done, spentUsd: 9 });

    now = Date.UTC(2026, 10, 28, 0, 30); // next UTC day
    const w5 = store.openWindow({ initiativeId: 'ini-1', explorationId: e.id, kind: 'window' });
    store.closeWindow(w5, { ...done, spentUsd: 1 });

    expect(store.getExploration(e.id)?.spentUsd).toBeCloseTo(1.75);
    expect(store.budget('ini-1', '2026-11-27')).toMatchObject({ capUsd: 5, explorationsOpen: 1 });
    expect(store.budget('ini-1', '2026-11-27').spentUsd).toBeCloseTo(0.85);
    expect(store.budget('ini-1', '2026-11-28').spentUsd).toBe(1);
    expect(store.budget('ini-1', '2026-11-29').spentUsd).toBe(0);

    const windows = store.windows('ini-1');
    expect(windows.map((w) => w.id)).toEqual([w1, w2, w3, w5]);
    expect(windows[0]).toMatchObject({
      kind: 'window',
      spentUsd: 0.5,
      toolsUsed: ['web_search'],
      reads: ['a'],
      checkpoint: null,
      endReason: 'done',
      explorationId: e.id,
    });
    expect(windows[0]?.ended).not.toBeNull();
    store.close();
  });

  it('closing a window twice, or an unknown one, throws and counts spend once', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    const e = store.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 1,
      days: 1,
    });
    const w = store.openWindow({ initiativeId: 'ini-1', explorationId: e.id, kind: 'brief' });
    const r = { spentUsd: 1, toolsUsed: [], reads: [], checkpoint: 'cp', endReason: 'budget' };
    store.closeWindow(w, r);
    expect(() => store.closeWindow(w, r)).toThrow();
    expect(() => store.closeWindow('W-99', r)).toThrow();
    expect(store.getExploration(e.id)?.spentUsd).toBe(1);
    store.close();
  });

  it('budget capUsd defaults to 0 and explorationsOpen counts proposed, exploring and stalled', () => {
    const store = new SQLiteInitiativeStore(':memory:');
    store.propose({ initiativeId: 'ini-1', ideaId: null, question: 'a', estimateUsd: 1, days: 1 });
    store.propose({ initiativeId: 'ini-1', ideaId: null, question: 'b', estimateUsd: 1, days: 1 });
    store.propose({ initiativeId: 'ini-2', ideaId: null, question: 'c', estimateUsd: 1, days: 1 });
    expect(store.budget('ini-1', '2026-11-27')).toEqual({
      spentUsd: 0,
      capUsd: 0,
      explorationsOpen: 2,
    });
    expect(store.explorations('ini-1').map((e) => e.question)).toEqual(['a', 'b']);
    expect(store.explorations('ini-1', ['exploring'])).toEqual([]);
    store.close();
  });
});

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
