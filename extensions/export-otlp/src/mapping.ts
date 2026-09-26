import { redactJson, redactString } from '@ethosagent/observability-sqlite';
import type { ObsEvent, Span, Trace } from '@ethosagent/types';
import { otlpSpanId, otlpTraceId, rootSpanId } from './ids';

// ---------------------------------------------------------------------------
// Ethos record -> OTLP/HTTP JSON ExportTraceServiceRequest. See MAPPING.md
// for the field-by-field table; this is the code that implements it. Plain
// objects only — no @opentelemetry/* dependency (D2 of
// plan/phases/otlp-export.md).
//
// Attributes are copied by ALLOWLIST: every exported key is named here, and
// a span attr this file does not name is never exported (§9 risk "content
// leak through attrs we did not anticipate", pinned by mapping.test.ts).
// ---------------------------------------------------------------------------

/** GenAI semconv pin (D4). Keys in this file follow this version; a bump is
 *  a reviewed diff to this constant, MAPPING.md, and the mapping.test.ts
 *  snapshot together. */
export const GENAI_SEMCONV_VERSION = '1.37.0';
export const OTLP_SCHEMA_URL = `https://opentelemetry.io/schemas/${GENAI_SEMCONV_VERSION}`;

// opentelemetry-proto enum values (trace.proto). OTLP/JSON accepts the
// integer form.
export const SPAN_KIND_INTERNAL = 1;
export const SPAN_KIND_CLIENT = 3;
export const STATUS_CODE_UNSET = 0;
export const STATUS_CODE_OK = 1;
export const STATUS_CODE_ERROR = 2;

export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpKeyValue[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events?: OtlpSpanEvent[];
  status: { code: number; message?: string };
}

export interface ExportTraceServiceRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string };
      spans: OtlpSpan[];
      schemaUrl: string;
    }>;
    schemaUrl: string;
  }>;
}

/** One claimed trace with everything the store holds for it. */
export interface TraceBundle {
  trace: Trace;
  spans: Span[];
  events: ObsEvent[];
}

/** The slice of `OtlpSettings` the mapper needs. */
export interface MappingSettings {
  resource: Record<string, string | number>;
  includeContent: boolean;
}

/** ms epoch -> OTLP nanosecond string. OTLP/JSON encodes 64-bit ints as
 *  strings, and appending six zeros is exact where `ms * 1e6` is not. */
function nanos(ms: number): string {
  return `${ms}000000`;
}

