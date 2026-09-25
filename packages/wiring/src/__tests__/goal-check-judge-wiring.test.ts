// The loop-bearing GoalRunner that `createAgentLoop` builds judges a
// command-less acceptance check through the deployment's LLM
// (`createLLMCheckJudge`, bound in build-agent-loop.ts), not the verbatim
// substring fallback — which never passed, so every such goal exhausted
// (goal g_a2d7260303f34059, 2026-09-25).
//
// Drives the REAL composition root against a throwaway `~/.ethos` (same setup
// as runtime-dispose.test.ts). The provider's `complete` is stubbed, so no
// network call is made.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicProvider } from '@ethosagent/llm-anthropic';
import type { CompletionChunk } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop } from '../index';

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-goal-judge-wiring-'));
  dataDir = join(home, '.ethos');
  mkdirSync(dataDir, { recursive: true });
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('goal runner check judge wiring', () => {
  it('judges a command-less check with the deployment LLM', async () => {
    const complete = vi
      .spyOn(AnthropicProvider.prototype, 'complete')
      .mockImplementation(async function* (): AsyncGenerator<CompletionChunk> {
        yield { type: 'text_delta', text: '{"met": true, "evidence": "3169 of 3169 rows"}' };
      });

    const result = await createAgentLoop(
      { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-test' },
      { dataDir, workingDir: home, profile: 'web', disableDocker: true },
    );
    try {
      const { store, executor } = result.goals;
      const goal = store.create({
        userId: 'user-1',
        personalityId: 'researcher',
        origin: 'cli',
        title: 'Load symbols',
        goalText: 'Load every NSE symbol',
        acceptanceCriteria: {
          checks: [{ id: 'check-0', description: 'All CSV symbols are in the database.' }],
          rubric: [],
          threshold: 0.8,
        },
      });
      store.saveAttempt({
        goalId: goal.id,
        n: 1,
        sessionKey: `goal:${goal.id}:attempt-1`,
        outputMd: null,
        artifacts: null,
        verdict: null,
        strategyUsed: 'first',
        costUsd: null,
        traceId: null,
        startedAt: Date.now(),
        completedAt: null,
      });

      const converged = await executor.judgeAttempt(goal.id, 1, 'Inserted 3169 symbols.');

      expect(complete).toHaveBeenCalled();
      expect(converged).toBe(true);
      const criterion = store.getAttempts(goal.id)[0]?.verdict?.perCriterion[0];
      expect(criterion).toMatchObject({ pass: true, method: 'llm', evidence: '3169 of 3169 rows' });
    } finally {
      await result.dispose();
    }
  });
});
