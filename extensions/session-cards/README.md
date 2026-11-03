# @ethosagent/session-cards

## Purpose

Durable store for typed UI cards. A card envelope arrives in the browser as `tool_end.structured.card` and nothing else keeps it, so this package persists each one in its own SQLite file, separate from the sessions database. Envelopes are re-validated on read and a row that no longer parses is skipped, so a card-shape change degrades one card rather than a session load.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteCardStore` | class | `CardStore` over `@ethosagent/sqlite`; synchronous API. |
| `CardStore` | type | Contract web-api codes against: `append`, `list`, `listForToolCalls`, `copySession`, `deleteSession`, `close`. |
| `CardStoreOptions` | type | Optional `logger` for invalid-on-read rows. |

`append` is idempotent on `(sessionId, toolCallId)` and returns the per-session `seq`.

## Seam

Layer `extensions`. Consumes `CardEnvelope` and `SessionCard` from `@ethosagent/web-contracts` and `Logger` from `@ethosagent/types`. It takes the raw-path SQLite carve-out (it creates the database parent directory), listed in `apps/ethos/src/__tests__/no-raw-fs.test.ts`. Durability posture is `synchronous = NORMAL`, chosen in `.claude/rules/sqlite-durability.md` and pinned by the `durability posture` block in `src/__tests__/session-cards.test.ts`.

## Testing

```
pnpm vitest run extensions/session-cards
```

`src/__tests__/session-cards.test.ts` holds: monotonic seq per session from 0, idempotent append, list in seq order, round trip of every card kind, rows that fail validation are skipped, `deleteSession` and `copySession`, `listForToolCalls` filtering, and the posture checks (`synchronous = NORMAL`, WAL, STRICT tables).
