# OTLP export mapping

`extensions/export-otlp` ships every completed turn trace in
`observability.db` to any OTLP/HTTP collector as JSON
(`POST <endpoint>/v1/traces`, an `ExportTraceServiceRequest` of plain
objects). This document is the field-by-field map from Ethos's internal
record to the OTLP span it lands on, using OTel GenAI semantic-convention
names where a stable one exists and `ethos.*` names where none does.

## Semantic-convention pin

GenAI conventions are "Development" status and have renamed keys between
releases (`gen_ai.system` → `gen_ai.provider.name`). This exporter pins
**semconv 1.37.0**: `GENAI_SEMCONV_VERSION` in
[src/mapping.ts](./src/mapping.ts), emitted as
`schemaUrl: https://opentelemetry.io/schemas/1.37.0` on both the resource
and the scope. A version bump is one reviewed diff to `mapping.ts`, this
file, and the `mapping.test.ts` snapshot — never silent drift. Names with no
stable GenAI key (cache tokens, cost, request ids) go under `ethos.*`;
invented `gen_ai.*` keys are banned.

## Id derivation

OTLP ids are fixed-width binary (16-byte trace id, 8-byte span id); Ethos
ids are free-form strings (UUIDs in practice). Derivation is deterministic
([src/ids.ts](./src/ids.ts)), so a re-export after a lost stamp is a
same-id resend — backends that dedupe by id (Tempo, Langfuse) collapse it;
Jaeger shows a duplicate span, the accepted at-least-once cost.

| Ethos id | OTLP id |
|---|---|
| UUID `traceId` | 32 hex chars: the UUID minus dashes, lowercased |
| non-UUID `traceId` | first 32 hex chars of `sha256(traceId)` |
| `spanId` | first 16 hex chars of `sha256(spanId)` |
| synthetic root span | first 16 hex chars of `sha256('root:' + traceId)` |

## Resource vs span attributes

The resource is per process, constant across every exported trace:
`service.name` (`OTEL_SERVICE_NAME`, default `ethos`), `service.version`
(the CLI package version, when the caller passes one),
`service.instance.id` (random UUID per exporter start), `host.name`,
`process.pid`, plus `OTEL_RESOURCE_ATTRIBUTES` pairs. Per-trace facts
(`ethos.personality.id`, `session.id`, `ethos.platform`) live on the root
span — one process exports traces written by other processes, so nothing
per-writer may live on the resource. `ethos.bot_key` is not exported in v1:
no trace carries a bot key today.

## Field mapping

### Turn trace → synthetic root span

Ethos has no root span record — the trace row itself is the turn — so the
exporter synthesizes one. Every span with no `parentSpanId` is parented to
it, keeping each trace a single connected tree.

| Ethos (`Trace`) | OTLP root span |
|---|---|
| `traceId` | `traceId` (derived, above) |
| — | `spanId` = `rootSpanId(traceId)` |
| `subjectId` (the personality id) | `name` = `invoke_agent {subjectId}`; `gen_ai.agent.name`; `ethos.personality.id` |
| — | `kind` = `SPAN_KIND_INTERNAL` (1) |
| — | `gen_ai.operation.name` = `invoke_agent` |
| `sessionId` | `session.id` |
| `attrs.platform` | `ethos.platform` |
| `kind` (always `turn` for an exported trace) | `ethos.trace.kind` |
| `startTs` / `endTs` | `startTimeUnixNano` / `endTimeUnixNano` |
| `status` | `ok` → `STATUS_CODE_OK`; `error` → `STATUS_CODE_ERROR`; `aborted` → `STATUS_CODE_ERROR` + `status.message: "aborted"` |

### `llm_call` span → `chat {model}` (SPAN_KIND_CLIENT)

