# @ethosagent/observability-sqlite

## Purpose

Local-first, SQLite-backed observability primitives for agent frameworks. It stores traces, spans, events and snapshots (WAL, STRICT tables), enforces redaction, rolls monthly archives, applies timed retention and emits support bundles, with no cloud dependency. It owns storage and redaction; the consumer's adapter owns the event vocabulary.

## Public surface

From `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `ObservabilityService` | class | Concrete `ObservabilityWriter`: owns the store, generates IDs and timestamps, applies redaction. |
| `SQLiteObservabilityStore` | class | `ObservabilityStore` over one SQLite database. |
| `BlobStore` | class | sha256-keyed content store for snapshots. |
| `OBSERVABILITY_KILL_SWITCH_FILE` | const | Name of the kill-switch file (`.observability.disabled`) defined in `src/service.ts`. |
| `redactString` | function | Redacts a string against the always-on pattern floor. |
| `redactJson` | function | Redacts a JSON value. |
| `pruneObservability` | function | TTL-based row pruning with optional per-subject overrides. |
| `archiveMonth` | function | Moves a month's traces into a gzipped tarball. |
| `restoreArchive` | function | Reloads an archived month. |
| `createTarGz` | function | Support-bundle tarball builder. |
| `startPruneCron` | function | Starts the scheduled retention prune (default `0 3 * * *`). |
| `createMetricsTextProvider` | function | OpenMetrics text provider over `metric_counters` rows. |
| `computeContextAnatomy` | function | Per-session context breakdown aggregated from `llm_call` spans. |

More exports (`listArchives`, `pruneArchives`, `parseDuration`, `incrementCounter`, ...) are in `src/index.ts`.

## Seam

Implements `ObservabilityStore` and `ObservabilityWriter` from `@ethosagent/types` (`observability.ts`); archcheck layer `observability-sqlite`, a stricter slice of `extensions`.

- It imports only contracts, the sqlite shim and the security kernel, so it stays extractable. Enforced by archcheck rule `observability-sqlite-stays-extractable` in `architecture.config.ts`; `src/__tests__/import-graph.test.ts` pins the import graph.
- The quick-start example runs against the public API. Pinned by `src/__tests__/readme-example.test.ts`.

## More

- [docs/overview.md](./docs/overview.md) -- what it is, who it is for, status.
- [docs/quick-start.md](./docs/quick-start.md) -- end-to-end example.
- [docs/api-and-schema.md](./docs/api-and-schema.md) -- interface table and the four SQLite tables.
- [docs/design.md](./docs/design.md) -- vocabulary contract, local-first versus OpenTelemetry, extraction status.

## Testing

```
pnpm vitest run extensions/observability-sqlite
```

Pinning tests: `src/__tests__/import-graph.test.ts`, `src/__tests__/readme-example.test.ts`, `src/__tests__/redact.test.ts`, `src/__tests__/retention.test.ts`, `src/__tests__/store.test.ts`.
