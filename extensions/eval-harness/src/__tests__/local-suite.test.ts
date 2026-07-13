import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTasksJsonl } from '@ethosagent/batch-runner';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregateByCategory, categoryOf, summarizeRepairs } from '../local-report';
import { EvalRunner, parseExpectedJsonl } from '../runner';
import type { EvalExpected } from '../types';

// The committed local-model qualification suite (evals/local) runs in CI against
// a STUB provider — real-model runs are manual/dogfood. This test proves the
// suite loads, every case runs, per-category aggregation produces rates, and the
// execute-with-{} invariant holds (0). It never hits a real model.

const suiteDir = join(import.meta.dirname, '..', '..', '..', '..', 'evals', 'local');

/** Stub loop that returns canned correct answers keyed by task id. Every
 *  dataset case uses a `contains` or `exact` scorer, so echoing the expected
 *  string back is a passing answer for all of them. */
function stubLoop(expectedMap: Map<string, EvalExpected>): AgentLoop {
  return {
    run: async function* (_prompt: string, opts: { sessionKey?: string }) {
      const taskId = opts.sessionKey?.replace('eval:', '') ?? '';
      const text = expectedMap.get(taskId)?.expected ?? '';
      const events: AgentEvent[] = [
        { type: 'text_delta', text },
        { type: 'done', text, turnCount: 1 },
      ];
      for (const e of events) yield e;
    },
  } as unknown as AgentLoop;
}

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-local-suite-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('evals/local suite (stub provider)', () => {
  it('loads a well-formed dataset with a matching expected entry per case', async () => {
    const tasks = parseTasksJsonl(await readFile(join(suiteDir, 'tasks.jsonl'), 'utf-8'));
    const expectedMap = parseExpectedJsonl(
      await readFile(join(suiteDir, 'expected.jsonl'), 'utf-8'),
    );

    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      // Every case id carries a `<category>/<name>` tag.
      expect(categoryOf(task.id)).not.toBe('uncategorized');
      expect(expectedMap.has(task.id)).toBe(true);
    }

    // The five §9 categories are all represented.
    const categories = new Set(tasks.map((t) => categoryOf(t.id)));
    for (const expected of [
      'tool-calling',
      'json-discipline',
      'planning',
      'coding',
      'compaction-survival',
    ]) {
      expect(categories.has(expected)).toBe(true);
    }
  });

  it('runs every case and produces per-category pass rates', async () => {
    const tasks = parseTasksJsonl(await readFile(join(suiteDir, 'tasks.jsonl'), 'utf-8'));
    const expectedMap = parseExpectedJsonl(
      await readFile(join(suiteDir, 'expected.jsonl'), 'utf-8'),
    );

    const outputPath = join(testDir, 'out.jsonl');
    const runner = new EvalRunner(stubLoop(expectedMap), {
      concurrency: 2,
      outputPath,
      defaultScorer: 'contains',
      storage: new FsStorage(),
    });

    const stats = await runner.run(tasks, expectedMap);
    expect(stats.total).toBe(tasks.length);

    // Every case ran: one assistant record per task.
    const records = (await readFile(outputPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { task_id: string; role: string; score?: number });
    const assistant = records.filter((r) => r.role === 'assistant');
    expect(assistant).toHaveLength(tasks.length);

    // Canned correct answers pass every case.
    expect(stats.passed).toBe(tasks.length);
    expect(stats.failed).toBe(0);

    const results = assistant.map((r) => ({ id: r.task_id, score: r.score ?? 0 }));
    const categories = aggregateByCategory(results);
    expect(categories.length).toBe(5);
    for (const cat of categories) {
      expect(cat.total).toBeGreaterThan(0);
      expect(cat.passRate).toBeGreaterThanOrEqual(0);
      expect(cat.passRate).toBeLessThanOrEqual(1);
      expect(cat.passRate).toBe(1);
    }
  });

  it('holds the execute-with-{} invariant (0) with no repair events', () => {
    const repair = summarizeRepairs([]);
    expect(repair.executeWithEmptyArgs).toBe(0);
    expect(repair.repaired).toBe(0);
    expect(repair.failed).toBe(0);
    expect(repair.repairSuccessRate).toBe(1);
  });

  it('summarizes repair outcomes from observability events', () => {
    const repair = summarizeRepairs([
      { details: { outcome: 'repaired' } },
      { details: { outcome: 'repaired' } },
      { details: { outcome: 'failed' } },
    ]);
    expect(repair.repaired).toBe(2);
    expect(repair.failed).toBe(1);
    expect(repair.total).toBe(3);
    expect(repair.repairSuccessRate).toBeCloseTo(2 / 3);
    expect(repair.executeWithEmptyArgs).toBe(0);
  });
});
