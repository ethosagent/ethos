// think-deeper-tier-switch — the `tier_escalation` SSE event mirrors the
// `tier_escalation` AgentEvent (@ethosagent/types). These gates keep the zod
// mirror and the TS variant from drifting: same keys, same tier names.

import type { AgentEvent, ModelTierName } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { SseEventSchema, TierEscalationEventSchema } from '../events';

type AgentTierEscalationEvent = Extract<AgentEvent, { type: 'tier_escalation' }>;

// Exhaustive by type: a key missing here, or an extra one, fails typecheck.
const AGENT_KEYS: Record<keyof AgentTierEscalationEvent, true> = {
  type: true,
  from: true,
  to: true,
  model: true,
  reason: true,
  traceId: true,
};

const EVENT: AgentTierEscalationEvent = {
  type: 'tier_escalation',
  from: 'default',
  to: 'deep',
  model: 'claude-opus-5',
  reason: 'race condition',
  traceId: 'trace_1',
};

describe('TierEscalationEventSchema', () => {
  it('has exactly the AgentEvent variant keys', () => {
    expect(Object.keys(TierEscalationEventSchema.shape).sort()).toEqual(
      Object.keys(AGENT_KEYS).sort(),
    );
  });

  it('round-trips through the SSE union intact', () => {
    const parsed = SseEventSchema.parse(EVENT);
    expect(parsed).toEqual(EVENT);
  });

  it('accepts every ModelTierName and nothing else', () => {
    const tiers: ModelTierName[] = ['trivial', 'default', 'deep', 'dreaming'];
    for (const tier of tiers) {
      expect(TierEscalationEventSchema.safeParse({ ...EVENT, to: tier }).success).toBe(true);
    }
    expect(TierEscalationEventSchema.safeParse({ ...EVENT, to: 'turbo' }).success).toBe(false);
  });
});
