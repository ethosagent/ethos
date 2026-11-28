// think-deeper-tier-switch Task 4.2 — `ethos eval local --tier deep` parses and
// `--json` gains an `escalation` block built from the scored records.

import { EthosError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { escalationJson, parseLocalArgs, parseScoredRecords } from '../commands/eval';

describe('parseLocalArgs --tier', () => {
  it('defaults to no tier override', () => {
    expect(parseLocalArgs([]).tier).toBeUndefined();
  });

  it('parses --tier deep', () => {
    expect(parseLocalArgs(['--tier', 'deep']).tier).toBe('deep');
  });

  it('refuses an unknown tier', () => {
    expect(() => parseLocalArgs(['--tier', 'turbo'])).toThrow(EthosError);
    expect(() => parseLocalArgs(['--tier'])).toThrow(EthosError);
  });
});

describe('parseScoredRecords', () => {
  const src = [
    JSON.stringify({ task_id: 'a/1', role: 'user', content: 'p' }),
    JSON.stringify({
      task_id: 'a/1',
      role: 'assistant',
      score: 1,
      escalations: 2,
      usage: { input_tokens: 1, output_tokens: 1, estimated_cost_usd: 0.3 },
    }),
    JSON.stringify({ task_id: 'b/1', role: 'assistant', score: 0 }),
    '',
  ].join('\n');

  it('reads per-task scores and escalation records from assistant rows only', () => {
    const { results, escalationRecords } = parseScoredRecords(src);
    expect(results).toEqual([
      { id: 'a/1', score: 1 },
      { id: 'b/1', score: 0 },
    ]);
    expect(escalationRecords).toEqual([
      { escalations: 2, score: 1, costUsd: 0.3 },
      { escalations: 0, score: 0, costUsd: 0 },
    ]);
  });
});

describe('escalationJson', () => {
  it('is the summarizeEscalations block', () => {
    expect(
      escalationJson([
        { escalations: 1, score: 1, costUsd: 0.2 },
        { escalations: 0, score: 1, costUsd: 0.1 },
      ]),
    ).toEqual({
      tasks: 2,
      escalatedTasks: 1,
      escalations: 1,
      escalationRate: 0.5,
      passRateEscalated: 1,
      passRateNot: 1,
      costPerPassUsd: expect.closeTo(0.15, 10),
    });
  });
});
