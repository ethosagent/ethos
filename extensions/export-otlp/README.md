# export-otlp

Ships every completed turn trace in `observability.db` to any OpenTelemetry
collector or OTLP-speaking backend — Jaeger, Tempo, Honeycomb, Grafana
Cloud, Langfuse, Phoenix — as OTLP/HTTP JSON with OTel GenAI
semantic-convention attributes. No `@opentelemetry/*` SDK, no protobuf, no
runtime dependency outside `@ethosagent/*`: the request is plain objects and
`fetch`.

Export is a poller over the local store, never a tee on the agent loop's hot
path: the turn writes to SQLite synchronously as always, and the poller
claims closed traces, maps them, and POSTs them in batches. The backlog IS
the database, so a collector outage loses nothing until retention prunes it.

## Configuration

All keys live under `telemetry.export.otlp.*` in `~/.ethos/config.yaml`:

```yaml
telemetry.export.otlp.enabled: true
telemetry.export.otlp.endpoint: http://localhost:4318
telemetry.export.otlp.headers.Authorization: ${secrets:telemetry/export/otlp/headers/Authorization}
telemetry.export.otlp.includeContent: false
telemetry.export.otlp.intervalMs: 15000
telemetry.export.otlp.backlogMaxAgeMs: 86400000
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Export runs only when `true`. Env vars never enable export (see below). |
| `endpoint` | — | Collector base URL; `/v1/traces` is appended. |
| `headers.<Name>` | — | Request headers, one per name. Every header VALUE is a secret and is vaulted on write. |
| `includeContent` | `false` | When `true`, exports tool args and event cause/details — through the redaction floor. Prompts/completions are never exported. |
| `intervalMs` | `15000` | Poll interval. |
| `backlogMaxAgeMs` | `86400000` (24h) | Unexported traces older than this are stamped `dropped_backlog`, so a week-long outage ships the last day, not a thundering herd. |

## Env var precedence

The standard OTel exporter env vars OVERRIDE config values, but they never
ENABLE export — `telemetry.export.otlp.enabled: true` is the only switch. An
`OTEL_*` variable inherited from a container base image must not start
sending agent telemetry off-box.

| Env var | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Used verbatim as the full traces URL. Beats everything. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL + `/v1/traces`. Beats the config `endpoint`. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` pairs, percent-decoded. Merged over config headers; the traces-specific var wins. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Request timeout in ms. Default `10000`. |
| `OTEL_SERVICE_NAME` | Resource `service.name`. Default `ethos`. Wins over `OTEL_RESOURCE_ATTRIBUTES`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes (`key=value` pairs); win over the built-in defaults except `service.name`. |
| `OTEL_SDK_DISABLED=true` | Disables export. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Anything other than `http/json` disables export with a stated reason — this exporter does not speak gRPC or protobuf. |

## Langfuse recipe

Langfuse Cloud removes its legacy ingestion API on **2026-11-16**; its
replacement is OTLP. Point this exporter at Langfuse's OTLP endpoint with
Basic auth built from your project keys:

```yaml
telemetry.export.otlp.enabled: true
telemetry.export.otlp.endpoint: https://cloud.langfuse.com/api/public/otel
telemetry.export.otlp.headers.Authorization: Basic <base64(publicKey:secretKey)>
```

The header value is externalized to the secrets vault on the first config
write. `telemetry.export.langfuse.*` (the `@ethosagent/export-langfuse`
package) is deprecated in favor of this recipe and is removed one release
after this package ships.

## Semantic conventions

Span attributes follow OTel GenAI semconv **1.37.0**, pinned as
`GENAI_SEMCONV_VERSION` and emitted as the `schemaUrl`. The full
field-by-field map — the synthetic `invoke_agent` root span, `chat {model}`
and `execute_tool {tool}` children, `ethos.*` names for facts with no stable
GenAI key, and the attribute allowlist — is in [MAPPING.md](./MAPPING.md).

## Delivery semantics

At-least-once. `observability.db` runs `synchronous = NORMAL`, so a power
cut can roll back an export stamp after the POST succeeded; a stale claim
can be re-claimed mid-POST by a peer process. Either way the trace is
re-sent with the SAME derived ids, so id-deduping backends (Tempo, Langfuse)
collapse the duplicate — Jaeger shows a duplicate span. Non-retryable
responses (4xx other than 408/429) are terminal: the trace is stamped
`rejected` and never retried, because a mapping or auth bug does not fix
itself. Retention never waits for export — a dead collector must not grow
the local database without bound.
