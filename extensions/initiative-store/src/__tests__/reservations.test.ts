import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InitiativeStore } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { initiativesDbPath, SQLiteInitiativeStore } from '../index';
import { rawDb } from './fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'initiative-reservations-'));
  dirs.push(dir);
  return initiativesDbPath(dir);
}

const NOW = Date.UTC(2026, 10, 28, 10, 0);
const DAY = '2026-11-28';
const done = { toolsUsed: [], reads: [], checkpoint: null, endReason: 'done' };

type Reserve = Parameters<InitiativeStore['reserveAndOpenWindow']>[0];
const req = (over: Partial<Reserve> = {}): Reserve => ({
  initiativeId: 'ini-1',
  explorationId: null,
  kind: 'survey',
  personalityId: 'ada',
  origin: 'human',
  reserveUsd: 0.5,
  ttlMs: 60 * 60 * 1000,
  caps: {},
  ...over,
});

function open(
  path: string,
  over: {
    now?: () => number;
    cap?: number;
    processId?: number;
    isPidAlive?: (pid: number) => boolean;
  } = {},
) {
  return new SQLiteInitiativeStore(path, {
    now: over.now ?? (() => NOW),
    capFor: () => over.cap ?? 1,
    ...(over.processId !== undefined ? { processId: over.processId } : {}),
    ...(over.isPidAlive ? { isPidAlive: over.isPidAlive } : {}),
  });
}

