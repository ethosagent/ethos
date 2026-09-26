// P2-counters — decision 11 / D15: `metric_counters` is a pre-aggregated
// monotonic-totals table, exempt from retention pruning. Pruning the spans
// and traces that CAUSED an increment must never make the counter go
// backwards — that is what a Prometheus `rate()` reads as a process restart.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETENTION_DEFAULTS } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneObservabilityByPath } from '../retention';
import { SQLiteObservabilityStore } from '../store';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obs-retention-metrics-'));
  dbPath = join(tmp, 'observability.db');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = 1_000_000_000_000;
const OLD = NOW - 200 * 86_400_000; // 200 days ago — past every default TTL

describe('retention prune vs. metric_counters', () => {
  it('a prune cycle leaves metric_counters rows and values unchanged', () => {
    const store = new SQLiteObservabilityStore(dbPath);
    const traceId = randomUUID();
    store.insertTrace({
      traceId,
      kind: 'turn',
      startTs: OLD,
      subjectId: 'engineer',
      attrs: { platform: 'cli' },
    });
    const spanId = randomUUID();
    store.insertSpan({ spanId, traceId, kind: 'llm_call', name: 'claude-sonnet-5', startTs: OLD });
    store.closeSpan(spanId, 'ok', {
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.001,
      provider: 'anthropic',
      costBasis: 'priced',
    });
    store.closeTrace(traceId, 'ok');

    const before = store.getMetricCounters();
    expect(before.length).toBeGreaterThan(0);
    store.close();

    // Old enough that the default 90d trace/span TTL prunes both rows.
    const result = pruneObservabilityByPath(dbPath, RETENTION_DEFAULTS, {
      now: NOW,
      dryRun: false,
    });
    expect(result.traces).toBe(1);
    expect(result.spans).toBe(1);

    const reopened = new SQLiteObservabilityStore(dbPath);
    const after = reopened.getMetricCounters();
    expect(after).toEqual(before);

    // The span/trace that caused the increments is genuinely gone — this
    // proves the counters are pre-aggregated, not a live SUM that happened
    // to still find rows.
    expect(reopened.getTrace(traceId)).toBeNull();
    reopened.close();
  });

  it('counts a pruned un-exported trace when the otlp sink is active, and drops its row', () => {
    const store = new SQLiteObservabilityStore(dbPath);

    // Make the sink "active": one old trace terminally exported for 'otlp'.
    const exportedId = randomUUID();
    store.insertTrace({ traceId: exportedId, kind: 'turn', startTs: OLD });
    store.closeTrace(exportedId, 'ok');
    const claimed = store.claimTracesForSink('otlp', 10, 120_000, 0);
    const claim = claimed[0];
    if (!claim) throw new Error('expected a claim');
    store.markSinkExported('otlp', exportedId, claim.claimedAt, 'exported');

    // One old trace the sink never terminally stamped — the doomed one.
    const unexportedId = randomUUID();
    store.insertTrace({ traceId: unexportedId, kind: 'turn', startTs: OLD });
    store.closeTrace(unexportedId, 'ok');
    store.close();

    const result = pruneObservabilityByPath(dbPath, RETENTION_DEFAULTS, {
      now: NOW,
      dryRun: false,
    });
    expect(result.traces).toBe(2);
    expect(result.unexportedPruned).toBe(1);

    const reopened = new SQLiteObservabilityStore(dbPath);
    const pruned = reopened
      .getMetricCounters()
      .find((r) => r.metric === 'ethos_otlp_export_traces_total');
    expect(pruned).toEqual({
      metric: 'ethos_otlp_export_traces_total',
      labels: { outcome: 'pruned' },
      value: 1,
    });

    // Both trace_exports rows are gone: their traces no longer exist, and
    // nothing pends for the sink any more.
    expect(reopened.oldestUnexportedStartTs('otlp')).toBeNull();
    expect(reopened.claimTracesForSink('otlp', 10, 120_000, 0)).toHaveLength(0);
    reopened.close();
  });

  it('with no otlp rows ever written, a prune bumps no otlp counter', () => {
    const store = new SQLiteObservabilityStore(dbPath);
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: OLD });
    store.closeTrace(traceId, 'ok');
    store.close();

    const result = pruneObservabilityByPath(dbPath, RETENTION_DEFAULTS, {
      now: NOW,
      dryRun: false,
    });
    expect(result.traces).toBe(1);
    expect(result.unexportedPruned).toBe(0);

    const reopened = new SQLiteObservabilityStore(dbPath);
    const rows = reopened
      .getMetricCounters()
      .filter((r) => r.metric === 'ethos_otlp_export_traces_total');
    expect(rows).toEqual([]);
    reopened.close();
  });

  it('a second prune cycle over already-pruned data still leaves counters monotonic', () => {
    const store = new SQLiteObservabilityStore(dbPath);
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: OLD, attrs: { platform: 'cli' } });
    store.closeTrace(traceId, 'ok');
    const before = store.getMetricCounters();
    store.close();

    pruneObservabilityByPath(dbPath, RETENTION_DEFAULTS, { now: NOW, dryRun: false });
    pruneObservabilityByPath(dbPath, RETENTION_DEFAULTS, { now: NOW, dryRun: false });

    const reopened = new SQLiteObservabilityStore(dbPath);
    const after = reopened.getMetricCounters();
    expect(after).toEqual(before);
    reopened.close();
  });
});
