import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Span, Trace } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeContextAnatomy } from '../context-anatomy';
import { SQLiteObservabilityStore } from '../store';

function tmpDb(): string {
  return join(tmpdir(), `obs-anatomy-${randomUUID()}.db`);
}

function llmSpan(attrs: Record<string, unknown>, startTs: number): Span {
  return {
    spanId: randomUUID(),
    traceId: randomUUID(),
    kind: 'llm_call',
    name: 'model',
    startTs,
    attrs,
  };
}

describe('computeContextAnatomy', () => {
  it('returns null when there are no llm_call spans', () => {
    expect(computeContextAnatomy([])).toBeNull();
    const toolSpan: Span = {
      spanId: randomUUID(),
      traceId: randomUUID(),
      kind: 'tool_call',
      name: 'read_file',
      startTs: 1,
      attrs: { inputTokens: 999 },
    };
    expect(computeContextAnatomy([toolSpan])).toBeNull();
  });

  it('takes the section breakdown from the MOST RECENT llm_call', () => {
    const spans = [
      llmSpan({ inputTokens: 10, requestTokens: { system: 1, tools: 2, messages: 3 } }, 100),
      llmSpan({ inputTokens: 20, requestTokens: { system: 5, tools: 6, messages: 7 } }, 200),
    ];
    const a = computeContextAnatomy(spans);
    expect(a).not.toBeNull();
    expect(a?.system).toBe(5);
    expect(a?.tools).toBe(6);
    expect(a?.messages).toBe(7);
    expect(a?.total).toBe(18);
    expect(a?.llmCallCount).toBe(2);
  });

  it('aggregates the cache-hit rate as cache reads / all input tokens', () => {
    const spans = [
      llmSpan(
        {
          inputTokens: 100,
          cacheReadTokens: 300,
          cacheCreationTokens: 0,
          requestTokens: { system: 1, tools: 1, messages: 1 },
        },
        100,
      ),
      llmSpan(
        {
          inputTokens: 100,
          cacheReadTokens: 100,
          cacheCreationTokens: 0,
          requestTokens: { system: 1, tools: 1, messages: 1 },
        },
        200,
      ),
    ];
    const a = computeContextAnatomy(spans);
    // cacheRead 400 / total input (200 + 400 + 0) = 0.6666…
    expect(a?.cacheHitRate).toBeCloseTo(400 / 600, 6);
  });

  it('aggregates ONLY llm_call spans (no double-count from other kinds)', () => {
    const spans: Span[] = [
      llmSpan({ inputTokens: 100, requestTokens: { system: 2, tools: 2, messages: 2 } }, 100),
      {
        spanId: randomUUID(),
        traceId: randomUUID(),
        kind: 'tool_call',
        name: 'x',
        startTs: 150,
        attrs: { inputTokens: 9999, cacheReadTokens: 9999 },
      },
    ];
    const a = computeContextAnatomy(spans);
    expect(a?.llmCallCount).toBe(1);
    expect(a?.inputTokens).toBe(100);
    // The tool_call span's inflated tokens must not leak into the rate.
    expect(a?.cacheHitRate).toBe(0);
  });
});

describe('SQLiteObservabilityStore — Phase 0 span attrs + per-session query', () => {
  let store: SQLiteObservabilityStore;

  beforeEach(() => {
    store = new SQLiteObservabilityStore(tmpDb());
  });
  afterEach(() => store.close());

  function insertLlmSpan(traceId: string, kind: Span['kind'] = 'llm_call'): string {
    const spanId = randomUUID();
    store.insertSpan({ spanId, traceId, kind, name: 'model', startTs: Date.now() });
    return spanId;
  }

  it('merges close-time attrs onto an llm_call span', () => {
    const traceId = randomUUID();
    const trace: Trace = { traceId, sessionId: 'sess-A', kind: 'turn', startTs: Date.now() };
    store.insertTrace(trace);
    const spanId = insertLlmSpan(traceId);
    store.closeSpan(spanId, 'ok', {
      inputTokens: 42,
      cacheReadTokens: 7,
      requestTokens: { system: 10, tools: 20, messages: 12 },
    });
    const spans = store.getSpans(traceId);
    const attrs = spans[0]?.attrs as Record<string, unknown>;
    expect(attrs.inputTokens).toBe(42);
    expect(attrs.cacheReadTokens).toBe(7);
    expect(attrs.requestTokens).toEqual({ system: 10, tools: 20, messages: 12 });
    expect(spans[0]?.status).toBe('ok');
  });

  it('getLlmCallSpansForSession returns only llm_call spans for the session', () => {
    const traceId = randomUUID();
    store.insertTrace({ traceId, sessionId: 'sess-B', kind: 'turn', startTs: Date.now() });
    const other = randomUUID();
    store.insertTrace({ traceId: other, sessionId: 'sess-C', kind: 'turn', startTs: Date.now() });

    const llmId = insertLlmSpan(traceId);
    store.closeSpan(llmId, 'ok', {
      inputTokens: 5,
      requestTokens: { system: 1, tools: 1, messages: 1 },
    });
    insertLlmSpan(traceId, 'tool_call');
    insertLlmSpan(other, 'llm_call');

    const spans = store.getLlmCallSpansForSession('sess-B');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe('llm_call');
    const anatomy = computeContextAnatomy(spans);
    expect(anatomy?.total).toBe(3);
  });
});
