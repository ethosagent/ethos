# @ethosagent/session-lane

## Purpose

`SessionLane` serialises concurrent tasks for the same chat: tasks run one at a time in arrival order, each receiving an `AbortSignal`. It has no dependencies and is used by apps and extensions that must not run two turns for one session at once.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `SessionLane` | class | FIFO queue with `enqueue(task)`, `abort()` and a `length` getter. |

`abort()` aborts the running task's signal and rejects every queued task with `Error('aborted')`.

## Seam

Archcheck layer `support`. No ARCHITECTURE.md Law is specific to this package. Limitation: the package has no tests of its own, so ordering and abort behaviour are not pinned here.

## Testing

```
pnpm vitest run packages/session-lane
```

No test files exist in this package. Consumers with tests that use it include `apps/ethos/src/lib/__tests__/kanban-poll.test.ts`.
