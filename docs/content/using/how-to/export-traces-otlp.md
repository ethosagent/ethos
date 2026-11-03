---
title: Export traces to an OpenTelemetry collector
description: Ship every Ethos turn trace to Jaeger, Tempo, Honeycomb, Langfuse or any OTLP/HTTP collector with GenAI semantic-convention attributes.
kind: how-to
audience: user
slug: export-traces-otlp
time: "10 min"
updated: 2026-11-03
---

## Task

Send each completed agent turn from Ethos to an OpenTelemetry collector as an OTLP trace, starting with a local Jaeger.

## Result

Every turn a long-running Ethos process handles shows up in Jaeger as one trace: an `invoke_agent <personality>` root with a `chat <model>` child per LLM call and an `execute_tool <tool>` child per tool call. The same config points at Tempo, Honeycomb, Grafana Cloud or Langfuse by changing the endpoint and headers.

## Prereqs

- Docker, for the Jaeger container.
- An Ethos install with a working `~/.ethos/config.yaml` (`ethos setup` done).
- A long-running host: `ethos gateway` or `ethos serve`. Only these two export. `ethos chat` and `ethos -z` write their traces to the same `observability.db`, and whichever host is running ships them.

Export is a poller over the local store, not a hook on the agent loop. The turn writes to `observability.db` as always; the poller claims closed traces, maps them, and POSTs them as OTLP/HTTP JSON (`POST <endpoint>/v1/traces`). A collector outage never slows a turn down.

## Parts

| Part | Covers |
|---|---|
| This page | Run Jaeger, turn on export, find the first trace, what a trace contains |
| <a id="keep-one-personalitys-traces-local"></a>[Backends, privacy and delivery](export-traces-otlp/backends-privacy-delivery.md) | Hosted-backend auth, Langfuse, `OTEL_*` overrides, content and per-personality opt-out, delivery semantics |

## Steps

Run steps 1 to 5 in order. Each step shows its expected output.

## 1. Run Jaeger

```bash
docker run -d --rm --name ethos-jaeger -p 4318:4318 -p 16686:16686 \
  jaegertracing/all-in-one:1.62.0
```

```
3f9c0d1e7b2a...
```

Port `4318` is OTLP/HTTP; port `16686` is the Jaeger UI and query API. The all-in-one image keeps traces in memory, so they are gone when the container stops.

## 2. Turn on export

Append these lines to `~/.ethos/config.yaml`:

```yaml
telemetry.export.otlp.enabled: true
telemetry.export.otlp.endpoint: http://localhost:4318
telemetry.export.otlp.intervalMs: 3000
```

