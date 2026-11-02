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
  - "packages/a2a/src/sqlite-task-store.ts"
---

# Raw node:fs carve-outs: SQLite stores

Allowed exceptions (these stay raw node:fs):

extensions/session-sqlite/, extensions/memory-vector/ — SQLite via @ethosagent/sqlite opens raw paths and manages WAL/SHM natively
extensions/job-store/ — SQLiteJobStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir (same rationale as session-sqlite/memory-vector)
extensions/delivery-ledger/ — SQLiteDeliveryLedger opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its atomic redelivery claim is a conditional UPDATE inside a transaction, which no Storage interface can express
extensions/session-cards/ — SQLiteCardStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its per-session `seq` derivation is a MAX()+1 read inside the insert's transaction, which no Storage interface can express (same rationale as job-store/delivery-ledger)
extensions/call-log/ — SQLiteCallLog opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir (same rationale as job-store/delivery-ledger/session-cards)
extensions/inbound-dedup/ — SQLiteInboundDedupStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its check-and-record is a single `INSERT OR IGNORE` whose affected-row count IS the answer, which no Storage interface can express (same rationale as job-store/delivery-ledger/session-cards/call-log)
extensions/inbound-spool/ — SQLiteInboundSpool opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its replay claim is a conditional UPDATE inside a transaction, which no Storage interface can express (same rationale as delivery-ledger/notify-queue)
extensions/channel-transcript-sqlite/ — SQLiteChannelTranscriptStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; `pruneChannelTranscript` additionally existsSync's the db file so a prune on a deployment that never enabled observe mode is a no-op rather than a call that CREATES an empty database on every machine (same rationale as job-store/delivery-ledger/session-cards/call-log/inbound-dedup)
packages/a2a/src/sqlite-task-store.ts — SQLiteA2aTaskStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir (same rationale as job-store/delivery-ledger/session-cards/call-log); the A2A async task store, so a task's terminal state and idempotency key survive an `ethos serve` restart

extensions/notify-queue/ — SQLiteNotifyQueue opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its `readAndConsume` is a SELECT then UPDATE inside one transaction, the same shape as delivery-ledger's atomic claim, which no Storage interface can express (same rationale as job-store/delivery-ledger/session-cards/call-log)
extensions/outbox/ — SQLiteOutboxStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; the bound approve and the delivery claim are conditional UPDATEs whose affected-row count IS the answer, which no Storage interface can express — same rationale as delivery-ledger/notify-queue
