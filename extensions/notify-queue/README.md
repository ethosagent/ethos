# @ethosagent/notify-queue

## Purpose

Two small SQLite queues. The pending-notify queue holds passive `notify`-mode deliveries for a peer personality until its next turn reads and consumes them, keyed by team and assignee. The `held_notices` table holds channel notices the gateway delays for quiet hours or a mute. Writing and sweeping are left to the ACP server and the gateway.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteNotifyQueue` | class | SQLite implementation: write, `readAndConsume`, and the held-notice methods. |
| `PendingNotifyQueue` | interface | Queue contract consumers depend on. |
| `PendingNotify` | interface | One queued notification. |
| `WritePendingNotifyInput` | interface | Input to write a notification. |
| `HeldChannelNotice` | interface | One held channel notice. |

## Seam

Implements its own `PendingNotifyQueue` (`implements PendingNotifyQueue` in `src/index.ts`), not an `@ethosagent/types` interface. Archcheck layer: `extensions`. Listed in `.claude/rules/sqlite-durability.md` (a lost enqueue is never retried).

Pinned by `src/__tests__/notify-queue.test.ts`: rows are isolated per team and assignee, returned oldest first, never double-delivered by a second `readAndConsume`, and the file stays at `synchronous = FULL`. `src/__tests__/held-notices.test.ts` pins that a held notice survives reopening the file.

## Testing

```
pnpm vitest run extensions/notify-queue
```

Pinning tests in `src/__tests__/`: `src/__tests__/notify-queue.test.ts` (write, consume, ordering, isolation, durability posture), `src/__tests__/held-notices.test.ts` (hold, list oldest first, forget on release, persistence).
