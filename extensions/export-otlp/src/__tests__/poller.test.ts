// §4.2/§5 of plan/phases/otlp-export.md — the poll tick: claim → map → POST
// → stamp-or-release, with bounded backlog (D11), per-exporter backoff (D11),
// the per-personality opt-out (D12), and the header-secrecy rule (D7). Real
// SQLiteObservabilityStore on a temp file, injected fetch — no network.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import Database from '@ethosagent/sqlite';
import type { Span, Trace } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OtlpPollLoop } from '../poller';
import type { OtlpSettings } from '../settings';

let tmp: string;
let dbPath: string;
let store: SQLiteObservabilityStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'otlp-poller-'));
  dbPath = join(tmp, 'observability.db');
  store = new SQLiteObservabilityStore(dbPath);
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function insertClosedTrace(overrides: Partial<Trace> = {}): Trace {
  const trace: Trace = {
    traceId: randomUUID(),
    sessionId: 'sess-1',
    kind: 'turn',
    startTs: Date.now() - 1000,
    endTs: Date.now(),
    status: 'ok',
    subjectId: 'assistant',
    attrs: { platform: 'telegram' },
    ...overrides,
  };
  store.insertTrace(trace);
  return trace;
}

function insertSpanFor(trace: Trace, overrides: Partial<Span> = {}): Span {
  const span: Span = {
    spanId: randomUUID(),
    traceId: trace.traceId,
    kind: 'llm_call',
    name: 'claude-sonnet-4-6',
    startTs: trace.startTs,
    endTs: trace.endTs,
    status: 'ok',
    attrs: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  };
  store.insertSpan(span);
  return span;
}

function makeSettings(overrides: Partial<OtlpSettings> = {}): OtlpSettings {
  return {
    tracesUrl: 'http://collector.test/v1/traces',
    headers: {},
    includeContent: false,
    intervalMs: 15_000,
    backlogMaxAgeMs: 86_400_000,
    timeoutMs: 10_000,
    resource: { 'service.name': 'ethos' },
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** An injected fetch that records every call and replays queued outcomes;
 *  the last outcome repeats once the queue is drained. */
function makeFetch(outcomes: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: RecordedCall[] = [];
  const queue = [...outcomes];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string };
    calls.push({ url: String(url), headers: request.headers, body: request.body });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error('no outcome queued');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    // A Response body is one-shot: clone so a repeated outcome stays readable.
    return next.clone();
  }) as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

function exportRow(traceId: string): {
  claimed_at: number | null;
  exported_at: number | null;
  outcome: string | null;
} | null {
  const verify = new Database(dbPath);
  try {
    const row = verify
      .prepare(
        `SELECT claimed_at, exported_at, outcome FROM trace_exports
          WHERE sink = 'otlp' AND trace_id = ?`,
      )
      .get(traceId) as
      | { claimed_at: number | null; exported_at: number | null; outcome: string | null }
      | undefined;
    return row ?? null;
  } finally {
    verify.close();
  }
}

function counterValue(outcome: string): number | undefined {
  return store
    .getMetricCounters()
    .find((r) => r.metric === 'ethos_otlp_export_traces_total' && r.labels.outcome === outcome)
    ?.value;
}

