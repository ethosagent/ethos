import type { ObsEvent, Span, Trace } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { otlpSpanId, otlpTraceId, rootSpanId } from '../ids';
import type { ExportTraceServiceRequest, OtlpSpan, TraceBundle } from '../mapping';
import { toExportRequest } from '../mapping';

const TRACE_ID = '11111111-2222-3333-4444-555555555555';
// A real AKIA-shaped key so the redaction floor's aws-key pattern fires.
const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';

const trace: Trace = {
  traceId: TRACE_ID,
  sessionId: 'sess-1',
  kind: 'turn',
  startTs: 1_000,
  endTs: 9_000,
  status: 'ok',
  subjectId: 'assistant',
  attrs: { platform: 'telegram' },
};

const llmSpan: Span = {
  spanId: 'span-llm',
  traceId: TRACE_ID,
  kind: 'llm_call',
  name: 'claude-sonnet-5',
  startTs: 1_100,
  endTs: 2_000,
  status: 'ok',
  attrs: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0.0042,
    clientRequestId: 'client-req-1',
    providerRequestId: 'provider-req-1',
    provider: 'anthropic',
    costBasis: 'priced',
    secretThing: 'attr-not-on-the-allowlist',
  },
};

const toolSpan: Span = {
  spanId: 'span-tool',
  traceId: TRACE_ID,
  kind: 'tool_call',
  name: 'read_file',
  startTs: 2_100,
  endTs: 2_300,
  status: 'ok',
  attrs: {
    args: `{"path":"args-path-sentinel","token":"${AWS_KEY}"}`,
    tool_call_id: 'call-1',
    durationMs: 180,
  },
};

// Open span (no endTs, no status): ends where the trace ends.
const voiceSpan: Span = {
  spanId: 'span-voice',
  traceId: TRACE_ID,
  kind: 'voice_stage',
  name: 'stt',
  startTs: 2_400,
  attrs: { durationMs: 90 },
};

const toolEvent: ObsEvent = {
  eventId: 'evt-1',
  traceId: TRACE_ID,
  spanId: 'span-tool',
  ts: 2_350,
  category: 'audit.decision',
  severity: 'warn',
  code: 'tool.flagged',
  cause: `cause-sentinel ${AWS_KEY}`,
  details: { reason: 'details-sentinel' },
};

const rootEvent: ObsEvent = {
  eventId: 'evt-2',
  traceId: TRACE_ID,
  ts: 2_500,
  category: 'skill.invoked',
  severity: 'info',
};

const bundle: TraceBundle = {
  trace,
  spans: [llmSpan, toolSpan, voiceSpan],
  events: [toolEvent, rootEvent],
};

const RESOURCE = { 'service.name': 'ethos', 'process.pid': 42 };
const SCHEMA_URL = 'https://opentelemetry.io/schemas/1.37.0';

function spansOf(request: ExportTraceServiceRequest): OtlpSpan[] {
  return request.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
}

function findSpan(request: ExportTraceServiceRequest, name: string): OtlpSpan {
  const span = spansOf(request).find((s) => s.name === name);
  if (!span) throw new Error(`no span named ${name}`);
  return span;
}

function attrKeys(span: OtlpSpan): string[] {
  return span.attributes.map((a) => a.key);
}

