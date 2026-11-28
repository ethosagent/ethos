import type Database from '@ethosagent/sqlite';

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
