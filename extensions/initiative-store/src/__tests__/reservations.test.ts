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

function open(path: string, over: { now?: () => number; cap?: number } = {}) {
  return new SQLiteInitiativeStore(path, {
    now: over.now ?? (() => NOW),
    capFor: () => over.cap ?? 1,
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
    ).toBe(2);
    b.close();
  });
});
