import type Database from '@ethosagent/sqlite';
import type {
  ExplorationState,
  GateId,
  InitiativeState,
  InitiativeVerdict,
} from '@ethosagent/types';

/**
 * Raise an exploration's budget and move its deadline (a "dig deeper" reopened it). The new
 * budget is added to what the exploration has already spent, so `budget_usd - spent_usd` is
 * exactly `addBudgetUsd` afterwards. Returns false when the id does not exist. Call inside the
 * store's `write` transaction.
 */
export function extendExplorationRow(
  db: Database.Database,
  id: string,
  e: { addBudgetUsd: number; deadline: string },
  at: string,
): boolean {
  const r = db
    .prepare(
      'UPDATE explorations SET budget_usd = spent_usd + ?, deadline = ?, updated_at = ? WHERE id = ?',
    )
    .run(e.addBudgetUsd, e.deadline, at, id);
  return r.changes > 0;
}

/** Creation time, last owner reaction and stop reason of one initiative; null when it does not exist. */
export function reactionClockRow(
  db: Database.Database,
  id: string,
): { createdAt: string; lastReactionAt: string | null; stopReason: string | null } | null {
  const r = db
    .prepare('SELECT created_at, last_reaction_at, stop_reason FROM initiatives WHERE id = ?')
    .get(id) as
    | { created_at: string; last_reaction_at: string | null; stop_reason: string | null }
    | undefined;
  return r
    ? { createdAt: r.created_at, lastReactionAt: r.last_reaction_at, stopReason: r.stop_reason }
    : null;
}

/**
 * The budget a new exploration gets: the agent's own estimate, never above the initiative's
 * `usd_per_exploration`. An id the cap resolver does not know gets 0 (fail closed, like `capFor`).
 * Enforced where the row is written: `SQLiteInitiativeStore.propose`.
 */
export function clampExplorationBudget(estimateUsd: number, capUsd: number): number {
  return Math.max(0, Math.min(estimateUsd, capUsd));
}

/**
 * What a decision implies. `exploration` targets an exploration id (gate 1 and
 * 2), `initiative` an initiative id (self-start). A gate or verdict missing here
 * is refused; `config_change` implies no transition and accepts any verdict.
 */
export const IMPLIED: Partial<
  Record<
    GateId,
    Partial<
      Record<
        InitiativeVerdict,
        { exploration: ExplorationState | null } | { initiative: InitiativeState }
      >
    >
  >
> = {
  gate1_explore: {
    approve: { exploration: 'exploring' },
    reject: { exploration: 'rejected' },
    snooze: { exploration: null },
  },
  gate2_adopt: {
    adopt: { exploration: 'adopted' },
    park: { exploration: 'parked' },
    dig_deeper: { exploration: 'exploring' },
  },
  self_start: {
    keep: { initiative: 'active' },
    stop: { initiative: 'stopped' },
    make_mine: { initiative: 'active' },
  },
};
