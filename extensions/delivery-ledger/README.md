# @ethosagent/delivery-ledger

## Purpose

Durable ledger of reply obligations for the gateway. The gateway writes a `pending` row before each covered platform send and marks it `delivered` only when the adapter confirms, so a crash between generating a reply and delivering it costs a redelivery, not the reply. Delivery is at-least-once. Dedup (preventing double sends) is a separate concern and stays in `extensions/gateway`.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteDeliveryLedger` | class | The shipped `DeliveryLedger`, opened on a database path; `close()` releases it. |
| `DeliveryLedger` | interface | Contract the gateway codes against: `record`, `listPending`, `claim`, `markDelivered`, `release`, `abandon`, `deferRetry` and more. |
| `DeliveryObligation` | interface | One owed reply: bot, platform, chat, thread, content, kind and status. |
| `RecordDeliveryInput` | interface | Input to `record`. |
| `DeliveryStatus` | type | `pending`, `redelivering`, `delivered` or `abandoned`. |
| `DeliveryKind` | type | `text` or `voice`. |
| `DeliveryStats` | interface | Per-status counts plus voice counts, from `stats()`. |
| `DeliveryStatusCounts` | interface | Count per `DeliveryStatus`. |
| `readDeliveryStats` | function | Reads `DeliveryStats` from an open database handle. |

## Seam

Owns the `DeliveryLedger` interface itself and `SQLiteDeliveryLedger` is its only shipped implementation (comment above the interface in `src/index.ts`). The gateway side, including the sweep, backoff and abandon policy, is described in `.claude/rules/gateway-delivery-ledger.md`. Archcheck layer: `extensions`. Raw `node:fs` use is the mkdir of the database parent directory, one of the SQLite carve-outs in `.claude/rules/fs-carveouts-sqlite.md`. This store runs at `synchronous = FULL` (`.claude/rules/sqlite-durability.md`).

Pinned in `src/__tests__/delivery-ledger.test.ts`: `markDelivered` removes a row from the pending pool, only one of two claims on the same row wins (including across two handles on one file), `release` never resurrects a delivered row, `listPending` only returns caller-owned bot keys, the table is STRICT, and the `durability posture` block asserts `synchronous = FULL`.

## Testing

```
pnpm vitest run extensions/delivery-ledger
```

Pinning tests: `src/__tests__/delivery-ledger.test.ts` holds record and confirm, bot ownership, atomic claim, retention, schema migrations v1 to v6, thread and voice round trips, `abandonStale`, operator reads (`stats`, `listRecent`), `findBySession`, `hasObligationFor` and `reclaimStaleClaims`.
