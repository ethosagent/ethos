# @ethosagent/kanban-store

## Purpose

SQLite task board for agent work: tasks with status, links, comments, runs and events, swarm creation (workers plus verifier and synthesizer), WIP limits, retry budgets, per-assignee stats and an autonomy tier. It owns board state and the operator-context renderer for prompts; scheduling and running tasks belong to the callers.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`). Main entry points; roughly 30 exports, the rest are input and row types.

| Export | Kind | One line |
|---|---|---|
| `KanbanStore` | class | The board: create and list tasks, claim, `blockRun`, `heartbeatRun`, `reclaimTask`, `createSwarm`, `promoteReady`. |
| `KanbanStoreOptions` | interface | Team id, block recurrence limit, WIP caps. |
| `Task` | interface | A board task row. |
| `TaskRun` | interface | One run of a task. |
| `TaskComment` | interface | A human or agent comment. |
| `TaskEvent` | interface | Audit event row. |
| `TaskStatus` | type | `todo`, `ready`, `running`, `blocked`, `done`, `failed`, and others. |
| `BlockKind` | type | Why a task was blocked. |
| `RunOutcome` | type | `completed`, `blocked`, `stalled` or `cancelled`. |
| `CreateSwarmInput` | interface | Input to `createSwarm`. |
| `SwarmResult` | interface | Root, worker, verifier and synthesizer task ids. |
| `TeamMemberStats` | interface | Per-member completion stats. |
| `autonomyTier` | function | Maps stats and a `TrustPolicy` to `probationary`, `standard` or `trusted`. |
| `tierMaxRetries` | function | Retry budget per tier (1, 3, 5). |
| `renderOperatorContext` | function | Renders human comments and the last blocked run summary for a prompt. |
| `newTaskId` | function | Fresh task id. |

## Seam

A concrete store with its own API, not an `@ethosagent/types` contract; it imports only `TurnAudience` from `@ethosagent/types`. Archcheck layer: `extensions`. SQLite posture per `.claude/rules/sqlite-durability.md`; that file lists this store as not yet assessed for `synchronous`, and no test here pins a setting.

Pinned by `src/__tests__/room-audience.test.ts`: a hand-edited room audience value reads as shared, and an existing board gains the column with `user_version` unchanged. `src/__tests__/kanban-store.test.ts` pins refusal to open a database whose `user_version` is newer than the code.

## Testing

```
pnpm vitest run extensions/kanban-store
```

Pinning tests in `src/__tests__/`:

- `src/__tests__/kanban-store.test.ts` holds run lifecycle, swarm creation and rollback, stale-run reclaim, retry budgets and migrations v1 to v3 and beyond.
- `src/__tests__/wip-limits.test.ts` holds the global and per-assignee in-progress caps.
- `src/__tests__/autonomy-tier.test.ts` holds tier thresholds and retry budgets.
- `src/__tests__/prompt-thread.test.ts` holds operator context: human comments only, last 10, character budget.
- `src/__tests__/room-audience.test.ts` holds the audience stamp and its fail-closed read.
