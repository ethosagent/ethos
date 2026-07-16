// End-to-end integration — the Phase A headline scenario.
//
// The unit tests cover the pieces (tool envelope, store transitions, executor
// pool). This proves they COMPOSE: delegate_task (background) → SQLiteJobStore →
// BackgroundExecutor runs the child loop → task_result reads the summary back.

import type { AgentLoop } from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import type { Storage, Tool, ToolContext } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundExecutor } from '../index';

// A mock loop whose run() streams a text_delta (carrying the ## Summary section
// the executor extracts), a usage event (folded into spend), and a final done.
function makeLoop(): AgentLoop {
  return {
    run: vi.fn(() =>
      (async function* () {
        yield { type: 'text_delta', text: 'work done\n\n## Summary\nfound the answer' };
        yield { type: 'usage', estimatedCostUsd: 0.01, inputTokens: 1, outputTokens: 1 };
        yield { type: 'done', text: 'work done\n\n## Summary\nfound the answer', turnCount: 1 };
      })(),
    ),
  } as unknown as AgentLoop;
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'parent-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    agentId: 'depth:0',
    personalityId: 'me',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

describe('background sub-agents — end-to-end spawn-and-continue', () => {
  let executor: BackgroundExecutor;

  afterEach(async () => {
    await executor.shutdown();
    vi.restoreAllMocks();
  });

  it('delegates in the background, runs the job to done, and reads the summary back', async () => {
    const loop = makeLoop();
    const store = new SQLiteJobStore(':memory:');
    executor = new BackgroundExecutor({
      store,
      loop,
      owner: 'test',
      config: {
        maxConcurrentJobs: 2,
        staleMs: 90_000,
        heartbeatMs: 30_000,
        queuedTtlMs: 900_000,
        maxRootBackgroundUsd: 5.0,
        pollMs: 20,
      },
    });
    executor.start();

    const background = {
      store,
      nudge: () => executor.nudge(),
      owner: 'test',
      defaultMaxCostUsd: 1.0,
      maxJobsPerRoot: 3,
      maxJobsPerPersonality: 5,
      staleMs: 90_000,
    };

    const tools = createDelegationTools(loop, {} as unknown as Storage, undefined, background);
    const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
    const delegateTask = byName.get('delegate_task');
    const taskResult = byName.get('task_result');
    if (!delegateTask || !taskResult) throw new Error('expected delegation tools registered');

    const ctx = makeCtx();

    // Spawn in the background → immediate queued envelope.
    const spawn = await delegateTask.execute({ prompt: 'do the thing', background: true }, ctx);
    expect(spawn.ok).toBe(true);
    if (!spawn.ok) throw new Error('delegate_task failed');
    const envelope = JSON.parse(spawn.value) as { jobId: string; status: string };
    expect(envelope.status).toBe('queued');
    const jobId = envelope.jobId;

    // The executor claims and runs it to completion.
    await vi.waitFor(
      async () => {
        const s = await store.get(jobId);
        expect(s?.status).toBe('done');
      },
      { timeout: 3000 },
    );

    // task_result returns the extracted summary; its output is untrusted.
    const result = await taskResult.execute({ id: jobId }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('task_result failed');
    expect(result.value).toContain('found the answer');
    expect(taskResult.outputIsUntrusted).toBe(true);

    // Usage was folded into the job's spend.
    const finished = await store.get(jobId);
    expect(finished?.spendUsd).toBeGreaterThan(0);
  });
});