function strAttr(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): OtlpKeyValue {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function doubleAttr(key: string, value: number): OtlpKeyValue {
  return { key, value: { doubleValue: value } };
}

function numAttr(key: string, value: number): OtlpKeyValue {
  return Number.isInteger(value) ? intAttr(key, value) : doubleAttr(key, value);
}

function resourceAttributes(resource: Record<string, string | number>): OtlpKeyValue[] {
  return Object.entries(resource).map(([key, value]) =>
    typeof value === 'number' ? numAttr(key, value) : strAttr(key, value),
  );
}

/** A token bucket at zero is omitted, not written as an explicit 0 — the
 *  same rule the Langfuse mapping applies to `usageDetails`. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function spanStatus(status: Span['status']): OtlpSpan['status'] {
  if (status === 'ok') return { code: STATUS_CODE_OK };
  if (status === 'error') return { code: STATUS_CODE_ERROR };
  if (status === 'blocked') return { code: STATUS_CODE_ERROR, message: 'blocked' };
  return { code: STATUS_CODE_UNSET };
}

function traceStatus(status: Trace['status']): OtlpSpan['status'] {
  if (status === 'ok') return { code: STATUS_CODE_OK };
  if (status === 'error') return { code: STATUS_CODE_ERROR };
  if (status === 'aborted') return { code: STATUS_CODE_ERROR, message: 'aborted' };
  return { code: STATUS_CODE_UNSET };
}

/** Trace end for the synthetic root and for open spans: the trace's own
 *  `endTs`, or (an exported trace is closed, but defensively) the latest
 *  timestamp any span reached. */
function traceEndTs(trace: Trace, spans: Span[]): number {
  if (trace.endTs !== undefined) return trace.endTs;
  let end = trace.startTs;
  for (const span of spans) {
    end = Math.max(end, span.endTs ?? span.startTs);
  }
  return end;
}

function llmCallAttributes(span: Span): OtlpKeyValue[] {
  const attrs = span.attrs ?? {};
  const out: OtlpKeyValue[] = [
    strAttr('gen_ai.operation.name', 'chat'),
    strAttr('gen_ai.request.model', span.name),
  ];
  const provider = str(attrs.provider);
  if (provider !== undefined) out.push(strAttr('gen_ai.provider.name', provider));
  const inputTokens = positiveInt(attrs.inputTokens);
  if (inputTokens !== undefined) out.push(intAttr('gen_ai.usage.input_tokens', inputTokens));
  const outputTokens = positiveInt(attrs.outputTokens);
  if (outputTokens !== undefined) out.push(intAttr('gen_ai.usage.output_tokens', outputTokens));
  const cacheRead = positiveInt(attrs.cacheReadTokens);
  if (cacheRead !== undefined) out.push(intAttr('ethos.usage.cache_read_tokens', cacheRead));
  const cacheCreation = positiveInt(attrs.cacheCreationTokens);
  if (cacheCreation !== undefined) {
    out.push(intAttr('ethos.usage.cache_creation_tokens', cacheCreation));
  }
  const cost = num(attrs.estimatedCostUsd);
  if (cost !== undefined) out.push(doubleAttr('ethos.cost.usd', cost));
  const costBasis = str(attrs.costBasis);
  if (costBasis !== undefined) out.push(strAttr('ethos.cost.basis', costBasis));
  const clientRequestId = str(attrs.clientRequestId);
  if (clientRequestId !== undefined) out.push(strAttr('ethos.request.client_id', clientRequestId));
  const providerRequestId = str(attrs.providerRequestId);
  if (providerRequestId !== undefined) {
    out.push(strAttr('ethos.request.provider_id', providerRequestId));
  }
  return out;
}

function toolCallAttributes(span: Span, includeContent: boolean): OtlpKeyValue[] {
  const attrs = span.attrs ?? {};
  const out: OtlpKeyValue[] = [
    strAttr('gen_ai.operation.name', 'execute_tool'),
    strAttr('gen_ai.tool.name', span.name),
  ];
  const toolCallId = str(attrs.tool_call_id);
  if (toolCallId !== undefined) out.push(strAttr('gen_ai.tool.call.id', toolCallId));
  const durationMs = num(attrs.durationMs);
  if (durationMs !== undefined) out.push(numAttr('ethos.duration_ms', durationMs));
  const args = str(attrs.args);
  // Content is opt-in (D6), and even then the export-time redaction floor
  // applies — the writer may have stored at `storeToolArgs: full`.
  if (includeContent && args !== undefined) {
    out.push(strAttr('gen_ai.tool.call.arguments', redactString(args)));
  }
  return out;
}

function genericSpanAttributes(span: Span): OtlpKeyValue[] {
  const attrs = span.attrs ?? {};
  const out: OtlpKeyValue[] = [strAttr('ethos.span.kind', span.kind)];
  const durationMs = num(attrs.durationMs);
  if (durationMs !== undefined) out.push(numAttr('ethos.duration_ms', durationMs));
  return out;
}

function mapSpan(
  trace: Trace,
  span: Span,
  endFallbackTs: number,
  includeContent: boolean,
): OtlpSpan {
  const isLlm = span.kind === 'llm_call';
  const isTool = span.kind === 'tool_call';
  const name = isLlm ? `chat ${span.name}` : isTool ? `execute_tool ${span.name}` : span.name;
  const attributes = isLlm
    ? llmCallAttributes(span)
    : isTool
      ? toolCallAttributes(span, includeContent)
      : genericSpanAttributes(span);
  return {
    traceId: otlpTraceId(trace.traceId),
    spanId: otlpSpanId(span.spanId),
    // A parentless span is parented to the synthetic root so every trace is
    // one connected tree.
    parentSpanId:
      span.parentSpanId !== undefined ? otlpSpanId(span.parentSpanId) : rootSpanId(trace.traceId),
    name,
    kind: isLlm ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(span.startTs),
    // An open span (writer crashed mid-span) ends where the trace ends.
    endTimeUnixNano: nanos(span.endTs ?? endFallbackTs),
    attributes,
    status: spanStatus(span.status),
  };
}

function rootSpan(trace: Trace, endTs: number): OtlpSpan {
  const traceAttrs = trace.attrs ?? {};
  const attributes: OtlpKeyValue[] = [strAttr('gen_ai.operation.name', 'invoke_agent')];
  if (trace.subjectId !== undefined) {
    attributes.push(strAttr('gen_ai.agent.name', trace.subjectId));
    attributes.push(strAttr('ethos.personality.id', trace.subjectId));
  }
  if (trace.sessionId !== undefined) attributes.push(strAttr('session.id', trace.sessionId));
  const platform = str(traceAttrs.platform);
  if (platform !== undefined) attributes.push(strAttr('ethos.platform', platform));
  attributes.push(strAttr('ethos.trace.kind', trace.kind));
  return {
    traceId: otlpTraceId(trace.traceId),
    spanId: rootSpanId(trace.traceId),
    name: trace.subjectId !== undefined ? `invoke_agent ${trace.subjectId}` : 'invoke_agent',
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(trace.startTs),
    endTimeUnixNano: nanos(endTs),
    attributes,
    status: traceStatus(trace.status),
  };
}

function mapEvent(event: ObsEvent, includeContent: boolean): OtlpSpanEvent {
  const attributes: OtlpKeyValue[] = [strAttr('ethos.event.severity', event.severity)];
  if (event.code !== undefined) attributes.push(strAttr('ethos.event.code', event.code));
  if (includeContent) {
    if (event.cause !== undefined) {
      attributes.push(strAttr('ethos.event.cause', redactString(event.cause)));
    }
    if (event.details !== undefined) {
      attributes.push(strAttr('ethos.event.details', JSON.stringify(redactJson(event.details))));
    }
  }
  return { timeUnixNano: nanos(event.ts), name: event.category, attributes };
}

/**
 * Map claimed traces (with their spans and events) into one OTLP/HTTP JSON
 * `ExportTraceServiceRequest`. Each trace gets a synthetic root span
 * (`invoke_agent {subjectId}`) since Ethos has no root span record — the
 * trace row itself is the turn.
 */
export function toExportRequest(
  bundles: TraceBundle[],
  settings: MappingSettings,
): ExportTraceServiceRequest {
  const spans: OtlpSpan[] = [];
  for (const { trace, spans: traceSpans, events } of bundles) {
    const endTs = traceEndTs(trace, traceSpans);
    const root = rootSpan(trace, endTs);
    const bySpanId = new Map<string, OtlpSpan>();
    spans.push(root);
    for (const span of traceSpans) {
      const mapped = mapSpan(trace, span, endTs, settings.includeContent);
      bySpanId.set(span.spanId, mapped);
      spans.push(mapped);
    }
    for (const event of events) {
      // A span event lands on the span it belongs to; an event with no
      // (or an unknown) spanId lands on the root.
      const owner = (event.spanId !== undefined ? bySpanId.get(event.spanId) : undefined) ?? root;
      owner.events = owner.events ?? [];
      owner.events.push(mapEvent(event, settings.includeContent));
    }
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(settings.resource) },
        scopeSpans: [
          {
            scope: { name: '@ethosagent/export-otlp' },
            spans,
            schemaUrl: OTLP_SCHEMA_URL,
          },
        ],
        schemaUrl: OTLP_SCHEMA_URL,
      },
    ],
  };
}
