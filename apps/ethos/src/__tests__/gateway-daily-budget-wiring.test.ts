// Plan openclaw-2026.9.6-gaps D5 — the per-bot daily cap in production.
//
// Pinned here:
//  - `botSpendSince` sums one bot's spend from `usageAggregate` (the
//    aggregation `ethos usage` reads), narrowed to that bot's session keys
//    (runtime, over an in-memory sessions.db);
//  - `buildGateway` hands it to the Gateway, and `assembleGatewayBots` carries
//    each entry's `budget.dailyUsd` onto its bot (source text — the same idiom
//    as `gateway-observability-wiring.test.ts`, because both need a whole
//    process to reach at runtime).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { describe, expect, it } from 'vitest';
import { botSpendSince } from '../commands/gateway';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const usage = (cost: number) => ({
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: cost,
});

describe('per-bot daily budget wiring (D5)', () => {
  it('botSpendSince sums only the named bot’s sessions', async () => {
    const store = new SQLiteSessionStore(':memory:');
    try {
      for (const [key, cost] of [
        ['telegram:bot-1:c1', 0.5],
        ['telegram:bot-1:c2:1700000000000', 0.25],
        ['telegram:bot-2:c1', 4],
      ] as const) {
        const s = await store.createSession({
          key,
          platform: 'telegram',
          model: 'm',
          provider: 'p',
          usage: { ...usage(0), apiCallCount: 0, compactionCount: 0 },
        } as never);
        await store.appendMessage({
          sessionId: s.id,
          role: 'assistant',
          content: 'x',
          usage: usage(cost),
        });
      }
      const spent = await botSpendSince('telegram:bot-1:', new Date(0), () => store);
      expect(spent).toBe(0.75);
    } finally {
      store.close();
    }
  });

  it('buildGateway wires botSpendSince and bots carry their budget.dailyUsd', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
    expect(src).toContain('botSpendSince: (prefix, since) => botSpendSince(prefix, since)');
    expect(src).toContain('...(bot.budget ? { dailyBudgetUsd: bot.budget.dailyUsd } : {})');
    expect(src).toContain('...(waCfg.budget ? { dailyBudgetUsd: waCfg.budget.dailyUsd } : {})');
  });
});
