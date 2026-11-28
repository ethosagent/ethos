// think-deeper-tier-switch Task 4.1 — the runner counts `tier_escalation`
// events and sums usage across a task's calls; `summarizeEscalations` folds the
// scored records into the escalation rate, pass rates and cost per pass.

import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AtroposRecord } from '@ethosagent/batch-runner';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { summarizeEscalations } from '../local-report';
import { EvalRunner } from '../runner';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-escalation-report-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const escalation: AgentEvent = {
  type: 'tier_escalation',
  from: 'default',
  to: 'deep',
  model: 'claude-opus-5',
  reason: 'hard',
};

const usage = (cost: number): AgentEvent => ({
  type: 'usage',
  inputTokens: 10,
  outputTokens: 5,
  estimatedCostUsd: cost,
});

async function readRecords(path: string): Promise<AtroposRecord[]> {
  const src = await readFile(path, 'utf-8');
  return src
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AtroposRecord);
}

describe('EvalRunner escalation accounting', () => {
  it('writes escalations and SUMS usage across a task’s calls', async () => {
    const seenRunOpts: Array<Record<string, unknown>> = [];
    const loop = {
      run: async function* (_prompt: string, opts: Record<string, unknown>) {
        seenRunOpts.push(opts);
        yield usage(0.01);
        yield escalation;
        yield usage(0.2);
        yield { type: 'text_delta', text: 'answer' } as AgentEvent;
        yield { type: 'done', text: 'answer', turnCount: 1 } as AgentEvent;
      },
    } as unknown as AgentLoop;
    const outputPath = join(testDir, 'out.jsonl');
    const runner = new EvalRunner(loop, {
      concurrency: 1,
      outputPath,
      defaultScorer: 'contains',
      storage: new FsStorage(),
    });

    await runner.run(
      [{ id: 't1', prompt: 'p' }],
      new Map([['t1', { id: 't1', expected: 'answer' }]]),
    );

    const records = await readRecords(outputPath);
    const assistant = records.find((r) => r.role === 'assistant');
    expect(assistant?.escalations).toBe(1);
    expect(assistant?.usage?.input_tokens).toBe(20);
    expect(assistant?.usage?.output_tokens).toBe(10);
    expect(assistant?.usage?.estimated_cost_usd).toBeCloseTo(0.21, 10);
    // No `tierOverride` unless asked for.
    expect('tierOverride' in (seenRunOpts[0] ?? {})).toBe(false);
  });

  it('forwards tierOverride to loop.run (the always-deep arm)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const loop = {
      run: async function* (_prompt: string, opts: Record<string, unknown>) {
        seen.push(opts);
        yield { type: 'done', text: '', turnCount: 1 } as AgentEvent;
      },
    } as unknown as AgentLoop;
    const runner = new EvalRunner(loop, {
      concurrency: 1,
      outputPath: join(testDir, 'out.jsonl'),
      defaultScorer: 'contains',
      storage: new FsStorage(),
      tierOverride: 'deep',
    });

    await runner.run([{ id: 't1', prompt: 'p' }], new Map());

    expect(seen[0]?.tierOverride).toBe('deep');
  });
});

describe('summarizeEscalations', () => {
  const rec = (escalations: number, score: number, costUsd: number) => ({
    escalations,
    score,
    costUsd,
  });

  it('folds records into rates and cost per passing task', () => {
    const s = summarizeEscalations([
      rec(2, 1, 0.3), // escalated, passed
      rec(1, 0, 0.2), // escalated, failed
      rec(0, 1, 0.1), // not escalated, passed
      rec(0, 1, 0.1), // not escalated, passed
    ]);
    expect(s).toEqual({
      tasks: 4,
      escalatedTasks: 2,
      escalations: 3,
      escalationRate: 0.5,
      passRateEscalated: 0.5,
      passRateNot: 1,
      costPerPassUsd: expect.closeTo(0.7 / 3, 10),
    });
  });

  it('reports null where a rate has no denominator', () => {
    expect(summarizeEscalations([rec(0, 0, 0.1)])).toEqual({
      tasks: 1,
      escalatedTasks: 0,
      escalations: 0,
      escalationRate: 0,
      passRateEscalated: null,
      passRateNot: 0,
      costPerPassUsd: null,
    });
    expect(summarizeEscalations([])).toEqual({
      tasks: 0,
      escalatedTasks: 0,
      escalations: 0,
      escalationRate: 0,
      passRateEscalated: null,
      passRateNot: null,
      costPerPassUsd: null,
    });
  });
});
