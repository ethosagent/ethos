import type { Constitution, InitiativeStore } from '@ethosagent/types';

/**
 * In-process keyed mutex. A run reads what is left of the day's money before it starts, so two
 * runs sharing a cap in one process (the tick and a manual run, two agent initiatives on the
 * pool) must not read at the same time. Keys are taken in sorted order, so two runs cannot
 * deadlock.
 *
 * This only orders runs inside ONE process. The enforcer across processes (the CLI beside
 * `ethos serve`) is the reservation `reserveAndOpenWindow` writes in initiatives.db in the
 * transaction that opens the window (`reserveWindow` in extensions/initiative-store/src/
 * reservations.ts, pinned by its __tests__/reservations.test.ts).
 */
export interface KeyedLock {
  run<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T>;
}

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>();
  const acquire = async (key: string): Promise<() => void> => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    return () => {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    };
  };
  return {
    async run(keys, fn) {
      const held: Array<() => void> = [];
      try {
        for (const key of [...new Set(keys)].sort()) held.push(await acquire(key));
        return await fn();
      } finally {
        for (const release of held.reverse()) release();
      }
    },
  };
}

type TotalsStore = Pick<InitiativeStore, 'list' | 'budget'>;

/**
 * What the operator's constitution still allows today across initiatives: the smaller of
 * `maxUsdPerDayPerPersonality` minus the day's spend of every initiative of this personality,
 * and `maxUsdPerDay` minus the day's spend of every initiative of every personality. An absent
 * ceiling is unbounded. `clampInitiativeBudgets` only caps ONE initiative's `usd_per_day`; this
 * is the sum. Pinned by autonomy-day-totals.test.ts.
 */
export function totalsRemainingUsd(input: {
  store: TotalsStore;
  constitution: Constitution['initiatives'];
  personalityId: string;
  personalityIds: readonly string[];
  day: string;
}): number {
  const { store, constitution: c, day } = input;
  const spentBy = (personalityId: string): number =>
    store.list({ personalityId }).reduce((n, row) => n + store.budget(row.id, day).spentUsd, 0);
  let left = Number.POSITIVE_INFINITY;
  if (c?.maxUsdPerDayPerPersonality !== undefined) {
    left = Math.min(left, c.maxUsdPerDayPerPersonality - spentBy(input.personalityId));
  }
  if (c?.maxUsdPerDay !== undefined) {
    const all = new Set([...input.personalityIds, input.personalityId]);
    let total = 0;
    for (const id of all) total += spentBy(id);
    left = Math.min(left, c.maxUsdPerDay - total);
  }
  return Math.max(0, left);
}

/** The day's spend of every agent-origin initiative: the pool's spent half. */
export function agentSpentTodayUsd(
  store: TotalsStore,
  personalityIds: readonly string[],
  day: string,
): number {
  let total = 0;
  for (const id of new Set(personalityIds)) {
    for (const row of store.list({ personalityId: id })) {
      if (row.origin === 'agent') total += store.budget(row.id, day).spentUsd;
    }
  }
  return total;
}
