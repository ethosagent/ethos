# observability-sqlite API and schema

## API reference (high-level)

| Interface              | Defined in                                  | Purpose |
|------------------------|---------------------------------------------|---------|
| `ObservabilityStore`   | `@ethosagent/types` (`observability.ts`)    | Pure CRUD contract over the four tables. |
| `ObservabilityWriter`  | `@ethosagent/types` (`observability.ts`)    | Write-side facade — what callers actually use to record telemetry. |
| `RedactionPolicy`      | `@ethosagent/types` (`observability.ts`)    | Generic shape (`level: 'none' \| 'redacted' \| 'full'`, plus `extraPatterns`). |
| `Trace` / `Span` / `ObsEvent` / `Snapshot` | `@ethosagent/types`         | OpenTelemetry-shaped record types. |
| `pruneObservability`   | `extensions/observability-sqlite/retention.ts` | TTL-based row pruning, with optional per-subject overrides. |
| `archiveMonth` / `restoreArchive` | `extensions/observability-sqlite/archive.ts` | Move a month's traces into a gzipped tarball; reload on demand. |
| `BlobStore`            | `extensions/observability-sqlite/blob-store.ts` | sha256-keyed content store. |
| `createTarGz` / `readTarGz` | `extensions/observability-sqlite/tar-bundle.ts` | Support-bundle tarball builder. |

`ObservabilityService` is the concrete implementation of `ObservabilityWriter`:
it owns the store, generates IDs and timestamps, and applies redaction policies.

## The schema

Four STRICT SQLite tables (WAL mode enabled at open):

### `traces`
| column         | type    | notes |
|----------------|---------|-------|
| trace_id       | TEXT PK | UUID |
| session_id     | TEXT    | optional grouping |
| kind           | TEXT    | opaque, `<domain>.<verb>` convention |
| start_ts       | INTEGER | epoch ms |
| end_ts         | INTEGER | nullable until `closeTrace` |
| status         | TEXT    | `ok` \| `error` \| `aborted` |
| subject_id     | TEXT    | what this trace is about — opaque to the library |
| snapshot_id    | TEXT    | optional; references `snapshots.snapshot_id` |
| attrs          | TEXT    | JSON blob, redacted on insert |

Indexes on `(session_id, start_ts)` and `(kind, start_ts)`.

### `spans`
| column         | type    | notes |
|----------------|---------|-------|
| span_id        | TEXT PK | UUID |
| trace_id       | TEXT    | parent trace |
| parent_span_id | TEXT    | nullable |
| kind           | TEXT    | `tool_call` \| `llm_call` \| `hook` \| `mcp_call` |
| name           | TEXT    | tool name, model name, hook name |
| start_ts/end_ts/status/attrs | — | as above |

### `events`
| column     | type    | notes |
|------------|---------|-------|
| event_id   | TEXT PK | UUID |
| trace_id   | TEXT    | optional link |
| span_id    | TEXT    | optional link |
| ts         | INTEGER | epoch ms |
| category   | TEXT    | opaque, `<domain>.<verb>` convention |
| severity   | TEXT    | `info` \| `warn` \| `error` \| `critical` |
| code/cause/details | — | optional |

Indexes on `(trace_id, ts)`, `(category, ts)`, `(severity, ts)`.

### `snapshots`
| column      | type    | notes |
|-------------|---------|-------|
| snapshot_id | TEXT PK | sha256 of body (assigned by `BlobStore`) |
| taken_at    | INTEGER | epoch ms |
| subject_id  | TEXT    | what the snapshot describes (opaque) |
| body        | TEXT    | the snapshotted content |

A `personality_id → subject_id` migration runs idempotently at store open so
databases created before the rename keep working without manual ALTER.