describe('OtlpPollLoop.tick', () => {
  it('stamps every trace exported on a 2xx, in one request', async () => {
    const a = insertClosedTrace();
    insertSpanFor(a);
    const b = insertClosedTrace();
    insertSpanFor(b, { kind: 'tool_call', name: 'read_file', attrs: { tool_call_id: 'tc1' } });
    const { calls, fetchImpl } = makeFetch([new Response('{}', { status: 200 })]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => true,
      fetchImpl,
    });

    const result = await loop.tick();

    expect(result.exported).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://collector.test/v1/traces');
    for (const trace of [a, b]) {
      const row = exportRow(trace.traceId);
      expect(row?.outcome).toBe('exported');
      expect(row?.exported_at).not.toBeNull();
      expect(row?.claimed_at).toBeNull();
    }
    // A clean export bumps no outcome counter — only the plan-named outcomes
    // (dropped_backlog, partial, rejected, pruned-by-retention) are counted.
    expect(counterValue('exported')).toBeUndefined();
  });

  it('releases all claims on a 503 and honors Retry-After across ticks', async () => {
    const a = insertClosedTrace();
    insertSpanFor(a);
    const b = insertClosedTrace();
    insertSpanFor(b);
    let clock = 1_000_000_000_000;
    const { calls, fetchImpl } = makeFetch([
      new Response('busy', { status: 503, headers: { 'Retry-After': '7' } }),
    ]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => true,
      fetchImpl,
      rng: () => 0.5,
      now: () => clock,
    });

    const first = await loop.tick();
    expect(first.released).toBe(2);
    for (const trace of [a, b]) {
      const row = exportRow(trace.traceId);
      expect(row?.exported_at).toBeNull();
      expect(row?.claimed_at).toBeNull();
    }

    // Retry-After 7s > the jittered delay (0.5 * 1s), so the window is 7s:
    // a tick 1ms before it does not POST (or even claim).
    clock += 6_999;
    const second = await loop.tick();
    expect(second.inBackoff).toBe(true);
    expect(calls).toHaveLength(1);

    clock += 1;
    await loop.tick();
    expect(calls).toHaveLength(2);
  });

  it('warns once per backoff step, never from a tick inside the window', async () => {
    const trace = insertClosedTrace();
    insertSpanFor(trace);
    let clock = 1_000_000_000_000;
    const errors: Error[] = [];
    const { calls, fetchImpl } = makeFetch([new Response('busy', { status: 503 })]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => true,
      onError: (err) => errors.push(err),
      fetchImpl,
      rng: () => 0.5, // delays 500ms, then 1s
      now: () => clock,
    });

    await loop.tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(
      'OTLP collector unavailable (HTTP 503): busy; released 1 trace(s), retrying in 0.5s (attempt 1)',
    );

    // Ticks inside the window are silent.
    clock += 250;
    expect((await loop.tick()).inBackoff).toBe(true);
    clock += 249;
    expect((await loop.tick()).inBackoff).toBe(true);
    expect(errors).toHaveLength(1);
    expect(calls).toHaveLength(1);

    // The next failure after the window is the next step: one more warning.
    clock += 1;
    await loop.tick();
    expect(calls).toHaveLength(2);
    expect(errors).toHaveLength(2);
    expect(errors[1]?.message).toContain('retrying in 1.0s (attempt 2)');
  });

  it('backs off exponentially on network errors, doubling to the 300s cap', async () => {
    const trace = insertClosedTrace();
    insertSpanFor(trace);
    let clock = 1_000_000_000_000;
    const { calls, fetchImpl } = makeFetch([new Error('ECONNREFUSED')]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => true,
      fetchImpl,
      // Seeded jitter: nextDelay is uniform over [0, min(300s, 1s·2^n)), so a
      // constant 0.5 makes the observed delays exactly half each ceiling —
      // 500ms, 1s, 2s, 4s, … capped at 150s (half the 300s ceiling).
      rng: () => 0.5,
      now: () => clock,
    });

    const first = await loop.tick();
    expect(first.released).toBe(1);
    expect(exportRow(trace.traceId)?.claimed_at).toBeNull();

    const expectedDelays = [500, 1000, 2000, 4000, 8000];
    for (const delay of expectedDelays) {
      clock += delay - 1;
      const held = await loop.tick();
      expect(held.inBackoff).toBe(true);
      const before = calls.length;
      clock += 1;
      await loop.tick(); // POSTs again, fails again, arms the next window
      expect(calls.length).toBe(before + 1);
    }

    // Walk the remaining doublings to the cap: 16s … 256s ceilings, then the
    // ceiling pins at 300s and the observed delay at 150s, tick after tick.
    for (let i = 0; i < 10; i++) {
      clock += 300_000;
      await loop.tick();
    }
    const before = calls.length;
    clock += 150_000 - 1;
    expect((await loop.tick()).inBackoff).toBe(true);
    clock += 1;
    await loop.tick();
    expect(calls.length).toBe(before + 1);
  });

  it('stamps rejected on a 400 with one onError (status + snippet) and no backoff', async () => {
    const trace = insertClosedTrace();
    insertSpanFor(trace);
    const errors: Error[] = [];
    const { calls, fetchImpl } = makeFetch([
      new Response('invalid span payload', { status: 400 }),
      new Response('{}', { status: 200 }),
    ]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => true,
      onError: (err) => errors.push(err),
      fetchImpl,
    });

    const result = await loop.tick();

    expect(result.rejected).toBe(1);
    expect(exportRow(trace.traceId)?.outcome).toBe('rejected');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('400');
    expect(errors[0]?.message).toContain('invalid span payload');
    expect(counterValue('rejected')).toBe(1);

    // No backoff (D13): the very next tick claims and POSTs a fresh trace.
    const next = insertClosedTrace();
    insertSpanFor(next);
    const second = await loop.tick();
    expect(second.inBackoff).toBe(false);
    expect(second.exported).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('counts partialSuccess.rejectedSpans as exported plus a partial counter', async () => {
    const trace = insertClosedTrace();
    insertSpanFor(trace);
    const { fetchImpl } = makeFetch([
      new Response(JSON.stringify({ partialSuccess: { rejectedSpans: '2' } }), { status: 200 }),
    ]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => true,
      fetchImpl,
    });

    const result = await loop.tick();

    expect(result.exported).toBe(1);
    expect(exportRow(trace.traceId)?.outcome).toBe('exported');
    expect(counterValue('partial')).toBe(2);
  });

  it('stamps opted_out and pruned without POSTing them', async () => {
    const optedOut = insertClosedTrace({ subjectId: 'private-agent' });
    insertSpanFor(optedOut);
    const noSpans = insertClosedTrace();
    const allowed = insertClosedTrace();
    insertSpanFor(allowed);
    const { calls, fetchImpl } = makeFetch([new Response('{}', { status: 200 })]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: (subjectId) => subjectId !== 'private-agent',
      fetchImpl,
    });

    const result = await loop.tick();

    expect(result).toMatchObject({ exported: 1, optedOut: 1, pruned: 1 });
    expect(exportRow(optedOut.traceId)?.outcome).toBe('opted_out');
    expect(exportRow(noSpans.traceId)?.outcome).toBe('pruned');
    expect(exportRow(allowed.traceId)?.outcome).toBe('exported');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain(allowed.traceId.replaceAll('-', ''));
    expect(calls[0]?.body).not.toContain(optedOut.traceId.replaceAll('-', ''));
    expect(calls[0]?.body).not.toContain(noSpans.traceId.replaceAll('-', ''));
  });

  it('stamps dropped_backlog for traces older than backlogMaxAgeMs and counts them', async () => {
    const stale = insertClosedTrace({ startTs: Date.now() - 90_000_000 }); // > 24h
    insertSpanFor(stale);
    const fresh = insertClosedTrace();
    insertSpanFor(fresh);
    const { calls, fetchImpl } = makeFetch([new Response('{}', { status: 200 })]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => true,
      fetchImpl,
    });

    const result = await loop.tick();

    expect(result.droppedBacklog).toBe(1);
    expect(result.exported).toBe(1);
    expect(exportRow(stale.traceId)?.outcome).toBe('dropped_backlog');
    expect(counterValue('dropped_backlog')).toBe(1);
    expect(calls[0]?.body).not.toContain(stale.traceId.replaceAll('-', ''));
  });

  it('splits a body over 1 MiB into several requests, each under the cap', async () => {
    // Four traces × ~400 KiB of span names each ≈ 1.6 MiB in one body.
    const traces: Trace[] = [];
    for (let i = 0; i < 4; i++) {
      const trace = insertClosedTrace();
      insertSpanFor(trace, { kind: 'hook', name: `pad-${'x'.repeat(400_000)}` });
      traces.push(trace);
    }
    const { calls, fetchImpl } = makeFetch([new Response('{}', { status: 200 })]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => true,
      fetchImpl,
    });

    const result = await loop.tick();

    expect(result.exported).toBe(4);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(Buffer.byteLength(call.body, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    }
    for (const trace of traces) expect(exportRow(trace.traceId)?.outcome).toBe('exported');
  });

  it('stop() mid-tick releases every claim still held and leaves no timer', async () => {
    // Two ~700 KiB traces force two requests, so stop() can land between them.
    const shipped = insertClosedTrace();
    insertSpanFor(shipped, { kind: 'hook', name: `pad-${'x'.repeat(700_000)}` });
    const releasedTrace = insertClosedTrace({ startTs: Date.now() - 500 });
    insertSpanFor(releasedTrace, { kind: 'hook', name: `pad-${'y'.repeat(700_000)}` });

    let resolveFirst: ((res: Response) => void) | undefined;
    const gate = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const { calls, fetchImpl } = makeFetch([() => gate, new Response('{}', { status: 200 })]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => true,
      fetchImpl,
    });

    const tickPromise = loop.tick();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    loop.stop(); // while the first POST is in flight
    resolveFirst?.(new Response('{}', { status: 200 }));
    const result = await tickPromise;

    // The in-flight POST's result is honored; everything else is released.
    expect(result.exported).toBe(1);
    expect(result.released).toBe(1);
    expect(calls).toHaveLength(1);
    const releasedRow = exportRow(releasedTrace.traceId);
    expect(releasedRow?.claimed_at).toBeNull();
    expect(releasedRow?.exported_at).toBeNull();
  });

  it('stop() cancels the rescheduled timer', async () => {
    vi.useFakeTimers();
    const trace = insertClosedTrace();
    insertSpanFor(trace);
    const { calls, fetchImpl } = makeFetch([new Response('{}', { status: 200 })]);
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings({ intervalMs: 1000 }),
      isExportAllowed: () => true,
      fetchImpl,
    });

    loop.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    loop.stop();

    insertClosedTrace();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1); // no tick after stop()
  });

  it('a thrown store error releases every claim still held this tick', async () => {
    const trace = insertClosedTrace();
    insertSpanFor(trace);
    const errors: Error[] = [];
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings(),
      isExportAllowed: () => {
        throw new Error('registry exploded');
      },
      onError: (err) => errors.push(err),
      fetchImpl,
    });

    const result = await loop.tick();

    expect(result.released).toBe(1);
    expect(errors[0]?.message).toBe('registry exploded');
    const row = exportRow(trace.traceId);
    expect(row?.claimed_at).toBeNull();
    expect(row?.exported_at).toBeNull();
  });

  it('never lets a configured header value reach an onError message', async () => {
    const headerValue = 'Bearer sk-collector-credential-9f8e7d';
    const trace = insertClosedTrace();
    insertSpanFor(trace);
    const errors: Error[] = [];
    // A hostile collector echoing nothing; the network error carries the
    // header (as a proxy error might) — postOtlp discards thrown error text.
    const { calls, fetchImpl } = makeFetch([
      new Error(`proxy refused request with Authorization ${headerValue}`),
      new Response('denied', { status: 401 }),
    ]);
    let clock = 1_000_000_000_000;
    const loop = new OtlpPollLoop({
      store,
      settings: makeSettings({ headers: { Authorization: headerValue } }),
      isExportAllowed: () => true,
      onError: (err) => errors.push(err),
      fetchImpl,
      rng: () => 0,
      now: () => clock,
    });

    await loop.tick(); // network error → retryable + backoff warning
    clock += 1; // rng 0 → zero-length backoff window
    await loop.tick(); // 401 → rejected + onError

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)?.headers.Authorization).toBe(headerValue); // sent…
    // Both paths reported: the retryable warning and the rejection.
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toContain('network error');
    expect(errors[1]?.message).toContain('401');
    for (const err of errors) {
      expect(err.message).not.toContain(headerValue); // …never reported
      expect(err.message).not.toContain('sk-collector-credential');
    }
  });
});
