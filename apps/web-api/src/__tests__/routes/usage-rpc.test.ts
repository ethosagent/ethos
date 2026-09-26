import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionStore } from '@ethosagent/core';
import { SQLiteSessionStore, summarizeUsageRows } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { SessionStore } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Plan openclaw-2026.9.6-gaps U3 — `usage.summary` answers with the totals
// `ethos usage` prints for the same window: both fold
// `SQLiteSessionStore.usageAggregate` rows through `summarizeUsageRows`
// (@ethosagent/session-sqlite), so there is one aggregation, not two.

const usage = (cost: number) => ({
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 300,
  cacheCreationTokens: 100,
  estimatedCostUsd: cost,
});

describe('usage RPC (U3)', () => {
  let dataDir: string;
  let store: SQLiteSessionStore;
  let cookie: string;

  async function boot(sessionStore: SessionStore) {
    const app = createWebApi({
      dataDir,
      sessionStore,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;
    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    return app;
  }

  const call = (app: Awaited<ReturnType<typeof boot>>, input: unknown) =>
    app.request('/rpc/usage/summary', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
      body: JSON.stringify({ json: input }),
    });

  async function seed(): Promise<void> {
    for (const [key, personalityId, cost] of [
      ['telegram:bot-1:c1', 'ops', 1.5],
      ['telegram:bot-1:c1', 'ops', 0.5],
      ['web:abc', 'research', 2],
    ] as const) {
      const existing = await store.getSessionByKey(key);
      const s =
        existing ??
        (await store.createSession({
          key,
          platform: key.split(':')[0] ?? 'web',
          model: 'm',
          provider: 'p',
          personalityId,
          usage: { ...usage(0), apiCallCount: 0, compactionCount: 0 },
        } as never));
      await store.appendMessage({
        sessionId: s.id,
        role: 'assistant',
        content: 'x',
        usage: usage(cost),
      });
    }
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-usage-rpc-'));
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns the same totals as the CLI aggregation for a fixture', async () => {
    await seed();
    const app = await boot(store);
    const res = await call(app, { windowMs: 24 * 60 * 60 * 1000, by: 'personality' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      json: {
        totals: Record<string, number>;
        daily: Array<{ key: string; estimatedCostUsd: number }>;
        by: { dimension: string; rows: Array<{ key: string; estimatedCostUsd: number }> };
      };
    };

    const cli = summarizeUsageRows(
      await store.usageAggregate({
        since: new Date(0),
        until: new Date(Date.now() + 60_000),
        dimension: 'day',
      }),
    );
    expect(body.json.totals).toEqual(cli);
    expect(body.json.totals.estimatedCostUsd).toBe(4);
    expect(body.json.daily).toHaveLength(1);
    expect(body.json.by.dimension).toBe('personality');
    expect(Object.fromEntries(body.json.by.rows.map((r) => [r.key, r.estimatedCostUsd]))).toEqual({
      ops: 2,
      research: 2,
    });
  });

  it('a session store with no aggregation answers zeros, not an error', async () => {
    const app = await boot(new InMemorySessionStore());
    const res = await call(app, { windowMs: 60 * 60 * 1000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { totals: { estimatedCostUsd: number } } };
    expect(body.json.totals.estimatedCostUsd).toBe(0);
  });
});
