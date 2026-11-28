// think-deeper-tier-switch Task 2.1 — the `tier_escalation` AgentEvent carries
// the tiers, the model the provider is asked to serve, and a cleaned reason.
// `TIER_ESCALATION_EVENT_KEYS` names EVERY key of the variant and nothing else:
// a missing key fails typecheck, and so does an extra one.

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-event';
import { isKnownAgentEvent } from '../agent-event';

type TierEscalationEvent = Extract<AgentEvent, { type: 'tier_escalation' }>;

const TIER_ESCALATION_EVENT_KEYS: Record<keyof TierEscalationEvent, true> = {
  type: true,
  from: true,
  to: true,
  model: true,
  reason: true,
  traceId: true,
};

describe('tier_escalation event shape', () => {
  it('is a known AgentEvent type', () => {
    expect(isKnownAgentEvent({ type: 'tier_escalation' })).toBe(true);
  });

  it('builds a typed literal and pins the key set', () => {
    const event: TierEscalationEvent = {
      type: 'tier_escalation',
      from: 'default',
      to: 'deep',
      model: 'claude-opus-5',
      reason: 'race condition',
    };
    const keys = Object.keys(TIER_ESCALATION_EVENT_KEYS).sort();
    expect(keys).toEqual(['from', 'model', 'reason', 'to', 'traceId', 'type']);
    expect(event.to).toBe('deep');
  });
});
