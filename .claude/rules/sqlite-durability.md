---
paths:
  - "extensions/session-sqlite/**"
  - "extensions/memory-vector/**"
  - "extensions/job-store/**"
  - "extensions/delivery-ledger/**"
  - "extensions/session-cards/**"
  - "extensions/call-log/**"
  - "extensions/inbound-dedup/**"
  - "extensions/inbound-spool/**"
  - "extensions/channel-transcript-sqlite/**"
  - "extensions/notify-queue/**"
  - "extensions/outbox/**"
  - "extensions/observability-sqlite/**"
  - "packages/a2a/src/sqlite-task-store.ts"
  - "packages/sqlite/**"
---

# SQLite durability posture

SQLite durability posture (`synchronous`)
Every store above runs `journal_mode = WAL`. The `synchronous` setting on top of it is decided PER STORE, and it is not a performance knob — it is a durability trade. Do not sweep it across the roster in either direction.

What the trade is, per [sqlite.org](https://www.sqlite.org/pragma.html#pragma_synchronous): in WAL mode `synchronous = NORMAL` is "safe from corruption" and "always consistent", but it stops fsyncing the WAL on every commit, so "a transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system crash". Application crashes lose nothing — the OS still holds the writes. The exposure is exactly: a power cut or kernel panic can drop the last few transactions. Measured on this repo's write paths, that fsync is ~4.5 ms and is 42x–330x the cost of the write it protects; the cost is per-COMMIT, not per-row, so it is the same ~4.5 ms whatever the row holds.

`NORMAL` — reconstructible or expendable data on a hot path:

| Store | Why NORMAL is safe here |
|---|---|
| `extensions/channel-transcript-sqlite/` | Observational: lines other people said in a watched room, on a retention window with a prune cron. One commit per observed message, inline on the gateway's inbound path, in a synchronous API — every ms stops the event loop for every bot. |
| `extensions/observability-sqlite/` | Telemetry with an explicit retention window. Many commits per turn (a span per tool call and per LLM call, plus events and counters). The tail a power cut drops belongs to a turn that did not finish either. |
| `extensions/session-cards/` | A card is a rendering of a tool result, and the store already degrades one card at a time by design (an unparseable row is skipped on read). |

`FULL` — a lost transaction breaks a guarantee made elsewhere. All of these are pinned by a `durability posture` test in the store's own `__tests__`, so a blanket change cannot take them silently:

| Store | Why FULL stays | Hot? |
|---|---|---|
| `extensions/delivery-ledger/` | Its whole purpose. An obligation is written `pending` BEFORE the platform call so the sweep can redeliver; losing that row loses the reply for good. | No — ~2 commits per reply. |
| `extensions/job-store/` | A `queued` row is often the only record that work is owed, and the user was told the job started. | No — a few commits per job; heartbeat is 30s. |
| `extensions/notify-queue/` | A queued wake notice is work owed to a person; a lost enqueue is never retried. | No — one commit per notification. |
| `extensions/outbox/` | A pending publication is work owed to a person; a lost approve silently drops it. | No — a handful of commits per publication. |
| `extensions/inbound-dedup/` | It IS the durable half of dedup. A power cut is the one restart that can roll back the last sightings, and a platform retry afterwards is a second billed LLM turn replying to an answered message. | No — `seen()` runs only on an in-memory Set miss. |
| `extensions/inbound-spool/` | A `received` row is a message the user sent and was never answered; losing it is the failure the store exists to prevent. | No — a turn is three commits (`accept`, `markProcessing`, `markDone`) around an LLM turn that takes seconds, four when it starts a tool (`markToolStarted`); a message consumed without a turn is two (`accept`, `markDone`), and so is a steer folded into a running turn (`accept`, `markAbsorbed` — its terminal rides in its turn's `markDone` transaction). |
| `extensions/call-log/` | `ringing`/`live` rows are LIVE STATE, not history — nothing deletes them however old they look. | No — a few commits per phone call. |
| `packages/a2a/src/sqlite-task-store.ts` | The idempotency key surviving a restart is the point of the store; losing it re-runs a task that already ran. | No — writes at task boundaries. |
| `extensions/memory-vector/` | `memory.db` is the source of truth for memory content, not an index over it — `exportTo` writes markdown, but nothing rebuilds the table from it. | No — every write is gated behind an embedding pass. |
| `extensions/session-sqlite/` (store, context log, api-key store — three handles on one file, and `synchronous` is per-connection) | sessions.db is the agent's memory; the reply has already gone out, so a rolled-back tail leaves the transcript and the user's chat window disagreeing. An API key is shown once and never again. | No — a handful of rows around an LLM call that takes seconds. |
| `extensions/session-sqlite/src/usage-ledger.ts` (`SQLiteUsageLedger`, a fourth handle on sessions.db) | The bot daily spend cap counts these rows for model calls made outside a turn; a rolled-back tail under-counts spend the operator was promised a cap on. Pinned by the `durability posture` case in `__tests__/usage-ledger.test.ts`. | No — a handful of commits per turn, beside LLM calls that take seconds. |

The setting deliberately does NOT live in `packages/sqlite` (the shim). A shim-wide default would be exactly the blanket decision this table exists to prevent. Stores outside this roster (`kanban-store`, `goal-store`, `dashboard`, web-api's `idempotency-store`) have not been assessed and remain at SQLite's `FULL` default.
