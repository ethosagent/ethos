// Gate 7: Customer-debugging integration test.
//
// Synthesizes a worked timeline (policy transition mid-session, tool calls
// before and after), calls diagnoseBundleLines, and asserts the diagnosis
// names the policy transition as the root cause.

import { randomUUID } from 'node:crypto';
import type { ObsEvent, Span, Trace } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';

// Mock wiring and config to avoid the plugin-loader transitive dependency
// (support.ts uses getStorage/readConfig only in runBundle/runInspect, not in diagnoseBundleLines)
vi.mock('../wiring', () => ({ getStorage: vi.fn() }));
vi.mock('../config', () => ({ ethosDir: vi.fn(() => '/tmp'), readConfig: vi.fn() }));

import { diagnoseBundleLines } from '../commands/support';

const BASE_TS = new Date('2026-05-04T14:00:00Z').getTime();

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    traceId: randomUUID(),
    kind: 'turn',
    startTs: BASE_TS,
    endTs: BASE_TS + 3000,
    status: 'ok',
    ...overrides,
  };
}

function makeSpan(traceId: string, overrides: Partial<Span> = {}): Span {
  return {
    spanId: randomUUID(),
    traceId,
    kind: 'tool_call',
    name: 'bash',
    startTs: BASE_TS,
    endTs: BASE_TS + 1200,
    status: 'ok',
    ...overrides,
  };
}

function makeTransitionEvent(ts: number, from: string, to: string): ObsEvent {
  return {
    eventId: randomUUID(),
    ts,
    category: 'audit.transition',
    severity: 'info',
    details: { from, to },
  };
}

describe('diagnoseBundleLines — customer-debugging integration', () => {
  it('detects a policy transition and names from/to personalities', () => {
    const traces = [
      makeTrace({ startTs: BASE_TS, endTs: BASE_TS + 3000 }),
      makeTrace({ startTs: BASE_TS + 150_000, endTs: BASE_TS + 155_000 }),
    ];
    const trace0 = traces[0];
    const trace1 = traces[1];
    if (!trace0 || !trace1) throw new Error('traces array too short');
    const spans = [
      makeSpan(trace0.traceId, { name: 'bash', startTs: BASE_TS + 100 }),
      makeSpan(trace1.traceId, { name: 'bash', startTs: BASE_TS + 151_000 }),
    ];
    const transitionTs = BASE_TS + 120_000;
    const events: ObsEvent[] = [
      makeTransitionEvent(transitionTs, 'engineer-paired', 'engineer-yolo'),
    ];

    const lines = diagnoseBundleLines(traces, spans, events);

    const joined = lines.join('\n');
    expect(joined).toContain('policy transition');
    expect(joined).toContain('engineer-paired');
    expect(joined).toContain('engineer-yolo');
  });

  it('detects blocked tool calls', () => {
    const trace = makeTrace();
    const events: ObsEvent[] = [
      {
        eventId: randomUUID(),
        ts: BASE_TS + 500,
        category: 'audit.block',
        severity: 'warn',
        code: 'safety.network.blocked',
        cause: 'POST to internal-vpn.example.com blocked',
      },
    ];

    const lines = diagnoseBundleLines([trace], [], events);
    const joined = lines.join('\n');
    expect(joined).toContain('blocked');
    expect(joined).toContain('safety.network.blocked');
  });

  it('detects auto-approvals that bypassed user confirmation', () => {
    const trace = makeTrace();
    const events: ObsEvent[] = [
      {
        eventId: randomUUID(),
        ts: BASE_TS + 200,
        category: 'audit.approval',
        severity: 'info',
        details: { auto: true, tool: 'bash' },
      },
    ];

    const lines = diagnoseBundleLines([trace], [], events);
    expect(lines.join('\n')).toContain('auto-approval');
  });

  it('reports no anomalies for a clean window', () => {
    const trace = makeTrace();
    const spans = [makeSpan(trace.traceId)];

    const lines = diagnoseBundleLines([trace], spans, []);
    expect(lines.join('\n')).toContain('No anomalies detected');
  });

  it('calls out the slowest tool call when it exceeds 5s', () => {
    const trace = makeTrace();
    const slowSpan = makeSpan(trace.traceId, {
      name: 'web_fetch',
      startTs: BASE_TS,
      endTs: BASE_TS + 8000, // 8 seconds
    });

    const lines = diagnoseBundleLines([trace], [slowSpan], []);
    expect(lines.join('\n')).toContain('web_fetch');
    expect(lines.join('\n')).toContain('8.0s');
  });

  it('full worked example: transition + blocks + errors all surface in diagnosis', () => {
    const t1 = makeTrace({ startTs: BASE_TS, endTs: BASE_TS + 5000 });
    const t2 = makeTrace({ startTs: BASE_TS + 150_000, endTs: BASE_TS + 152_000 });

    const spans: Span[] = [
      makeSpan(t1.traceId, { name: 'bash', attrs: { args: 'git push' } }),
      makeSpan(t2.traceId, {
        name: 'bash',
        attrs: { args: 'git push origin --delete release-1.2' },
      }),
    ];

    const events: ObsEvent[] = [
      makeTransitionEvent(BASE_TS + 120_000, 'engineer-paired', 'engineer-yolo'),
      {
        eventId: randomUUID(),
        ts: BASE_TS + 151_000,
        category: 'audit.approval',
        severity: 'info',
        details: { auto: true, tool: 'bash' },
      },
      {
        eventId: randomUUID(),
        ts: BASE_TS + 151_500,
        category: 'error',
        severity: 'error',
        code: 'PROVIDER_TIMEOUT',
        cause: 'LLM provider timed out',
      },
    ];

    const lines = diagnoseBundleLines([t1, t2], spans, events);
    const joined = lines.join('\n');

    // Policy transition named
    expect(joined).toContain('engineer-paired');
    expect(joined).toContain('engineer-yolo');
    // Auto-approval surfaced
    expect(joined).toContain('auto-approval');
    // Error surfaced
    expect(joined).toContain('PROVIDER_TIMEOUT');
  });
});
