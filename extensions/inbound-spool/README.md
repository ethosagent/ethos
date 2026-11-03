# @ethosagent/inbound-spool

## Purpose

Write-ahead record of inbound turns the gateway owes. A row is written before any other work, moves through `received`, `processing`, `done`, `dead` and `interrupted`, and is replayed on boot. A turn whose first tool has started is never replayed, only offered back to the user as `interrupted`. The gateway decides when to accept, claim and replay; this package is the store.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`). Main entry points.

| Export | Kind | One line |
|---|---|---|
| `SQLiteInboundSpool` | class | The spool: accept, claim, mark done or failed, replay listing, requeue, discard, prune. |
| `InboundSpool` | interface | Contract the gateway depends on. |
| `InboundSpoolOptions` | interface | Constructor options. |
| `SpoolRow` | interface | One persisted row. |
| `SpoolAccept` | interface | Input row passed to `accept`. |
| `SpoolStatus` | type | The five states. |
| `SpoolKind` | type | `inbound` or `wake_review`. |
| `SpoolStats` | type | Row count per status. |
| `SpoolFailOutcome` | type | Where a failed row lands. |
| `INBOUND_SPOOL_SCHEMA_VERSION` | const | Current schema version, 3. |
| `readSpoolStats` | function | Read-only counts for diagnostics. |
| `readSpoolDead` | function | Read-only list of dead rows. |
| `readSpoolInterrupted` | function | Read-only list of interrupted rows. |
| `readSpoolOrphaned` | function | Rows owned by bot keys that are no longer configured. |
| `requeueSpoolDead` | function | Operator requeue of a dead row. |
| `discardSpoolDead` | function | Operator discard of a dead row. |

## Seam

Durable inbound half of `.claude/rules/gateway-inbound-spool.md`; `extensions/gateway` drives it. Implements its own `InboundSpool` (`implements InboundSpool` in `src/index.ts`). Archcheck layer: `extensions`. Opened through `@ethosagent/sqlite`.

Pinned by `src/__tests__/spool.test.ts`: a tool-started row goes to `interrupted`, not back to `received`; `retryInterrupted` spools the payload fresh exactly once; the claim is exclusive across two store instances on one file; `synchronous = FULL` and `busy_timeout = 5000`.

## Testing

```
pnpm vitest run extensions/inbound-spool
```

Pinning test: `src/__tests__/spool.test.ts` holds accept uniqueness, the state transitions and attempt cap, interrupted handling, replay ordering, v1 and v2 migrations to v3, orphan recovery, retention, durability pragmas, and absorbed steer rows.
