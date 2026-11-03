---
title: "Export traces to an OpenTelemetry collector: backends, privacy and delivery"
description: "Authenticate to hosted OTLP backends, override with OTEL_* env vars, control exported content, and understand delivery."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Point the OTLP trace export at a hosted backend, control what leaves the machine, and know how failed deliveries behave.

## Result

Traces reach Honeycomb, Langfuse or another OTLP/HTTP collector with vaulted credentials, tool arguments stay local unless you opt in, and you know when a batch is retried, rejected or dropped.

## Prereqs

- Complete [Export traces to an OpenTelemetry collector](../export-traces-otlp.md) so export works against local Jaeger.
- An account on the hosted backend, with its OTLP endpoint and API key.

## Steps

Apply the sections you need, in any order. Each ends with the config lines to set.

## Authenticate to a hosted backend

Every `telemetry.export.otlp.headers.<Name>` value is treated as a credential, whatever the header name. It must be a `${secrets:telemetry/export/otlp/headers/<Name>}` [secret ref](../../../getting-started/glossary.md#secret-ref) (a pointer into the secrets vault, resolved at startup). A plaintext value fails the config load (`validateNoPlaintextSecrets` in [packages/config/src/index.ts](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts)). A config saved by Ethos itself vaults the value for you.

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

Set `exportTraces: false` in a [personality's](../../../getting-started/glossary.md#personality) (the directory of files that decides an agent's tools, memory, and model) `config.yaml`:

```yaml
safety:
  observability:
    exportTraces: false
```

Its traces are still recorded in `observability.db`; the poller marks them `opted_out` and never sends them. The flag can only restrict egress. `ethos personality show <id>` prints `export: off` for such a personality. See [`safety.observability.*`](../../reference/personality-yaml.md#safety-observability).

## Delivery semantics

| Behaviour | Detail |
|---|---|
| At-least-once | A trace can be re-sent after a crash or a power cut. It keeps the same derived ids, so Tempo and Langfuse collapse the duplicate; Jaeger shows a duplicate span. |
| Backoff on outage | A network error or HTTP 408/429/502/503/504 releases the batch and backs off: 1s, doubling, capped at 5 min, with jitter. `Retry-After` is honoured when larger. The first success resets it. |
| Rejection is final | Any other non-2xx response marks the batch `rejected`; it is never retried. |
| Bounded backlog | Unexported traces older than `backlogMaxAgeMs` (default 24h) are dropped and counted, so a long outage ships the last day, not all of history. |
| Retention wins | Pruning `observability.db` never waits for export. |
| Two hosts, one store | `ethos gateway` and `ethos serve` on the same state directory both run the poller; claims keep their batches disjoint. |

Two series on `/metrics` track it (see [Monitor Ethos with Prometheus and Grafana](../monitor-with-grafana.md)):

- `ethos_trace_export_lag_seconds{store="otlp"}` — age of the oldest unexported trace; `0` when caught up. Rendered only by a process running the exporter.
- `ethos_otlp_export_traces_total{outcome="..."}` — counts `rejected` traces, `dropped_backlog` traces, and `partial` (spans a collector refused inside an accepted request).

## Verify

- `ethos secrets set telemetry/export/otlp/headers/<Name> <value>` prints `✓ Secret set  telemetry/export/otlp/headers/<Name>  <masked-value>`.
- After one turn, the hosted backend lists a trace for service `ethos`.
- `ethos_trace_export_lag_seconds{store="otlp"}` reads `0` shortly after the turn.

## Troubleshoot

**`[otlp-export] tick error: OTLP export rejected (HTTP 401)` (or another status).**
The collector refused the request as non-retryable — usually a wrong or missing auth header, or the wrong endpoint path. Those traces are marked `rejected` and not retried. Fix the header or endpoint and restart; new traces export normally.

**`[otlp-export] tick error: OTLP collector unavailable (HTTP 503)` (or `network error`), and `ethos_trace_export_lag_seconds{store="otlp"}` keeps rising.**
The collector is unreachable or returning retryable statuses, and the poller is backing off. It prints one warning per backoff step, naming the retry delay, not one per tick. The delay starts at 1s and doubles to a 5-minute cap, so the warnings get sparser as the outage goes on. Check that the collector is up and reachable from the host (`curl -s -o /dev/null -w '%{http_code}\n' -X POST <endpoint>/v1/traces`). Once it recovers, the backlog drains within the 5-minute backoff cap. Traces older than `backlogMaxAgeMs` are dropped instead.

**Config load fails naming `telemetry.export.otlp.headers.<Name>`.**
The header value is plaintext. Move it into the vault as in [Authenticate to a hosted backend](#authenticate-to-a-hosted-backend).
