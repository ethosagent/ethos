# @ethosagent/world-sqlite

## Purpose

SQLite backend for the world graph contract (`WorldGraphProvider` in `packages/types/src/world-graph.ts`). Facts live in `<dataDir>/worlds/graph.db`: entities, attributes and edges on two clocks (world time `valid_from`/`valid_to`, Ethos time `recorded_at`/`retired_at`). Facts are closed or retired, never deleted; only a purge, in one transaction with a token, removes rows. The proposal, access, authority and conflict rules are not here: they live in `WorldService` and `WorldSchemaService`, which are the only callers of a provider.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteWorldGraphProvider` | class | The full 13-method `WorldGraphProvider`, opened on a database path. `dispose()` releases the handle; `close(...)` is the contract's fact-closing method. |
| `worldGraphDbPath` | function | `<dataDir>/worlds/graph.db`. |
| `WorldGraphStoreOptions` | interface | Optional clock and `onError` sink. |

## Seam

Archcheck layer: `extensions`. Nothing outside `packages/wiring` imports this package; `world-service` and `tools-world` depend on the contract only. The only raw `node:fs` use is `mkdirSync` of the database's parent directory (`.claude/rules/fs-carveouts-sqlite.md`).

Guarantees and what pins them, all in `src/__tests__/graph-store.test.ts`:

- Every table is STRICT: `tables are STRICT`.
- `synchronous = FULL`, because nothing rebuilds the file: `durability posture is FULL`.
- Facts are never deleted or rewritten: `R3 facts are closed, never deleted`.
- A purge needs a token and is one transaction: `purge removes rows only with a token, in one transaction`.
- Ordered reads tie-break on `rowid`: `ordered reads tie-break on rowid`.
- Every read applies the two-clock time slice; closing refuses a fact already closed: `src/__tests__/facts.test.ts` (`handover…`, `knownAt…`, `retire hides…`).
- `assert` refuses what the stored schema does not allow and closes nothing itself: `assert refuses an edge between types the schema does not allow`, `attribute change closes nothing by itself`.
- Hops are depth-capped at 3 and cycles end: `src/__tests__/hops.test.ts` (`2 hops from Payments…`, `cycle reports_to A→B→A ends`).
- User text cannot inject FTS5 syntax: `src/__tests__/search.test.ts` (`FTS operators in text are inert`).

## Gotchas

- `rowid` is not in `SELECT *`; every ordered read selects it by name.
- The recursive hop query uses `CROSS JOIN … INDEXED BY` on purpose; without it the planner rescans the walk per edge (seconds on 20k edges). See `src/hops.ts`.
- `close` and `retire` take `sourceRef` and `author`, but graph.db has no column for the closer, so `changes` reports the fact's own provenance.
- The FTS5 index is keyed by `entities.rowid`; never VACUUM `graph.db` (same caveat as `messages_fts` in session-sqlite).
- `graph.db` is in the backup `state` scope (`packages/wiring/src/backup/scopes.ts`, `WAL_STORES`).
