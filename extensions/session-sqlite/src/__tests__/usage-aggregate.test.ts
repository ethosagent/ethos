import { forkSession } from '@ethosagent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

// AN-D1 — spend/token aggregates read from `messages`, not the per-session
// rollup: a session straddling the window boundary would otherwise put all of
// its spend on whichever side it started.

const base = {
  platform: 'slack',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  workingDir: '/tmp',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

describe('usageAggregate', () => {
  let store: SQLiteSessionStore;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  async function seed(): Promise<void> {
    const a = await store.createSession({ ...base, key: 'k1', personalityId: 'ops' } as never);
    const b = await store.createSession({
      ...base,
      key: 'k2',
      personalityId: 'research',
      platform: 'discord',
      model: 'claude-sonnet-4-7',
    } as never);
    for (const [session, cost] of [
      [a, 1.5],
      [a, 0.5],
      [b, 2.0],
    ] as const) {
      await store.appendMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'x',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 300,
          cacheCreationTokens: 100,
          estimatedCostUsd: cost,
        },
      });
    }
  }

  const window = { since: new Date(0), until: new Date(Date.now() + 60_000) };

  it('groups by personality', async () => {
    await seed();
    const rows = await store.usageAggregate({ ...window, dimension: 'personality' });
    // Sorted here, not asserted in query order: both personalities cost $2, and
    // the query's cost-DESC ordering leaves a tie unordered.
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(Object.keys(byKey).sort()).toEqual(['ops', 'research']);
    expect(byKey.ops).toMatchObject({ estimatedCostUsd: 2, messages: 2 });
    expect(byKey.research).toMatchObject({ estimatedCostUsd: 2, messages: 1 });
  });

  it('groups by channel and model', async () => {
    await seed();
    const byChannel = await store.usageAggregate({ ...window, dimension: 'channel' });
    expect(byChannel.map((r) => r.key).sort()).toEqual(['discord', 'slack']);

    const byModel = await store.usageAggregate({ ...window, dimension: 'model' });
    expect(byModel.map((r) => r.key).sort()).toEqual(['claude-opus-4-7', 'claude-sonnet-4-7']);
  });

  it('groups by UTC day', async () => {
    await seed();
    const rows = await store.usageAggregate({ ...window, dimension: 'day' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0]?.estimatedCostUsd).toBe(4);
  });

  it('carries cache tokens through so the hit rate can be derived', async () => {
    await seed();
    const [row] = await store.usageAggregate({ ...window, dimension: 'day' });
    expect(row).toMatchObject({ cacheReadTokens: 900, cacheCreationTokens: 300 });
  });

  it('excludes messages outside the window', async () => {
    await seed();
    const past = { since: new Date(0), until: new Date(1) };
    expect(await store.usageAggregate({ ...past, dimension: 'day' })).toEqual([]);
  });

  // Plan openclaw-2026.9.6-gaps D5 — one bot's spend is the sessions whose key
  // starts with its lane prefix (`buildLaneKey(platform, botKey)` + ':').
  it('keyPrefix narrows to sessions whose key starts with it, literally', async () => {
    for (const [key, cost] of [
      ['telegram:bot_1:c1', 1],
      ['telegram:bot_1:c2:1700000000000', 2],
      ['telegram:botX1:c1', 4], // `_` must not match any character
      ['slack:bot_1:c1', 8],
    ] as const) {
      const s = await store.createSession({ ...base, key } as never);
      await store.appendMessage({
        sessionId: s.id,
        role: 'assistant',
        content: 'x',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: cost,
        },
      });
    }
    const rows = await store.usageAggregate({
      ...window,
      dimension: 'day',
      keyPrefix: 'telegram:bot_1:',
    });
    expect(rows.reduce((sum, r) => sum + r.estimatedCostUsd, 0)).toBe(3);
  });

  // SQLite's LIKE folds ASCII case, so two bots whose ids differ only by case
  // would each be billed the other's spend.
  it('keyPrefix is case-sensitive', async () => {
    for (const [key, cost] of [
      ['telegram:Sales:c1', 1],
      ['telegram:sales:c1', 2],
      ['telegram:SALES:c1', 4],
      ['telegram:sal%s:c1', 8],
    ] as const) {
      const s = await store.createSession({ ...base, key } as never);
      await store.appendMessage({
        sessionId: s.id,
        role: 'assistant',
        content: 'x',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: cost,
        },
      });
    }
    const total = async (keyPrefix: string) =>
      (await store.usageAggregate({ ...window, dimension: 'day', keyPrefix })).reduce(
        (sum, r) => sum + r.estimatedCostUsd,
        0,
      );
    expect(await total('telegram:Sales:')).toBe(1);
    expect(await total('telegram:sales:')).toBe(2);
    expect(await total('telegram:sal%s:')).toBe(8);
  });

  // A fork replays its source's history with fresh timestamps. The copies are
  // history, not spend: counting them bills the source's turns twice in
  // `ethos usage`, the per-bot daily cap and the web Usage view.
  it("does not count a fork's copied history as new spend", async () => {
    await seed();
    const [source] = await store.listSessions({});
    if (!source) throw new Error('no source session');
    const before = await store.usageAggregate({ ...window, dimension: 'day' });
    await forkSession(store, source.id, { key: `${source.key}:fork` });
    const after = await store.usageAggregate({ ...window, dimension: 'day' });
    expect(after).toEqual(before);
  });

  // A tool-reported `cost_usd` is stored on its tool_result row with zero
  // tokens (packages/core/src/agent-loop/tool-cost.ts `toolCostFields`).
  it("counts a tool_result row's tool-reported cost", async () => {
    const s = await store.createSession({ ...base, key: 'k4' } as never);
    await store.appendMessage({
      sessionId: s.id,
      role: 'tool_result',
      content: 'painted',
      toolCallId: 'c1',
      toolName: 'paint',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.25,
      },
    });
    const [row] = await store.usageAggregate({ ...window, dimension: 'day' });
    expect(row).toMatchObject({ estimatedCostUsd: 0.25, inputTokens: 0, messages: 1 });
  });

  it('ignores rows with no token counts', async () => {
    const s = await store.createSession({ ...base, key: 'k3' } as never);
    // A user message has no usage — it is not a billable row.
    await store.appendMessage({ sessionId: s.id, role: 'user', content: 'hello' });
    expect(await store.usageAggregate({ ...window, dimension: 'day' })).toEqual([]);
  });
});
