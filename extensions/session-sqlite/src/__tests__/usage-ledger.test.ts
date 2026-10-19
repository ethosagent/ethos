import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageRecord } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteUsageLedger } from '../usage-ledger';

// plan/phases/background-usage-accounting.md §4.2, D1–D3.

function row(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: '2026-10-19T10:00:00.000Z',
    kind: 'memory_capture',
    sourceClass: 'background',
    provider: 'anthropic',
    model: 'claude-haiku',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0.5,
    outcome: 'ok',
    ...over,
  };
}

type Handle = { pragma(s: string): unknown; prepare(s: string): { run(...a: unknown[]): unknown } };
const handleOf = (l: unknown): Handle => (l as { db: Handle }).db;

/** Reads `PRAGMA synchronous` off the ledger's OWN handle — a per-connection
 *  setting, so a second connection would prove nothing. 2 = FULL, 1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = handleOf(store).pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

/** Reads `PRAGMA busy_timeout` off the ledger's OWN handle. */
function busyPragma(store: unknown): number {
  const rows = handleOf(store).pragma('busy_timeout');
  return (rows as Array<{ timeout: number }>)[0]?.timeout ?? -1;
}

describe('SQLiteUsageLedger', () => {
  let dir: string;
  let path: string;
  let ledger: SQLiteUsageLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
    path = join(dir, 'sessions.db');
    ledger = new SQLiteUsageLedger(path);
  });
  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a STRICT table: a TEXT in an INTEGER column throws', () => {
    expect(() =>
      handleOf(ledger)
        .prepare(
          `INSERT INTO usage_ledger (id, ts, source_kind, source_class, provider, model,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             estimated_cost_usd, outcome)
           VALUES ('x', 't', 'k', 'c', 'p', 'm', 'abc', 0, 0, 0, 0, 'ok')`,
        )
        .run(),
    ).toThrow();
  });

  it('durability posture: stays at synchronous = FULL with busy_timeout 5000', () => {
    // NOT a candidate for NORMAL: the bot daily cap is a guarantee made to the
    // operator and reads these rows (plan D2). Read off the ledger's OWN handle —
    // both are per-connection settings.
    expect(syncPragma(ledger)).toBe(2);
    expect(busyPragma(ledger)).toBe(5000);
  });

  it('a second construction on the same file is a no-op', () => {
    ledger.record(row());
    const second = new SQLiteUsageLedger(path);
    expect(second.spendSince({ since: new Date(0) }).backgroundUsd).toBeCloseTo(0.5);
    second.close();
  });

  it('leaves user_version unchanged', () => {
    const v = (h: Handle) => (h.pragma('user_version') as Array<{ user_version: number }>)[0];
    const fresh = mkdtempSync(join(tmpdir(), 'usage-ledger-uv-'));
    const p = join(fresh, 'sessions.db');
    const l = new SQLiteUsageLedger(p);
    expect(v(handleOf(l))?.user_version).toBe(0);
    l.close();
    rmSync(fresh, { recursive: true, force: true });
  });

  it('spendSince splits by source class', () => {
    ledger.record(row({ estimatedCostUsd: 1 }));
    ledger.record(row({ kind: 'compaction', sourceClass: 'turn_utility', estimatedCostUsd: 2 }));
    ledger.record(row({ kind: 'nightly', sourceClass: 'operator', estimatedCostUsd: 4 }));
    expect(ledger.spendSince({ since: new Date(0) })).toEqual({
      turnUtilityUsd: 2,
      backgroundUsd: 1,
      operatorUsd: 4,
    });
  });

  it('spendSince by botKey, by keyPrefix, and by both without double counting', () => {
    ledger.record(row({ botKey: 'b1', estimatedCostUsd: 1 })); // bot only
    ledger.record(row({ sessionKey: 'telegram:b2:chat', estimatedCostUsd: 2 })); // prefix only
    ledger.record(row({ botKey: 'b1', sessionKey: 'telegram:b1:chat', estimatedCostUsd: 4 })); // both
    ledger.record(row({ botKey: 'other', sessionKey: 'cli:x', estimatedCostUsd: 8 }));
    const since = new Date(0);
    expect(ledger.spendSince({ since, botKey: 'b1' }).backgroundUsd).toBe(5);
    expect(ledger.spendSince({ since, keyPrefix: 'telegram:' }).backgroundUsd).toBe(6);
    expect(
      ledger.spendSince({ since, botKey: 'b1', keyPrefix: 'telegram:b1:' }).backgroundUsd,
    ).toBe(5);
    expect(ledger.spendSince({ since, botKey: 'b1', keyPrefix: 'telegram:' }).backgroundUsd).toBe(
      7,
    );
  });

  it('spendSince keyPrefix is case-sensitive', () => {
    ledger.record(row({ sessionKey: 'Telegram:A:1', estimatedCostUsd: 1 }));
    expect(ledger.spendSince({ since: new Date(0), keyPrefix: 'telegram:' }).backgroundUsd).toBe(0);
    expect(ledger.spendSince({ since: new Date(0), keyPrefix: 'Telegram:' }).backgroundUsd).toBe(1);
  });

  it('spendSince excludes rows before since', () => {
    ledger.record(row({ ts: '2026-10-18T23:59:59.000Z', estimatedCostUsd: 1 }));
    ledger.record(row({ ts: '2026-10-19T00:00:00.000Z', estimatedCostUsd: 2 }));
    expect(ledger.spendSince({ since: new Date('2026-10-19T00:00:00.000Z') }).backgroundUsd).toBe(
      2,
    );
  });
});
