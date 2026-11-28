import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initiativesDbPath, SQLiteInitiativeStore } from '../index';
import { initiative, rawDb } from './fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'initiative-store-'));
  dirs.push(dir);
  return initiativesDbPath(dir);
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
      'window_reservations',
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
