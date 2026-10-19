// plan background-usage-accounting §5.4 / D33 — `withUsageMeter` is how a command
// with no AgentLoop (nightly, eval --evolve, personality evolve) records its
// model calls. Rows land in `<dataDir>/sessions.db` where `ethos usage` reads them.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { withUsageMeter } from '../index';
import { scriptedProvider, usageChunk } from './helpers/usage-test-kit';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('withUsageMeter', () => {
  it('records a metered call as an operator ledger row that usageAggregate reports by source', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ethos-open-meter-'));
    dirs.push(dataDir);
    await withUsageMeter({ dataDir }, async (meter) => {
      const llm = meter.meter(
        scriptedProvider([{ type: 'text_delta', text: 'hi' }, usageChunk(100, 20, 0.25)]),
        'nightly',
      );
      for await (const _ of llm.complete([{ role: 'user', content: 'x' }], [], {})) {
        // drain
      }
    });

    const store = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
    try {
      const rows = await store.usageAggregate({
        since: new Date(Date.now() - 60_000),
        until: new Date(Date.now() + 60_000),
        dimension: 'source',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: 'operator:nightly', calls: 1, messages: 0 });
      expect(rows[0]?.estimatedCostUsd).toBeCloseTo(0.25, 6);
    } finally {
      store.close();
    }
  });

  it('opens no ledger handle when no model call is made', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ethos-open-meter-'));
    dirs.push(dataDir);
    const result = await withUsageMeter({ dataDir }, async (meter) => {
      meter.meter(scriptedProvider([]), 'nightly');
      return 'done';
    });
    expect(result).toBe('done');
    expect(existsSync(join(dataDir, 'sessions.db'))).toBe(false);
  });

  it('closes the ledger and rethrows when the callback throws', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ethos-open-meter-'));
    dirs.push(dataDir);
    await expect(
      withUsageMeter({ dataDir }, async (meter) => {
        meter.recordExternal({
          kind: 'nightly',
          provider: 'p',
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0.01,
          outcome: 'ok',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(join(dataDir, 'sessions.db'))).toBe(true);
  });
});
