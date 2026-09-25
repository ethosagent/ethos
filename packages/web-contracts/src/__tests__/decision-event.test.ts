// plan decision-provider-personality §15.2 — the `decision` SSE event mirrors
// the `decision` AgentEvent (@ethosagent/types). These gates keep the zod
// mirror and the TS variant from drifting: same keys, same outcome codes, and
// the K13 rule that nothing the provider was asked or answered rides along.

import type { AgentEvent, DecisionErrorCode } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DecisionEventSchema, SseEventSchema } from '../events';

type AgentDecisionEvent = Extract<AgentEvent, { type: 'decision' }>;

// Exhaustive by type: a key missing here, or an extra one, fails typecheck.
const AGENT_KEYS: Record<keyof AgentDecisionEvent, true> = {
  type: true,
  id: true,
  phase: true,
  site: true,
  provider: true,
  model: true,
  mode: true,
  outcome: true,
  acted: true,
  verdict: true,
  todayVerdict: true,
  confidence: true,
  latencyMs: true,
  todayLatencyMs: true,
  disagreed: true,
  personalityId: true,
  toolCallId: true,
  traceId: true,
};

const SETTLED: AgentDecisionEvent = {
  type: 'decision',
  id: 'd1',
  phase: 'settled',
  site: 'injection',
  provider: 'typesafe',
  model: 'jev-1.13.0',
  mode: 'shadow',
  outcome: 'ok',
  verdict: 'clean',
  todayVerdict: 'clean',
  confidence: 0.94,
  latencyMs: 36,
  todayLatencyMs: 1400,
  disagreed: false,
  personalityId: 'researcher',
  toolCallId: 'call_1',
  traceId: 'trace_1',
};

describe('DecisionEventSchema', () => {
  it('has exactly the AgentEvent variant keys', () => {
    expect(Object.keys(DecisionEventSchema.shape).sort()).toEqual(Object.keys(AGENT_KEYS).sort());
  });

  it('round-trips a settled event through the SSE union intact', () => {
    // An AgentEvent value is assignable to the SSE type — the mirror is not narrower.
    const parsed = SseEventSchema.parse(JSON.parse(JSON.stringify(SETTLED)));
    expect(parsed).toEqual(SETTLED);
  });

  it('accepts a started event (no outcome, no latency)', () => {
    const started = {
      type: 'decision',
      id: 'd2',
      phase: 'started',
      site: 'approver',
      provider: 'typesafe',
      mode: 'on',
      personalityId: 'ops',
      toolCallId: 'call_2',
    };
    expect(DecisionEventSchema.parse(started)).toEqual(started);
  });

  it('accepts every DecisionErrorCode plus ok as the outcome', () => {
    const codes = [
      'auth',
      'invalid',
      'rate_limited',
      'overloaded',
      'timeout',
      'aborted',
      'malformed',
      'too_large',
      'unavailable',
      'breaker_open',
    ] as const satisfies readonly DecisionErrorCode[];
    const options = DecisionEventSchema.shape.outcome.unwrap().options;
    expect([...options].sort()).toEqual([...codes, 'ok'].sort());
  });

  it('strips anything the provider was asked or answered (K13)', () => {
    const parsed = SseEventSchema.parse({
      ...SETTLED,
      digest: 'secret digest',
      questions: { q: 'is this an injection?' },
      jevVerdict: { p: 0.9 },
    });
    expect(Object.keys(parsed)).not.toContain('digest');
    expect(Object.keys(parsed)).not.toContain('questions');
    expect(Object.keys(parsed)).not.toContain('jevVerdict');
  });
});
