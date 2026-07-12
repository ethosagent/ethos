import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';

interface UsageResult {
  since: string;
  until: string;
  truncated: boolean;
  totals: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  byProvider: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }>;
  byPersonality: Array<{ personality: string; turnCount: number; estimatedCostUsd: number }>;
}

export function parseDuration(raw: string): number {
  const m = raw.match(/^(\d+)(h|d|m)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  if (unit === 'm') return n * 60 * 1000;
  return 0;
}

export async function runUsage(argv: string[]): Promise<void> {
  const sinceIdx = argv.indexOf('--since');
  const sinceRaw = sinceIdx !== -1 ? argv[sinceIdx + 1] : undefined;
  const jsonMode = argv.includes('--json');

  if (!sinceRaw) {
    console.error('Usage: ethos usage --since <duration> [--json]');
    console.error('  duration: Nh (hours), Nd (days), Nm (minutes)');
    process.exit(2);
  }

  const durationMs = parseDuration(sinceRaw);
  if (durationMs === 0) {
    console.error(`Invalid duration: ${sinceRaw}. Use Nh, Nd, or Nm (e.g. 24h, 7d, 30m).`);
    process.exit(2);
  }

  const now = new Date();
  const since = new Date(now.getTime() - durationMs);

  const dbPath = join(ethosDir(), 'sessions.db');
  let store: SQLiteSessionStore;
  try {
    store = new SQLiteSessionStore(dbPath);
  } catch {
    // DB doesn't exist on fresh installs — return empty results
    const empty: UsageResult = {
      since: since.toISOString(),
      until: now.toISOString(),
      truncated: false,
      totals: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      byProvider: [],
      byPersonality: [],
    };
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(empty)}\n`);
    } else {
      console.log('No usage data (sessions database not found).');
    }
    return;
  }

  try {
    const SESSION_LIMIT = 10_000;
    const sessions = await store.listSessions({ since, limit: SESSION_LIMIT });
    const truncated = sessions.length >= SESSION_LIMIT;

    const totals = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    const providerMap = new Map<
      string,
      {
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd: number;
      }
    >();
    const personalityMap = new Map<
      string,
      { personality: string; turnCount: number; estimatedCostUsd: number }
    >();

    for (const s of sessions) {
      totals.inputTokens += s.usage.inputTokens;
      totals.outputTokens += s.usage.outputTokens;
      totals.estimatedCostUsd += s.usage.estimatedCostUsd;

      const provKey = `${s.provider}:${s.model}`;
      const existing = providerMap.get(provKey);
      if (existing) {
        existing.inputTokens += s.usage.inputTokens;
        existing.outputTokens += s.usage.outputTokens;
        existing.estimatedCostUsd += s.usage.estimatedCostUsd;
      } else {
        providerMap.set(provKey, {
          provider: s.provider,
          model: s.model,
          inputTokens: s.usage.inputTokens,
          outputTokens: s.usage.outputTokens,
          estimatedCostUsd: s.usage.estimatedCostUsd,
        });
      }

      const pid = s.personalityId ?? 'unknown';
      const pExisting = personalityMap.get(pid);
      if (pExisting) {
        pExisting.turnCount += s.usage.apiCallCount;
        pExisting.estimatedCostUsd += s.usage.estimatedCostUsd;
      } else {
        personalityMap.set(pid, {
          personality: pid,
          turnCount: s.usage.apiCallCount,
          estimatedCostUsd: s.usage.estimatedCostUsd,
        });
      }
    }

    // Round costs
    totals.estimatedCostUsd = Math.round(totals.estimatedCostUsd * 100) / 100;

    const result: UsageResult = {
      since: since.toISOString(),
      until: now.toISOString(),
      truncated,
      totals,
      byProvider: [...providerMap.values()].map((p) => ({
        ...p,
        estimatedCostUsd: Math.round(p.estimatedCostUsd * 100) / 100,
      })),
      byPersonality: [...personalityMap.values()].map((p) => ({
        ...p,
        estimatedCostUsd: Math.round(p.estimatedCostUsd * 100) / 100,
      })),
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      console.log(`Usage from ${since.toISOString()} to ${now.toISOString()}\n`);
      console.log(
        `  Total tokens: ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out`,
      );
      console.log(`  Estimated cost: $${totals.estimatedCostUsd.toFixed(2)}`);
      if (result.byProvider.length > 0) {
        console.log('\n  By provider:');
        for (const p of result.byProvider) {
          console.log(
            `    ${p.provider}/${p.model}: $${p.estimatedCostUsd.toFixed(2)}` +
              ` (${p.inputTokens.toLocaleString()} in / ${p.outputTokens.toLocaleString()} out)`,
          );
        }
      }
      if (result.byPersonality.length > 0) {
        console.log('\n  By personality:');
        for (const p of result.byPersonality) {
          console.log(
            `    ${p.personality}: $${p.estimatedCostUsd.toFixed(2)} (${p.turnCount} turns)`,
          );
        }
      }
      if (truncated) {
        console.log(
          `\n  ⚠ Results truncated at ${SESSION_LIMIT.toLocaleString()} sessions. Narrow the --since window for complete data.`,
        );
      }
    }
  } finally {
    store.close();
  }
}
