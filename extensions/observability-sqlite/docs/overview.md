# observability-sqlite overview

Local-first, SQLite-backed observability primitives for agent frameworks. Stores
traces, spans, events, and snapshots; enforces redaction; rolls archives;
supports timed retention; emits support bundles. Zero cloud dependency.

> **Status:** This package currently lives inside the [ethos](https://github.com/ethosagent/ethos)
> monorepo as `@ethosagent/observability-sqlite`. The API is designed to be
> extractable to a standalone npm package once external demand justifies
> committing to a stable surface — see [Extraction status](design.md#extraction-status).

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