describe('SQLiteInitiativeStore: cross-process window reservations', () => {
  it('two connections on one file both try the last $0.50: exactly one wins', () => {
    const path = tmpDb();
    const a = open(path);
    const b = open(path);
    const seed = a.reserveAndOpenWindow(req({ reserveUsd: 0.5 }));
    if (!seed.ok) throw new Error('seed refused');
    a.closeWindow(seed.windowId, { ...done, spentUsd: 0.5 });
    const results = [
      a.reserveAndOpenWindow(req({ reserveUsd: 0.5 })),
      b.reserveAndOpenWindow(req({ reserveUsd: 0.5 })),
    ];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toMatchObject({ ok: false, scope: 'initiative' });
    a.close();
    b.close();
  });

  it('an expired reservation is ignored', () => {
    const path = tmpDb();
    let now = NOW;
    const a = open(path, { now: () => now });
    const b = open(path, { now: () => now });
    expect(a.reserveAndOpenWindow(req({ reserveUsd: 1, ttlMs: 1000 })).ok).toBe(true);
    expect(b.reserveAndOpenWindow(req({ reserveUsd: 0.5 })).ok).toBe(false);
    now += 1001; // the holder crashed and never closed its window
    expect(b.reserveAndOpenWindow(req({ reserveUsd: 0.5 })).ok).toBe(true);
    a.close();
    b.close();
  });

  it("a heartbeat keeps a live window's hold past its first ttl; without one it lapses", () => {
    const path = tmpDb();
    let now = NOW;
    const a = open(path, { now: () => now });
    const b = open(path, { now: () => now });
    const r = a.reserveAndOpenWindow(req({ reserveUsd: 1, ttlMs: 1000 }));
    if (!r.ok) throw new Error('refused');
    now += 900;
    a.touchReservation(r.windowId, 1000); // activity: the hold now runs to NOW + 1900
    now += 600; // NOW + 1500, past the original expiry
    expect(b.reserveAndOpenWindow(req({ reserveUsd: 0.5 })).ok).toBe(false);
    now += 500; // NOW + 2000, no more activity
    expect(b.reserveAndOpenWindow(req({ reserveUsd: 0.5 })).ok).toBe(true);
    a.close();
    b.close();
  });

  it('a hold whose process is gone is pruned on reserve; a live one is kept', () => {
    const path = tmpDb();
    const a = open(path, { processId: 4242 });
    expect(a.reserveAndOpenWindow(req({ reserveUsd: 1 })).ok).toBe(true);
    const alive = open(path, { isPidAlive: () => true });
    expect(alive.reserveAndOpenWindow(req({ reserveUsd: 0.5 })).ok).toBe(false);
    const checked: number[] = [];
    const reaper = open(path, {
      isPidAlive: (pid) => {
        checked.push(pid);
        return pid !== 4242;
      },
    });
    expect(reaper.reserveAndOpenWindow(req({ reserveUsd: 0.5 })).ok).toBe(true);
    expect(checked).toContain(4242);
    a.close();
    alive.close();
    reaper.close();
  });

  it('closing a window frees its reservation and records the spend', () => {
    const path = tmpDb();
    const a = open(path);
    const r = a.reserveAndOpenWindow(req({ reserveUsd: 1 }));
    if (!r.ok) throw new Error('refused');
    const count = (): number =>
      (rawDb(a).prepare('SELECT COUNT(*) AS n FROM window_reservations').all()[0] as { n: number })
        .n;
    expect(count()).toBe(1);
    a.closeWindow(r.windowId, { ...done, spentUsd: 0.25 });
    expect(count()).toBe(0);
    expect(a.budget('ini-1', DAY).spentUsd).toBe(0.25);
    // Spend 0.25 + a fresh 0.75 reservation fits; 0.76 does not.
    expect(a.reserveAndOpenWindow(req({ reserveUsd: 0.76 })).ok).toBe(false);
    expect(a.reserveAndOpenWindow(req({ reserveUsd: 0.75 })).ok).toBe(true);
    a.close();
  });

  it('personality, global and pool ceilings count other initiatives and reservations', () => {
    const path = tmpDb();
    const a = open(path, { cap: 10 });
    const b = open(path, { cap: 10 });
    expect(
      a.reserveAndOpenWindow(req({ initiativeId: 'ini-1', reserveUsd: 0.6, caps: {} })).ok,
    ).toBe(true);
    const sibling = b.reserveAndOpenWindow(
      req({ initiativeId: 'ini-2', reserveUsd: 0.5, caps: { personalityUsd: 1 } }),
    );
    expect(sibling).toMatchObject({ ok: false, scope: 'personality' });
    const other = b.reserveAndOpenWindow(
      req({ initiativeId: 'ini-3', personalityId: 'bob', reserveUsd: 0.5, caps: { globalUsd: 1 } }),
    );
    expect(other).toMatchObject({ ok: false, scope: 'global' });
    const agent = (id: string, usd: number) =>
      b.reserveAndOpenWindow(
        req({
          initiativeId: id,
          personalityId: 'bob',
          origin: 'agent',
          reserveUsd: usd,
          caps: { poolUsd: 1 },
        }),
      );
    expect(agent('ag-1', 0.7).ok).toBe(true);
    expect(agent('ag-2', 0.7)).toMatchObject({ ok: false, scope: 'pool' });
    a.close();
    b.close();
  });

  it('a zero reservation always opens, even when the day is already over its cap', () => {
    const a = open(tmpDb(), { cap: 0 });
    expect(a.reserveAndOpenWindow(req({ reserveUsd: 0 })).ok).toBe(true);
    a.close();
  });

  it('a version 1 database gains the table on open', () => {
    const path = tmpDb();
    const a = open(path);
    rawDb(a).prepare('DROP TABLE window_reservations').all();
    rawDb(a).pragma('user_version = 1');
    a.close();
    const b = open(path);
    expect(b.reserveAndOpenWindow(req()).ok).toBe(true);
    expect(
      (rawDb(b).pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version,
    ).toBe(3);
    b.close();
  });

  it('a version 2 database gains the exploration column on open and keeps its rows', () => {
    const path = tmpDb();
    const a = open(path);
    const db = rawDb(a);
    db.prepare('DROP TABLE window_reservations').all();
    db.prepare(
      `CREATE TABLE window_reservations (
        window_id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL, personality_id TEXT NOT NULL,
        pool INTEGER NOT NULL CHECK (pool IN (0,1)), day TEXT NOT NULL, reserved_usd REAL NOT NULL,
        holder TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      ) STRICT`,
    ).all();
    db.pragma('user_version = 2');
    a.close();
    const b = open(path);
    const cols = rawDb(b)
      .prepare("SELECT name FROM pragma_table_info('window_reservations')")
      .all()
      .map((r) => r.name);
    expect(cols).toContain('exploration_id');
    expect(
      (rawDb(b).pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version,
    ).toBe(3);
    expect(b.reserveAndOpenWindow(req({ kind: 'window', explorationId: 'EXP-0001' })).ok).toBe(
      true,
    );
    b.close();
  });

  it('two connections on one file both try the last dollar of an exploration: exactly one wins', () => {
    const path = tmpDb();
    const a = open(path, { cap: 3 });
    const b = open(path, { cap: 3 });
    // $3/day initiative, but this exploration has $1 left: the initiative scope alone passes both.
    const exp = a.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 1,
      days: 1,
    });
    const win = (s: SQLiteInitiativeStore) =>
      s.reserveAndOpenWindow(req({ kind: 'window', explorationId: exp.id, reserveUsd: 1 }));
    const results = [win(a), win(b)];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, scope: 'exploration' });
    a.close();
    b.close();
  });

  it('an exploration scope counts its recorded spend, and a brief window is not held to it', () => {
    const a = open(tmpDb(), { cap: 10 });
    const exp = a.propose({
      initiativeId: 'ini-1',
      ideaId: null,
      question: 'q',
      estimateUsd: 1,
      days: 1,
    });
    const first = a.reserveAndOpenWindow(
      req({ kind: 'window', explorationId: exp.id, reserveUsd: 1 }),
    );
    if (!first.ok) throw new Error('refused');
    a.closeWindow(first.windowId, { ...done, spentUsd: 0.8 });
    expect(
      a.reserveAndOpenWindow(req({ kind: 'window', explorationId: exp.id, reserveUsd: 0.3 })),
    ).toMatchObject({ ok: false, scope: 'exploration' });
    expect(
      a.reserveAndOpenWindow(req({ kind: 'brief', explorationId: exp.id, reserveUsd: 0.3 })).ok,
    ).toBe(true);
    a.close();
  });
});
