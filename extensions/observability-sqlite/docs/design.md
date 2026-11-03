# observability-sqlite design notes

## Vocabulary contract

`EventCategory` and `TraceKind` are typed as `string` in `@ethosagent/types` —
the library does not enforce specific values. Convention: `<domain>.<verb>`
(`audit.transition`, `app.login`, `cron.tick`, …). Each consumer defines its
own vocabulary in an adapter layer.

The library does the storage and redaction; the adapter owns the names.

**Reference adapter:** ethos's own `EthosObservability` wrapper at
[`packages/wiring/src/observability/ethos-observability.ts`](../../../packages/wiring/src/observability/ethos-observability.ts)
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
`plan/phases/observability_extractability.md` (local working notes, not in the repo).

