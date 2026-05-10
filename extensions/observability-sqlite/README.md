# observability-sqlite

Local-first, SQLite-backed observability primitives for agent frameworks. Stores
traces, spans, events, and snapshots; enforces redaction; rolls archives;
supports timed retention; emits support bundles. Zero cloud dependency.

> **Status:** This package currently lives inside the [ethos](https://github.com/ethosagent/ethos)
> monorepo as `@ethosagent/observability-sqlite`. The API is designed to be
> extractable to a standalone npm package once external demand justifies
> committing to a stable surface — see [Extraction status](#extraction-status).

## What this is

A storage-and-redaction layer for the kinds of structured data an agent system
emits at runtime:

- **Traces** — a top-level unit of work (a chat turn, a cron tick, a channel
  inbound message). OpenTelemetry-shaped.
- **Spans** — a sub-unit of a trace (one LLM call, one tool call, one hook
  pipeline run).
- **Events** — point-in-time records (errors, audit decisions, lifecycle
  notifications). Tagged with a category and severity; carry arbitrary details.
- **Snapshots** — content-addressed blobs (e.g. a serialized configuration at
  the moment a trace ran), keyed by sha256. Stored in a separate blob store.

It writes to a single SQLite database (WAL + STRICT tables), with a separate
content-addressed blob store on disk and a monthly gzipped tarball archive
tier.

## Who it's for

- Agent-framework authors who want OpenTelemetry-shaped primitives without the
  full OTel SDK / collector setup.
- CLI tool authors who want structured event logs locally — `select * from
  events where category = 'X' and ts > Y` is a useful query when triaging.
- Anyone running an agentic system on a single machine who wants post-hoc
  analysis without sending data to a third party.

## Quick start

```typescript
import {
  BlobStore,
  ObservabilityService,
  SQLiteObservabilityStore,
} from '@ethosagent/observability-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';

const store = new SQLiteObservabilityStore('/tmp/observability.db');
const blobStore = new BlobStore('/tmp/blobs', new FsStorage());
const obs = new ObservabilityService(store, blobStore);

const traceId = obs.startTrace({
  kind: 'turn',
  subjectId: 'user-42',
  redaction: { level: 'redacted' },
});
const spanId = obs.startSpan({
  traceId,
  kind: 'tool_call',
  name: 'read_file',
  attrs: { args: 'AKIAIOSFODNN7EXAMPLE' }, // floor patterns redact AWS keys
});
obs.endSpan(spanId, 'ok');
obs.recordEvent({ category: 'install.event', severity: 'info', code: 'startup' });
obs.endTrace(traceId, 'ok');

const events = store.getEvents({ category: 'install.event', limit: 10 });
console.log(events);
store.close();
```

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

## Vocabulary contract

`EventCategory` and `TraceKind` are typed as `string` in `@ethosagent/types` —
the library does not enforce specific values. Convention: `<domain>.<verb>`
(`audit.transition`, `app.login`, `cron.tick`, …). Each consumer defines its
own vocabulary in an adapter layer.

The library does the storage and redaction; the adapter owns the names.

**Reference adapter:** ethos's own `EthosObservability` wrapper at
[`packages/core/src/observability/ethos-observability.ts`](../../packages/core/src/observability/ethos-observability.ts)
is a worked example. It owns ethos's category and trace-kind constants, exposes
typed domain helpers (`recordSafetyTransition`, `recordWatcherDecision`, …), and
translates `personalityId` → `subjectId` at the boundary so consumer code keeps
its own domain language.

## Why local-first vs. OpenTelemetry SDK

This package is intentionally smaller than OTel:

- ~2 KB cold-start overhead (one SQLite handle, no batch processor, no
  collector). OTel pulls in span exporters, batch processors, propagators.
- Single-machine, single-DB. No collector, no cloud account, no network egress.
- Queries are SQL: `select * from events where category like 'audit.%' and
  ts > ?`. No JSON-over-HTTP indirection.
- Built-in redaction with a pattern-floor that always applies (AWS keys, JWTs,
  email addresses, etc.). OTel leaves redaction to the application.

It's _not_ a replacement when you need:

- Multi-machine distributed tracing (OTel's W3C trace context propagation)
- Vendor-managed dashboards (Datadog, Honeycomb, Grafana Cloud)
- Production-grade sampling and tail-based decisions

A future plugin layer can adapt this primitive to OTLP if the use-case
emerges; until then, this is purposefully local.

## Extraction status

This library is general-purpose and lives inside the ethos monorepo because
ethos is its only public consumer today. Internally it's already decoupled —
zero ethos vocabulary in source, only `@ethosagent/types` as a workspace
dependency, mechanical CI gates that keep it that way.

If you want to use it from outside ethos, **file an issue at
https://github.com/ethosagent/ethos/issues** describing your use case.
Concrete external interest is the trigger for publishing this as a standalone
npm package; until then we don't want to commit to API stability we'd have to
honor for one consumer.

The corresponding plan is at
[plan/phases/observability_extractability.md](../../plan/phases/observability_extractability.md).