describe('toExportRequest', () => {
  it('maps a fixture turn to the exact expected OTLP request (content off)', () => {
    const request = toExportRequest([bundle], { resource: RESOURCE, includeContent: false });
    const hexTraceId = otlpTraceId(TRACE_ID);
    const root = rootSpanId(TRACE_ID);

    expect(request).toEqual({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'ethos' } },
              { key: 'process.pid', value: { intValue: '42' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: '@ethosagent/export-otlp' },
              spans: [
                {
                  traceId: hexTraceId,
                  spanId: root,
                  name: 'invoke_agent assistant',
                  kind: 1,
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '9000000000',
                  attributes: [
                    { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
                    { key: 'gen_ai.agent.name', value: { stringValue: 'assistant' } },
                    { key: 'ethos.personality.id', value: { stringValue: 'assistant' } },
                    { key: 'session.id', value: { stringValue: 'sess-1' } },
                    { key: 'ethos.platform', value: { stringValue: 'telegram' } },
                    { key: 'ethos.trace.kind', value: { stringValue: 'turn' } },
                  ],
                  status: { code: 1 },
                  events: [
                    {
                      timeUnixNano: '2500000000',
                      name: 'skill.invoked',
                      attributes: [{ key: 'ethos.event.severity', value: { stringValue: 'info' } }],
                    },
                  ],
                },
                {
                  traceId: hexTraceId,
                  spanId: otlpSpanId('span-llm'),
                  parentSpanId: root,
                  name: 'chat claude-sonnet-5',
                  kind: 3,
                  startTimeUnixNano: '1100000000',
                  endTimeUnixNano: '2000000000',
                  attributes: [
                    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                    { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-5' } },
                    { key: 'gen_ai.provider.name', value: { stringValue: 'anthropic' } },
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
                    { key: 'gen_ai.usage.output_tokens', value: { intValue: '50' } },
                    { key: 'ethos.usage.cache_read_tokens', value: { intValue: '20' } },
                    { key: 'ethos.cost.usd', value: { doubleValue: 0.0042 } },
                    { key: 'ethos.cost.basis', value: { stringValue: 'priced' } },
                    { key: 'ethos.request.client_id', value: { stringValue: 'client-req-1' } },
                    {
                      key: 'ethos.request.provider_id',
                      value: { stringValue: 'provider-req-1' },
                    },
                  ],
                  status: { code: 1 },
                },
                {
                  traceId: hexTraceId,
                  spanId: otlpSpanId('span-tool'),
                  parentSpanId: root,
                  name: 'execute_tool read_file',
                  kind: 1,
                  startTimeUnixNano: '2100000000',
                  endTimeUnixNano: '2300000000',
                  attributes: [
                    { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
                    { key: 'gen_ai.tool.name', value: { stringValue: 'read_file' } },
                    { key: 'gen_ai.tool.call.id', value: { stringValue: 'call-1' } },
                    { key: 'ethos.duration_ms', value: { intValue: '180' } },
                  ],
                  status: { code: 1 },
                  events: [
                    {
                      timeUnixNano: '2350000000',
                      name: 'audit.decision',
                      attributes: [
                        { key: 'ethos.event.severity', value: { stringValue: 'warn' } },
                        { key: 'ethos.event.code', value: { stringValue: 'tool.flagged' } },
                      ],
                    },
                  ],
                },
                {
                  traceId: hexTraceId,
                  spanId: otlpSpanId('span-voice'),
                  parentSpanId: root,
                  name: 'stt',
                  kind: 1,
                  startTimeUnixNano: '2400000000',
                  // Open span: end = trace end.
                  endTimeUnixNano: '9000000000',
                  attributes: [
                    { key: 'ethos.span.kind', value: { stringValue: 'voice_stage' } },
                    { key: 'ethos.duration_ms', value: { intValue: '90' } },
                  ],
                  status: { code: 0 },
                },
              ],
              schemaUrl: SCHEMA_URL,
            },
          ],
          schemaUrl: SCHEMA_URL,
        },
      ],
    });
  });

  it('with content off, exports no tool args, event cause, or event details', () => {
    const request = toExportRequest([bundle], { resource: RESOURCE, includeContent: false });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('args-path-sentinel');
    expect(serialized).not.toContain(AWS_KEY);
    expect(serialized).not.toContain('cause-sentinel');
    expect(serialized).not.toContain('details-sentinel');
  });

  it('with content on, exports tool args and event content through the redaction floor', () => {
    const request = toExportRequest([bundle], { resource: RESOURCE, includeContent: true });
    const serialized = JSON.stringify(request);
    // The AWS key never leaves, content on or off.
    expect(serialized).not.toContain(AWS_KEY);
    expect(serialized).toContain('[REDACTED:aws-key]');

    const tool = findSpan(request, 'execute_tool read_file');
    const argsAttr = tool.attributes.find((a) => a.key === 'gen_ai.tool.call.arguments');
    expect(argsAttr).toEqual({
      key: 'gen_ai.tool.call.arguments',
      value: { stringValue: '{"path":"args-path-sentinel","token":"[REDACTED:aws-key]"}' },
    });

    const toolEvents = tool.events ?? [];
    expect(toolEvents).toHaveLength(1);
    const eventAttrs = toolEvents.flatMap((e) => e.attributes);
    expect(eventAttrs).toContainEqual({
      key: 'ethos.event.cause',
      value: { stringValue: 'cause-sentinel [REDACTED:aws-key]' },
    });
    expect(eventAttrs).toContainEqual({
      key: 'ethos.event.details',
      value: { stringValue: '{"reason":"details-sentinel"}' },
    });
  });

  it('maps a blocked span to STATUS_CODE_ERROR with a message', () => {
    const blocked: Span = { ...toolSpan, status: 'blocked' };
    const request = toExportRequest([{ trace, spans: [blocked], events: [] }], {
      resource: RESOURCE,
      includeContent: false,
    });
    expect(findSpan(request, 'execute_tool read_file').status).toEqual({
      code: 2,
      message: 'blocked',
    });
  });

  it('omits zero token buckets (the Langfuse rule)', () => {
    const request = toExportRequest([bundle], { resource: RESOURCE, includeContent: false });
    const llm = findSpan(request, 'chat claude-sonnet-5');
    expect(attrKeys(llm)).not.toContain('ethos.usage.cache_creation_tokens');
    expect(attrKeys(llm)).toContain('ethos.usage.cache_read_tokens');
  });

  it('never exports a span attr outside the allowlist', () => {
    const request = toExportRequest([bundle], { resource: RESOURCE, includeContent: true });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('secretThing');
    expect(serialized).not.toContain('attr-not-on-the-allowlist');
    // result_size_bytes is stored on tool spans but is not on the allowlist.
    expect(serialized).not.toContain('result_size_bytes');
  });

  it('parents a spanful hierarchy correctly: explicit parents kept, orphans to the root', () => {
    const child: Span = { ...voiceSpan, spanId: 'span-child', parentSpanId: 'span-llm' };
    const request = toExportRequest([{ trace, spans: [llmSpan, child], events: [] }], {
      resource: RESOURCE,
      includeContent: false,
    });
    expect(findSpan(request, 'stt').parentSpanId).toBe(otlpSpanId('span-llm'));
    expect(findSpan(request, 'chat claude-sonnet-5').parentSpanId).toBe(rootSpanId(TRACE_ID));
  });
});