| Key | Default | Meaning |
|---|---|---|
| `telemetry.export.otlp.enabled` | `false` | Export runs only when `true`. This is the only switch — env vars never turn it on. |
| `telemetry.export.otlp.endpoint` | — | Collector base URL. The exporter appends `/v1/traces`. |
| `telemetry.export.otlp.intervalMs` | `15000` | Poll interval in ms. `3000` makes the first trace appear sooner while you verify; drop the line afterwards. |
| `telemetry.export.otlp.headers.<Name>` | — | One request header per line. Every value is a secret — see [Authenticate to a hosted backend](export-traces-otlp/backends-privacy-delivery.md#authenticate-to-a-hosted-backend). |
| `telemetry.export.otlp.includeContent` | `false` | Also export tool arguments and event cause/details. See [Content stays local by default](export-traces-otlp/backends-privacy-delivery.md#content-stays-local-by-default). |
| `telemetry.export.otlp.backlogMaxAgeMs` | `86400000` (24h) | Unexported traces older than this are dropped, not shipped. |

The keys and their parsing live in `TelemetryOtlpExportConfig` in [packages/config/src/index.ts](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts).

## 3. Start a long-running host

```bash
ethos gateway
```

Look for this line at startup:

```
OTLP export poller running (http://localhost:4318/v1/traces)
```

If you run `ethos serve` instead, the line reads:

```
  otlp export:  enabled (http://localhost:4318/v1/traces)
```

If the line is `[otlp-export] not starting: <reason>` instead, see [Troubleshoot](#troubleshoot).

## 4. Run a turn

Send the agent a message that makes it call a tool — through a channel the gateway serves, the web UI on `ethos serve`, or `ethos chat` in another terminal. For example: "read the file README.md and tell me its first heading".

## 5. Find the trace

Open `http://localhost:16686`, pick the `ethos` service, and click **Find Traces**. Or query the API:

```bash
curl -s 'http://localhost:16686/api/traces?service=ethos&limit=5' | jq '
  .data[0].spans | map({op: .operationName,
    tags: (.tags | map({(.key): .value}) | add)})'
```

The output lists one entry per span. An excerpt:

```
[
  { "op": "invoke_agent <personality>", "tags": { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "<personality>", "session.id": "<session-id>", ... } },
  { "op": "chat <model>", "tags": { "gen_ai.operation.name": "chat", "gen_ai.request.model": "<model>", "gen_ai.usage.input_tokens": ..., "gen_ai.usage.output_tokens": ..., ... } },
  { "op": "execute_tool read_file", "tags": { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "read_file", "gen_ai.tool.call.id": "<id>", ... } }
]
```

The service name is `ethos` unless `OTEL_SERVICE_NAME` says otherwise.

## What each trace contains

| Span | Kind | Key attributes |
|---|---|---|
| `invoke_agent <personality>` — synthetic root, one per turn | internal | `gen_ai.agent.name`, `ethos.personality.id`, `session.id`, `ethos.platform` |
| `chat <model>` — one per LLM call | client | `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `ethos.cost.usd` |
| `execute_tool <tool>` — one per tool call | internal | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `ethos.duration_ms` |
| MCP calls, hooks, voice stages | internal | `ethos.span.kind`, `ethos.duration_ms` |

Attributes follow OTel GenAI semantic conventions **1.37.0**; facts with no stable GenAI key use `ethos.*` names. Attributes are exported by allowlist, so a new internal attribute never leaks out until the mapping names it. The field-by-field map — ids, statuses, span events, timestamps — is [extensions/export-otlp/MAPPING.md](https://github.com/ethosagent/ethos/blob/main/extensions/export-otlp/MAPPING.md).

## Next

To send traces to a hosted backend, hide or reveal content, or tune retries, continue with [Backends, privacy and delivery](export-traces-otlp/backends-privacy-delivery.md).

## Verify

- The startup line from [step 3](#3-start-a-long-running-host) names your collector URL.
- After one turn, Jaeger lists a trace for service `ethos` with `invoke_agent`, `chat` and `execute_tool` spans.
- With content off, no span tag carries the tool's arguments (for the example turn, no tag contains `README.md`).
- `ethos_trace_export_lag_seconds{store="otlp"}` reads `0` shortly after the turn.

## Troubleshoot

**`[otlp-export] not starting: unsupported OTEL_EXPORTER_OTLP_PROTOCOL "grpc" — only http/json is supported`.**
The environment asks for gRPC or `http/protobuf`. Unset `OTEL_EXPORTER_OTLP_PROTOCOL`, or set it to `http/json`, and restart the host.

**`[otlp-export] not starting: OTEL_SDK_DISABLED=true`.**
The environment disables OpenTelemetry. Unset `OTEL_SDK_DISABLED` and restart.

**`[otlp-export] not starting: no endpoint configured`.**
Add `telemetry.export.otlp.endpoint`, or set `OTEL_EXPORTER_OTLP_ENDPOINT`.

**No startup line at all.**
`telemetry.export.otlp.enabled` is not `true`, or you started `ethos chat` rather than a long-running host.

## Tear down

```bash
docker stop ethos-jaeger
```

```
ethos-jaeger
```

Remove the `telemetry.export.otlp.*` lines from `~/.ethos/config.yaml` and restart the host to stop exporting. Local traces in `observability.db` are untouched.

## See also

- [extensions/export-otlp/README.md](https://github.com/ethosagent/ethos/blob/main/extensions/export-otlp/README.md) — exporter configuration and env precedence at a glance.
- [Monitor Ethos with Prometheus and Grafana](monitor-with-grafana.md) — scrape the export-lag and outcome series.
- [Secrets resolver reference](../reference/secrets-resolver.md) — how `${secrets:<ref>}` values resolve.
- [Personality config reference](../reference/personality-yaml.md#safety-observability) — `safety.observability.exportTraces`.
