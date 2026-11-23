// durable-background-jobs L6 — `delegate_task resume_on_restart`.
// A real SQLiteJobStore (not the FakeJobStore in background-tools.test.ts) so the
// assertion reads the persisted row.

import type { AgentLoop } from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { type BackgroundToolDeps, createDelegateTaskTool } from '../index';

const loop = {
  run: () => {
    throw new Error('loop.run must not be called on the background path');
  },
} as unknown as AgentLoop;

function makeCtx(): ToolContext {
  return {
    sessionId: 'parent-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    agentId: 'depth:0',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

function setup() {
  const store = new SQLiteJobStore(':memory:');
  const deps: BackgroundToolDeps = {
    store,
    nudge: vi.fn(),
    owner: 'worker-1',
    defaultMaxCostUsd: 1.5,
    maxJobsPerRoot: 3,
    maxJobsPerPersonality: 5,
    staleMs: 60_000,
  };
  return { store, tool: createDelegateTaskTool(loop, deps) };
}

async function createdJob(store: SQLiteJobStore, value: string) {
  const parsed: unknown = JSON.parse(value);
  const id =
    typeof parsed === 'object' && parsed !== null && 'jobId' in parsed ? String(parsed.jobId) : '';
  return store.get(id);
}

describe('delegate_task resume_on_restart', () => {
  it('is refused without background: true', async () => {
    const { tool } = setup();
    const res = await tool.execute({ prompt: 'x', resume_on_restart: false }, makeCtx());
    expect(res).toEqual({
      ok: false,
      code: 'input_invalid',
      error: 'resume_on_restart is only valid with background: true',
    });
  });

  it('rejects a non-boolean', async () => {
    const { tool } = setup();
    const res = await tool.execute(
      { prompt: 'x', background: true, resume_on_restart: 'no' },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('input_invalid');
  });

  it('false stamps noResume on the created row', async () => {
    const { store, tool } = setup();
    const res = await tool.execute(
      { prompt: 'x', background: true, resume_on_restart: false },
      makeCtx(),
    );
    if (!res.ok) throw new Error(res.error);
    expect((await createdJob(store, res.value))?.noResume).toBe(true);
  });

  it('omitted leaves noResume unset', async () => {
    const { store, tool } = setup();
    const res = await tool.execute({ prompt: 'x', background: true }, makeCtx());
    if (!res.ok) throw new Error(res.error);
    expect((await createdJob(store, res.value))?.noResume).toBeUndefined();
  });
});
