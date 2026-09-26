import {
  summarizeUsageRows,
  type UsageAggregateRow,
  type UsageTotals,
} from '@ethosagent/session-sqlite';
import type { SessionStore } from '@ethosagent/types';

// Spend and tokens over a window — the web face of `ethos usage`
// (apps/ethos/src/commands/usage.ts), plan openclaw-2026.9.6-gaps U3.
//
// Same rows, same fold: `SQLiteSessionStore.usageAggregate` read through the
// session store web-api already holds, folded by `summarizeUsageRows`. The
// aggregation is not on the `SessionStore` contract (it is a SQLite query), so
// a store without it — the in-memory one tests use — answers zeros rather than
// failing the page.

export type UsageDimension = 'model' | 'personality' | 'channel' | 'session';

interface UsageAggregator {
  usageAggregate(opts: {
    since: Date;
    until: Date;
    dimension: 'day' | UsageDimension;
  }): Promise<UsageAggregateRow[]>;
}

function isAggregator(store: SessionStore): store is SessionStore & UsageAggregator {
  return 'usageAggregate' in store && typeof store.usageAggregate === 'function';
}

export interface UsageSummary {
  since: number;
  until: number;
  totals: UsageTotals;
  daily: UsageAggregateRow[];
  by?: { dimension: UsageDimension; rows: UsageAggregateRow[] };
}

export class UsageService {
  constructor(private readonly sessions: SessionStore) {}

  async summary(input: { windowMs: number; by?: UsageDimension }): Promise<UsageSummary> {
    const until = new Date();
    const since = new Date(until.getTime() - input.windowMs);
    const store = this.sessions;
    const aggregate = isAggregator(store)
      ? (dimension: 'day' | UsageDimension) => store.usageAggregate({ since, until, dimension })
      : async () => [];
    const daily = await aggregate('day');
    const by = input.by ? { dimension: input.by, rows: await aggregate(input.by) } : undefined;
    return {
      since: since.getTime(),
      until: until.getTime(),
      totals: summarizeUsageRows(daily),
      daily,
      ...(by ? { by } : {}),
    };
  }
}
