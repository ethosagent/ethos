# @ethosagent/initiative-store

## Purpose

SQLite ledger for the initiative engine: initiatives, ideas, explorations, windows (the spend rows), findings, briefs, pending initiative drafts, owner decisions and run questions. It persists and arbitrates ledger rows; running explorations is the runner's job and writing config is `InitiativeConfigService`'s.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `SQLiteInitiativeStore` | class | The ledger over a STRICT SQLite file: ideas, `propose`, findings, briefs, drafts, questions, windows and `budget`. |
| `SQLiteInitiativeStoreOptions` | interface | `now` (clock, epoch ms) and `capFor` (the clamped daily cap per initiative; wiring binds it, defaults to 0). |
| `initiativesDbPath` | function | `<dataDir>/initiatives.db`. |

## Seam

Implements the ports declared in `packages/types/src/initiative.ts`. Archcheck layer: `extensions`. Raw `node:fs` is only the mkdir of the database parent directory (`.claude/rules/fs-carveouts-sqlite.md`). Runs at `synchronous = FULL` (`.claude/rules/sqlite-durability.md`).

## Ids

Readable and per-database monotonic: explorations `EXP-0007`, findings `F-31`, ideas `I-4`, briefs `B-2`, windows `W-9`, drafts `D-1`, questions `Q-3`. A new id is `max(numeric suffix) + 1`, computed in a `BEGIN IMMEDIATE` transaction so two connections never mint the same one. Rows are never deleted, so an id is never reused. Initiative ids come from the caller (the config service).

## Budget

`budget(initiativeId, day)`: `spentUsd` sums `windows.spent_usd` for windows that started on the UTC day `day` (`YYYY-MM-DD`); `explorationsOpen` counts explorations in `proposed`, `exploring` or `stalled`; `capUsd` comes from the `capFor` option. `closeWindow` adds the window's spend to its exploration in the same transaction, and closing a window twice throws so spend is never counted twice.

## Testing

```
pnpm vitest run extensions/initiative-store
```

Pinning test: `src/__tests__/store.test.ts` holds `schema is STRICT`, `durability posture is FULL`, the ideas ordering tie-break, id monotonicity across two handles on one file, and per-exploration and per-day spend.
