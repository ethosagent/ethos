// R9 (plan/phases/openclaw-2026.9.6-gaps.md) — `SessionStore.pruneOldSessions`
// was implemented by both stores and called by nothing at runtime, so session
// rows (and the compressions, decisions and context-log rows that cascade from
// them) grew without bound. The gateway's hourly retention timer now calls it
// through `pruneExpiredSessions`, keyed on the existing `retention.messages`
// window — the same key the `observability-prune` cron uses to delete the
// messages themselves (`pruneObservability`,
// extensions/observability-sqlite/src/retention.ts).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pruneExpiredSessions } from '../../lib/session-retention';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-09-25T00:00:00Z');

function fakeStore() {
  return { pruneOldSessions: vi.fn(async (_olderThan: Date) => 3) };
}

describe('pruneExpiredSessions', () => {
  it('prunes sessions older than retention.messages when it is set', async () => {
    const store = fakeStore();
    expect(await pruneExpiredSessions(store, { messages: '30d' }, NOW)).toBe(3);
    expect(store.pruneOldSessions).toHaveBeenCalledWith(new Date(NOW - 30 * DAY_MS));
  });

  it('uses the retention.messages default (365d) when unset', async () => {
    const store = fakeStore();
    await pruneExpiredSessions(store, undefined, NOW);
    expect(store.pruneOldSessions).toHaveBeenCalledWith(new Date(NOW - 365 * DAY_MS));
  });

  it('prunes nothing when retention.messages is forever', async () => {
    const store = fakeStore();
    expect(await pruneExpiredSessions(store, { messages: 'forever' }, NOW)).toBe(0);
    expect(store.pruneOldSessions).not.toHaveBeenCalled();
  });
});

// `runGatewayStart` and `runBoot` boot whole processes and cannot be invoked
// from a unit test — the same source-text idiom as
// `delivery-sweep-wiring.test.ts`.
const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

describe('session retention wiring', () => {
  it('gateway.ts prunes sessions at boot and on the hourly retention timer', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
    const timer = src.indexOf('const retentionPruneTimer = setInterval(() => {');
    expect(timer).toBeGreaterThan(-1);
    const body = src.slice(timer, src.indexOf('}, 3_600_000);', timer));
    expect(body).toContain('pruneSessions();');
    expect(src.slice(0, timer)).toContain('pruneSessions();');
  });

  it('boot.ts prunes sessions on its hourly prune timer', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf8');
    expect(src).toContain('pruneExpiredSessions(');
  });
});
