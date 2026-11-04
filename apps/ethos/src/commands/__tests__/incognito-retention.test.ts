// Incognito 24 h sweep (plan/phases/incognito-sessions.md D7/D8) — the helper
// and its hourly wiring in gateway, boot and serve.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INCOGNITO_MAX_AGE_MS } from '@ethosagent/wiring';
import { describe, expect, it, vi } from 'vitest';
import { scrubExpiredIncognito } from '../../lib/incognito-retention';

const NOW = Date.parse('2026-11-04T00:00:00Z');

describe('scrubExpiredIncognito', () => {
  it('scrubs sessions older than the 24 h cutoff', async () => {
    const scrubIncognito = vi.fn(async () => ({ messages: 2, sessionIds: ['a'] }));
    const out = await scrubExpiredIncognito({ scrubIncognito }, { now: NOW });
    expect(out).toEqual({ messages: 2, sessionIds: ['a'] });
    expect(INCOGNITO_MAX_AGE_MS).toBe(24 * 3_600_000);
    expect(scrubIncognito).toHaveBeenCalledWith({
      olderThan: new Date(NOW - INCOGNITO_MAX_AGE_MS),
    });
  });

  it('is a no-op on a store without scrubIncognito', async () => {
    expect(await scrubExpiredIncognito({}, { now: NOW })).toEqual({ messages: 0, sessionIds: [] });
  });
});

// Host entrypoints boot whole processes — source-text idiom, as in
// session-retention.test.ts.
const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFile(join(ROOT, 'apps/ethos/src/commands', p), 'utf8');

describe('incognito sweep wiring', () => {
  it('gateway.ts sweeps on the hourly retention timer and closes the store', async () => {
    const src = await read('gateway.ts');
    const timer = src.indexOf('const retentionPruneTimer = setInterval(() => {');
    const body = src.slice(timer, src.indexOf('}, 3_600_000);', timer));
    expect(body).toContain('pruneSessions();');
    expect(src).toContain('scrubExpiredIncognito(store)');
  });

  it('boot.ts sweeps on its hourly prune tick', async () => {
    expect(await read('boot.ts')).toContain('scrubExpiredIncognito(session)');
  });

  it('serve.ts runs an hourly sweep and stops it on shutdown', async () => {
    const src = await read('serve.ts');
    expect(src).toContain('scrubExpiredIncognito(session)');
    expect(src).toContain('const incognitoSweepTimer = setInterval(sweepIncognito, 3_600_000);');
    expect(src).toContain('clearInterval(incognitoSweepTimer);');
  });
});
