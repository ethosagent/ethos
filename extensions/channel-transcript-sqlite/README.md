# @ethosagent/channel-transcript-sqlite

## Purpose

SQLite store for observe mode. The gateway records every message it watched in a room but did not answer, and the nightly digest reads them back by lane and by an ingestion cursor. It owns the table, the retention prune and secret redaction on the way in; deciding what to observe and what to do with the transcript stays with the gateway and `extensions/digest`.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteChannelTranscriptStore` | class | `ChannelTranscriptStore` over a database path: `record`, `readSince`, `listLanes`, `close`. |
| `transcriptLaneKey` | function | Lane key for one watched room, built with `buildLaneKey` so it matches the gateway's conversation lane. |
| `transcriptLanePrefix` | function | `laneKeyPrefix` selecting every room one bot watches, URL-encoding aware. |
| `DEFAULT_READ_LIMIT` | const | 500, the page cap for one `readSince`. |
| `pruneChannelTranscript` | function | Deletes rows past a retention window; a no-op if the database file does not exist. |

## Seam

Implements `ChannelTranscriptStore` from `@ethosagent/types` (`packages/types/src/channel-transcript.ts`). Archcheck layer: `extensions`. It is one of the SQLite stores with a raw-path carve-out for `node:fs` (`.claude/rules/fs-carveouts-sqlite.md`) and an observational durability posture (`.claude/rules/sqlite-durability.md`).

Pinned in `src/__tests__/channel-transcript.test.ts`: text is redacted on insert (`redacts secrets in the text on the way in`), the store opens at `synchronous = NORMAL`, WAL and STRICT tables (`durability posture` block), `readSince` follows ingestion order and not sent order, and `pruneChannelTranscript` does not create a missing database.

## Testing

```
pnpm vitest run extensions/channel-transcript-sqlite
```

Pinning tests: `src/__tests__/channel-transcript.test.ts` holds upsert on `(laneKey, messageId)`, thread-as-lane, cursor paging with backlog counts, `listLanes` ordering and prefix matching, retention by `recorded_at`, schema migration from v1, and id non-reuse after the table empties.
