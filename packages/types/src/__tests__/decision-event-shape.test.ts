// K13 (plan decision-provider-personality §13, §15.8) — the `decision`
// AgentEvent carries summaries and numbers only: never the redacted digest,
// the question text, or the provider's raw answer object. `DECISION_EVENT_KEYS`
// must name EVERY key of the variant and nothing else — a missing key fails
// typecheck, and so does an extra one (excess-property check) — so adding a
// field to the event forces an edit here, where the forbidden list is checked.

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-event';

type DecisionEvent = Extract<AgentEvent, { type: 'decision' }>;

const DECISION_EVENT_KEYS: Record<keyof DecisionEvent, true> = {
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

const FORBIDDEN = [
  'digest',
  'state',
  'content',
  'message',
  'question',
  'questions',
  'instructions',
  'answers',
  'jevVerdict',
  'probabilities',
];

describe('decision AgentEvent shape (K13)', () => {
  it('carries no digest, question text or raw provider answer', () => {
    const keys = Object.keys(DECISION_EVENT_KEYS);
    for (const forbidden of FORBIDDEN) expect(keys).not.toContain(forbidden);
    expect(keys).toHaveLength(18);
  });
});
