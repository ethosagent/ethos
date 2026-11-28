import type { Constitution, InitiativeStore } from '@ethosagent/types';

/**
 * In-process keyed mutex. A run reads what is left of the day's money before it starts and
 * its spend only lands when its window closes, so two runs sharing a cap (the tick and the CLI
 * in one process, two agent initiatives on the pool) must not overlap. Keys are taken in sorted
 * order, so two runs cannot deadlock.
 *
 * Limitation (no enforcer): the lock is per process. The CLI process and the `serve` process
 * each have their own, so a manual run beside the scheduled tick can still read the same
 * remaining money; the overshoot is bounded by one run's cap. A cross-process guard would need
 * a lock row in `initiatives.db`.
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