| Ethos (`Span`, kind `llm_call`) | OTLP attribute |
|---|---|
| `name` (the model name) | `name` = `chat {name}`; `gen_ai.request.model` |
| — | `gen_ai.operation.name` = `chat` |
| `attrs.provider` | `gen_ai.provider.name` |
| `attrs.inputTokens` | `gen_ai.usage.input_tokens` |
| `attrs.outputTokens` | `gen_ai.usage.output_tokens` |
| `attrs.cacheReadTokens` | `ethos.usage.cache_read_tokens` (no stable semconv name) |
| `attrs.cacheCreationTokens` | `ethos.usage.cache_creation_tokens` |
| `attrs.estimatedCostUsd` | `ethos.cost.usd` |
| `attrs.costBasis` | `ethos.cost.basis` |
| `attrs.clientRequestId` | `ethos.request.client_id` |
| `attrs.providerRequestId` | `ethos.request.provider_id` |

A zero-valued token bucket (e.g. `cacheCreationTokens: 0`, the common case
for non-Anthropic providers or a cache-miss call) is **omitted** rather
than written as an explicit `0` — the same rule the Langfuse mapping
applies to `usageDetails`.

### `tool_call` span → `execute_tool {name}` (SPAN_KIND_INTERNAL)

| Ethos (`Span`, kind `tool_call`) | OTLP attribute |
|---|---|
| `name` (the tool name) | `name` = `execute_tool {name}`; `gen_ai.tool.name` |
| — | `gen_ai.operation.name` = `execute_tool` |
| `attrs.tool_call_id` | `gen_ai.tool.call.id` |
| `attrs.durationMs` | `ethos.duration_ms` |
| `attrs.args` | `gen_ai.tool.call.arguments` — **only when `includeContent` is on**, and passed through `redactString` at export time (see "Content policy") |

### `mcp_call`, `hook`, `voice_stage` spans → generic internal spans

| Ethos (`Span`) | OTLP attribute |
|---|---|
| `name` | `name` (verbatim) |
| `kind` | `ethos.span.kind` |
| `attrs.durationMs` | `ethos.duration_ms` |

### Span status (all kinds)

| Ethos `status` | OTLP `status` |
|---|---|
| `ok` | `STATUS_CODE_OK` (1) |
| `error` | `STATUS_CODE_ERROR` (2) |
| `blocked` | `STATUS_CODE_ERROR` (2) + `status.message: "blocked"` |
| absent (open span — the writer crashed mid-span) | `STATUS_CODE_UNSET` (0); `endTimeUnixNano` = trace end |

### `ObsEvent` → span event

OTLP's traces signal has no free-standing event; an `ObsEvent` rides as a
span event on the span whose id matches its `spanId`, or on the synthetic
root when it names none (or an unknown one). Events without a `traceId`
are not exported in v1.

| Ethos (`ObsEvent`) | OTLP span event |
|---|---|
| `category` | `name` |
| `ts` | `timeUnixNano` |
| `severity` | `ethos.event.severity` |
| `code` | `ethos.event.code` |
| `cause` | `ethos.event.cause` — content-on only, through `redactString` |
| `details` | `ethos.event.details` (JSON string) — content-on only, through `redactJson` |

### Timestamps

Every `startTs`/`endTs`/`ts` is a millisecond epoch; OTLP wants nanoseconds
as a **string** (OTLP/JSON encodes 64-bit ints as strings). The conversion
is `"{ms}000000"` — exact, where `ms * 1e6` in a double is not.

## Attribute allowlist

Attributes are copied by **allowlist**, not denylist: only the keys named
in the tables above are exported. A span attr written later by any part of
the framework is NOT exported until `mapping.ts` names it — pinned by the
`mapping.test.ts` case that injects an unknown attr and asserts it is
absent. (`result_size_bytes` on tool spans is an example of a stored attr
deliberately not exported.)

## Content policy

`includeContent` defaults **off**: tool `args`, event `cause`, and event
`details` are dropped entirely. When on, each passes through
`redactString`/`redactJson` (re-exported by
`@ethosagent/observability-sqlite` from `@ethosagent/safety-redact`) at
export time — even though the writer already redacted per policy, because a
personality at `storeToolArgs: full` skipped its `extraPatterns`, and data
leaving the machine gets the floor again. LLM prompts and completions are
never exported: the store does not hold them.
