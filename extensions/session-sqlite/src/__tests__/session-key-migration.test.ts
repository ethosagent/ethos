import { describe, expect, it } from 'vitest';
import { decideMigration } from '../session-key-migration';

// Multi-bot routing session-key migration. Pure decision logic is
// unit-tested here; the SQLite-touching `migrateSessionKeys` wrapper
// is covered by the gateway boot integration path in Phase 5.

describe('decideMigration', () => {
  const known = new Map<string, Set<string>>([
    ['telegram', new Set(['t1key', 't2key'])],
    ['slack', new Set(['s1key'])],
  ]);
  const primary = new Map<string, string>([
    ['telegram', 't1key'],
    ['slack', 's1key'],
  ]);

  it('rewrites a legacy 2-part key by prepending the primary botKey', () => {
    expect(decideMigration('telegram:42', known, primary)).toEqual({
      kind: 'rewrite',
      newKey: 'telegram:t1key:42',
    });
  });

  it('preserves the /new timestamp suffix on legacy keys', () => {
    expect(decideMigration('telegram:42:1234567890', known, primary)).toEqual({
      kind: 'rewrite',
      newKey: 'telegram:t1key:42:1234567890',
    });
  });

  it('recognizes already-migrated keys via the known-botKey set', () => {
    expect(decideMigration('telegram:t1key:42', known, primary)).toEqual({
      kind: 'skip-already-migrated',
    });
    expect(decideMigration('telegram:t2key:42:9999', known, primary)).toEqual({
      kind: 'skip-already-migrated',
    });
  });

  it('skips rows whose platform has no configured bot', () => {
    expect(decideMigration('discord:42', known, primary)).toEqual({ kind: 'skip-no-bot' });
  });

  it('skips malformed keys with no platform segment', () => {
    expect(decideMigration('orphan', known, primary)).toEqual({ kind: 'skip-no-bot' });
  });

  it('routes slack legacy sessions to the slack primary botKey', () => {
    expect(decideMigration('slack:C001:1234', known, primary)).toEqual({
      kind: 'rewrite',
      newKey: 'slack:s1key:C001:1234',
    });
  });

  it('migration of a row twice is a no-op (idempotency on the second pass)', () => {
    // First pass produces the new key…
    const first = decideMigration('telegram:42', known, primary);
    expect(first.kind).toBe('rewrite');
    if (first.kind !== 'rewrite') return;
    // …feeding that back in is a no-op.
    expect(decideMigration(first.newKey, known, primary)).toEqual({
      kind: 'skip-already-migrated',
    });
  });
});
