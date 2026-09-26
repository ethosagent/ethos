---
title: Export traces to an OpenTelemetry collector
description: Ship every Ethos turn trace to Jaeger, Tempo, Honeycomb, Langfuse or any OTLP/HTTP collector with GenAI semantic-convention attributes.
kind: how-to
audience: user
slug: export-traces-otlp
time: "10 min"
updated: 2026-09-26
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
| `telemetry.export.otlp.headers.<Name>` | — | One request header per line. Every value is a secret — see [Authenticate to a hosted backend](#authenticate-to-a-hosted-backend). |
| `telemetry.export.otlp.includeContent` | `false` | Also export tool arguments and event cause/details. See [Content stays local by default](#content-stays-local-by-default). |
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

## Authenticate to a hosted backend

Every `telemetry.export.otlp.headers.<Name>` value is treated as a credential, whatever the header name. It must be a `${secrets:telemetry/export/otlp/headers/<Name>}` [secret ref](../../getting-started/glossary.md#secret-ref) (a pointer into the secrets vault, resolved at startup). A plaintext value fails the config load (`validateNoPlaintextSecrets` in [packages/config/src/index.ts](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts)). A config saved by Ethos itself vaults the value for you.

Store the value in the vault, then reference it. For a Honeycomb-style header:

```bash
ethos secrets set telemetry/export/otlp/headers/x-honeycomb-team <your-api-key>
```

```
✓ Secret set  telemetry/export/otlp/headers/x-honeycomb-team  <masked-value>
```

```yaml
telemetry.export.otlp.headers.x-honeycomb-team: ${secrets:telemetry/export/otlp/headers/x-honeycomb-team}
```

### Langfuse Cloud

Langfuse accepts OTLP at `/api/public/otel` with Basic auth built from your project keys. Build the header value:

```bash
printf '%s' '<public-key>:<secret-key>' | base64
```

```
<base64-credentials>
```

Vault it and point the exporter at Langfuse:

```bash
ethos secrets set telemetry/export/otlp/headers/Authorization "Basic <base64-credentials>"
```

```
✓ Secret set  telemetry/export/otlp/headers/Authorization  <masked-value>
```

```yaml
telemetry.export.otlp.enabled: true
telemetry.export.otlp.endpoint: https://cloud.langfuse.com/api/public/otel
telemetry.export.otlp.headers.Authorization: ${secrets:telemetry/export/otlp/headers/Authorization}
```

`telemetry.export.langfuse.*` (the older Langfuse-specific exporter) is deprecated in favour of this recipe. A config that still sets it prints `telemetry.export.langfuse is deprecated; see extensions/export-otlp/README.md` at startup.

## Override with OTEL_* env vars

The standard OTel exporter variables override config values, but they never turn export on. `telemetry.export.otlp.enabled: true` is the only switch, so an `OTEL_*` variable inherited from a container base image cannot start sending agent telemetry off the machine.

| Env var | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full traces URL, used verbatim. Beats everything. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; `/v1/traces` is appended. Beats the config `endpoint`. |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Comma-separated `key=value` pairs, percent-decoded (write a space as `%20`). Merged over config headers; the traces-specific variable wins. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Request timeout in ms. Default `10000`. |
| `OTEL_SERVICE_NAME` | Resource `service.name`. Default `ethos`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes as `key=value` pairs. |
| `OTEL_SDK_DISABLED=true` | Disables export. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Any value other than `http/json` disables export — this exporter speaks neither gRPC nor protobuf. |

The precedence is `resolveOtlpSettings` in [extensions/export-otlp/src/settings.ts](https://github.com/ethosagent/ethos/blob/main/extensions/export-otlp/src/settings.ts).

## Content stays local by default

With `includeContent` unset, tool arguments and event cause/details are dropped from the export entirely — spans carry names, timings, token counts and cost, not what the agent read or wrote. Set `telemetry.export.otlp.includeContent: true` to export them; each value passes through the redaction floor again at export time. LLM prompts and completions are never exported at any setting — `observability.db` does not hold them.

## Keep one personality's traces local

Set `exportTraces: false` in a [personality's](../../getting-started/glossary.md#personality) (the directory of files that decides an agent's tools, memory, and model) `config.yaml`:

```yaml
safety:
  observability:
    exportTraces: false
```

Its traces are still recorded in `observability.db`; the poller marks them `opted_out` and never sends them. The flag can only restrict egress. `ethos personality show <id>` prints `export: off` for such a personality. See [`safety.observability.*`](../reference/personality-yaml.md#safety-observability).

## Delivery semantics

| Behaviour | Detail |
|---|---|
| At-least-once | A trace can be re-sent after a crash or a power cut. It keeps the same derived ids, so Tempo and Langfuse collapse the duplicate; Jaeger shows a duplicate span. |
| Backoff on outage | A network error or HTTP 408/429/502/503/504 releases the batch and backs off: 1s, doubling, capped at 5 min, with jitter. `Retry-After` is honoured when larger. The first success resets it. |
| Rejection is final | Any other non-2xx response marks the batch `rejected`; it is never retried. |
| Bounded backlog | Unexported traces older than `backlogMaxAgeMs` (default 24h) are dropped and counted, so a long outage ships the last day, not all of history. |
| Retention wins | Pruning `observability.db` never waits for export. |
| Two hosts, one store | `ethos gateway` and `ethos serve` on the same state directory both run the poller; claims keep their batches disjoint. |

Two series on `/metrics` track it (see [Monitor Ethos with Prometheus and Grafana](monitor-with-grafana.md)):

- `ethos_trace_export_lag_seconds{store="otlp"}` — age of the oldest unexported trace; `0` when caught up. Rendered only by a process running the exporter.
- `ethos_otlp_export_traces_total{outcome="..."}` — counts `rejected` traces, `dropped_backlog` traces, and `partial` (spans a collector refused inside an accepted request).

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

**`[otlp-export] tick error: OTLP export rejected (HTTP 401)` (or another status).**
The collector refused the request as non-retryable — usually a wrong or missing auth header, or the wrong endpoint path. Those traces are marked `rejected` and not retried. Fix the header or endpoint and restart; new traces export normally.

**`[otlp-export] tick error: OTLP collector unavailable (HTTP 503)` (or `network error`), and `ethos_trace_export_lag_seconds{store="otlp"}` keeps rising.**
The collector is unreachable or returning retryable statuses, and the poller is backing off. It prints one warning per backoff step, naming the retry delay, not one per tick. The delay starts at 1s and doubles to a 5-minute cap, so the warnings get sparser as the outage goes on. Check that the collector is up and reachable from the host (`curl -s -o /dev/null -w '%{http_code}\n' -X POST <endpoint>/v1/traces`). Once it recovers, the backlog drains within the 5-minute backoff cap. Traces older than `backlogMaxAgeMs` are dropped instead.

**Config load fails naming `telemetry.export.otlp.headers.<Name>`.**
The header value is plaintext. Move it into the vault as in [Authenticate to a hosted backend](#authenticate-to-a-hosted-backend).

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
