# @ethosagent/inbound-dedup

## Purpose

Durable backstop for the gateway's in-memory set of recently seen inbound messages, so a platform retry that lands on a freshly started process is not processed (and billed) twice. It records sightings keyed by platform, bot, chat and message id; the gateway keeps its in-memory set as the fast path.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteInboundDedupStore` | class | SQLite implementation; synchronous `seen()` records a key and reports whether it was already inside the TTL. |
| `InboundDedupStore` | interface | The store contract the gateway depends on. |
| `InboundDedupOptions` | interface | Constructor options (database path, TTL, clock). |

## Seam

Gateway inbound dedup per `.claude/rules/gateway-dedup.md` and `.claude/rules/gateway-inbound-spool.md`; the gateway, not this package, owns when it is consulted. Implements its own `InboundDedupStore` (`implements InboundDedupStore` in `src/index.ts`), not an `@ethosagent/types` interface. Archcheck layer: `extensions`. Listed in `.claude/rules/sqlite-durability.md`.

Pinned by `src/__tests__/inbound-dedup.test.ts`: the four key segments are distinct, expired rows are pruned, a key survives close and reopen, and the file stays at `synchronous = FULL`.

## Testing

```
pnpm vitest run extensions/inbound-dedup
```

Pinning test: `src/__tests__/inbound-dedup.test.ts` holds first-sighting versus duplicate, the TTL boundary, persistence across reopen, and the durability posture.
