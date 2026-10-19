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
import { SQLiteSessionStore, SQLiteUsageLedger } from '@ethosagent/session-sqlite';
import type { UsageRecord } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { botSpendSince, gatewayTurnOrigin } from '../commands/gateway';

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
    const ledger = new SQLiteUsageLedger(':memory:');
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
      const spent = await botSpendSince(
        { sessionKeyPrefix: 'telegram:bot-1:', botKey: 'bot-1' },
        new Date(0),
        () => store,
        () => ledger,
      );
      expect(spent).toEqual({ repliesUsd: 0.75, backgroundUsd: 0 });
    } finally {
      store.close();
      ledger.close();
    }
  });

  it('buildGateway wires botSpendSince and bots carry their budget', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
    expect(src).toContain('botSpendSince: (scope, since) => botSpendSince(scope, since)');
    // The whole `budget` (cap and D14's `backgroundBlocksReplies`) as one object.
    expect(src).toContain('budget: bot.budget,');
    expect(src).toContain('budget: waCfg.budget,');
  });
});

// background-usage-accounting D40 — replies vs background.
describe('botSpendSince reads the usage ledger too', () => {
  const ledgerRow = (over: Partial<UsageRecord>): UsageRecord => ({
    ts: new Date().toISOString(),
    kind: 'memory_capture',
    sourceClass: 'background',
    provider: 'p',
    model: 'm',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    outcome: 'ok',
    ...over,
  });

  it('splits reply (turn + turn-utility) and background spend without double counting', async () => {
    const store = new SQLiteSessionStore(':memory:');
    const ledger = new SQLiteUsageLedger(':memory:');
    try {
      const s = await store.createSession({
        key: 'telegram:bot-1:c1',
        platform: 'telegram',
        model: 'm',
        provider: 'p',
        usage: { ...usage(0), apiCallCount: 0, compactionCount: 0 },
      } as never);
      await store.appendMessage({
        sessionId: s.id,
        role: 'assistant',
        content: 'x',
        usage: usage(1),
      });
      // A background row matched by bot_key alone (no session key).
      ledger.record(ledgerRow({ botKey: 'bot-1', estimatedCostUsd: 0.25 }));
      // A utility row matched by BOTH bot_key and the session-key prefix: once.
      ledger.record(
        ledgerRow({
          kind: 'compaction',
          sourceClass: 'turn_utility',
          botKey: 'bot-1',
          sessionKey: 'telegram:bot-1:c1',
          estimatedCostUsd: 0.5,
        }),
      );
      // Another bot's row.
      ledger.record(ledgerRow({ botKey: 'bot-2', estimatedCostUsd: 9 }));
      const spent = await botSpendSince(
        { sessionKeyPrefix: 'telegram:bot-1:', botKey: 'bot-1' },
        new Date(0),
        () => store,
        () => ledger,
      );
      expect(spent).toEqual({ repliesUsd: 1.5, backgroundUsd: 0.25 });
    } finally {
      store.close();
      ledger.close();
    }
  });

  it('every gateway-built loop gets the late-bound background gate', async () => {
    // Before the Gateway exists the gate allows; it never throws.
    const origin = gatewayTurnOrigin(() => null);
    expect(
      await origin.backgroundGate({ kind: 'memory_capture', attribution: { botKey: 'bot-1' } }),
    ).toEqual({ decision: 'allow' });
  });
});
