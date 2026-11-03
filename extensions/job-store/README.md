# @ethosagent/job-store

## Purpose

SQLite-backed `JobStore` for background jobs: the queued, running, blocked and terminal lifecycle, heartbeats, stale reclaim, cancel requests, an event log, and exactly-once delivery and notice claims. It persists and arbitrates job rows; executing them is `extensions/job-runner`.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteJobStore` | class | `JobStore` over a STRICT SQLite file: `claimNextQueued`, `heartbeat`, `finish`, `markBlocked`, `reclaimStale`, `getEvents`, `claimDelivery`, `pruneTerminal`. |

## Seam

Implements `JobStore` from `@ethosagent/types` (`implements JobStore` in `src/index.ts`). Archcheck layer: `extensions`. Listed in `.claude/rules/sqlite-durability.md` (a `queued` row may be the only record that work is owed).

Pinned by `src/__tests__/job-store.test.ts`: `claimNextQueued` enforces owner isolation, `finish` from a terminal status throws, `reclaimStale` ignores blocked rows, blocked rows are not pruned, `claimDelivery` is won exactly once, a room audience value that was hand-edited to an unknown string reads as shared, a database whose `user_version` is newer than the code is refused, and the file stays at `synchronous = FULL`.

## Testing

```
pnpm vitest run extensions/job-store
```

Pinning test: `src/__tests__/job-store.test.ts` holds the lifecycle transitions, blocked-row semantics, claim races across two connections, bounded event paging on a 10k-event job, the v1 to v10 migration, taint and narrowing round-trips, and heartbeat bumping after a host pause.
