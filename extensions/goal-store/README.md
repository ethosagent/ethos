# @ethosagent/goal-store

## Purpose

SQLite-backed `GoalStore` for long-running goals: the goal row, its attempts, events, plan, per-goal limits and an ownership lease. It stores and leases goals; running them is left to the goal runner that holds the lease.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteGoalStore` | class | `GoalStore` over a STRICT SQLite file: create, status updates, attempts, events, `resumeGoal`, lease heartbeat and orphan sweep. |

## Seam

Implements `GoalStore` from `@ethosagent/types` (`implements GoalStore` on `SQLiteGoalStore` in `src/index.ts`). Archcheck layer: `extensions` (Law 4, rule `extensions-implement-contracts`). Opens its file through `@ethosagent/sqlite`.

Lease behaviour is pinned by `src/__tests__/lease.test.ts`: a heartbeat from a non-owner is ignored, `updateRunStatus` never overwrites `cancelled`, `resumeGoal` claims only from a resumable status, and a peer holding the write lock is waited on rather than throwing `SQLITE_BUSY`. Limitation: `.claude/rules/sqlite-durability.md` lists this store as not yet assessed for `synchronous`, and no test here pins a setting.

## Testing

```
pnpm vitest run extensions/goal-store
```

Pinning tests in `src/__tests__/`:

- `src/__tests__/goal-store.test.ts` round-trips the per-goal limits (`maxToolCallsPerTurn`, `maxIdenticalToolCalls`, `maxRecoveryAttempts`, `allowDangerousToolCalls`) and `planMd`.
- `src/__tests__/lease.test.ts` holds the ownership lease, cancel-against-lease, additive lease columns on an existing v6 database, `resumeGoal`, and write-lock waiting.
