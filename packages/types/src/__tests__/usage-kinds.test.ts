import { describe, expect, it } from 'vitest';
import {
  GATE_EXEMPT_KINDS,
  sourceClassOf,
  USAGE_SOURCE_KINDS,
  type UsageSourceKind,
  usageMeterEventRecord,
} from '../usage';

// D5 (plan background-usage-accounting) — a usage kind cannot exist without a
// class. `sourceClassOf` is a total map; this pins every kind's class, so a new
// kind is a one-line types change plus one line here.
const EXPECTED: Record<UsageSourceKind, 'turn_utility' | 'background' | 'operator'> = {
  tool_llm: 'turn_utility',
  memory_flush: 'turn_utility',
  compaction: 'turn_utility',
  injection_classifier: 'turn_utility',
  smart_approver: 'turn_utility',
  decision: 'turn_utility',
  completion_verifier: 'turn_utility',
  title: 'turn_utility',
  memory_capture: 'background',
  memory_consolidation: 'background',
  improvement_fork: 'background',
  learning_replay: 'background',
  goal_judge: 'background',
  call_summary: 'background',
  channel_digest: 'background',
  plugin_monitor: 'background',
  embedding: 'background',
  nightly: 'operator',
  skill_evolver: 'operator',
  personality_draft: 'operator',
  debug_assistant: 'operator',
};

describe('UsageSourceKind → UsageSourceClass', () => {
  it('every kind has a class in sourceClassOf', () => {
    for (const kind of USAGE_SOURCE_KINDS) {
      expect(['turn_utility', 'background', 'operator']).toContain(sourceClassOf(kind));
    }
  });

  it('the kind list is exactly the union, each with its pinned class', () => {
    expect([...USAGE_SOURCE_KINDS].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const kind of USAGE_SOURCE_KINDS) expect(sourceClassOf(kind)).toBe(EXPECTED[kind]);
  });
});

describe('GATE_EXEMPT_KINDS (D38)', () => {
  it('is exactly goal_judge, and only background kinds', () => {
    expect([...GATE_EXEMPT_KINDS]).toEqual(['goal_judge']);
    for (const kind of GATE_EXEMPT_KINDS) expect(sourceClassOf(kind)).toBe('background');
  });
});

describe('usageMeterEventRecord', () => {
  it('codes a skip by its type and keeps the rest as details', () => {
    expect(
      usageMeterEventRecord({
        type: 'usage.background_skipped',
        kind: 'channel_digest',
        attribution: { botKey: 'b' },
        spentUsd: 2,
        capUsd: 1,
      }),
    ).toEqual({
      code: 'usage.background_skipped',
      cause: 'background channel_digest call skipped: the daily budget is spent',
      details: { kind: 'channel_digest', attribution: { botKey: 'b' }, spentUsd: 2, capUsd: 1 },
    });
  });
});
