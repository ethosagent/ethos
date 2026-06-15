import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoalsService } from '../goals.service';

describe('GoalsService.toolResult', () => {
  let tmp: string;
  let goalStore: SQLiteGoalStore;
  let sessionStore: SQLiteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'goals-tool-result-'));
    goalStore = new SQLiteGoalStore(join(tmp, 'goals.db'));
    sessionStore = new SQLiteSessionStore(join(tmp, 'sessions.db'));
  });

  afterEach(() => {
    sessionStore.close();
    goalStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns found:false when sessionStore absent', async () => {
    const service = new GoalsService({ dataDir: tmp, store: goalStore });
    const res = await service.toolResult('g1', 'tc1');
    expect(res).toEqual({ found: false });
  });

  it('returns found:false when toolCallId not located', async () => {
    const service = new GoalsService({ dataDir: tmp, store: goalStore, sessionStore });
    const res = await service.toolResult('g1', 'tc1');
    expect(res.found).toBe(false);
  });

  it('finds the tool_result output (and input) by toolCallId', async () => {
    const service = new GoalsService({ dataDir: tmp, store: goalStore, sessionStore });

    const goal = goalStore.create({
      userId: 'u',
      personalityId: 'p',
      origin: 'web',
      title: 't',
      goalText: 'do thing',
    });

    const sessionKey = `goal:${goal.id}:attempt-1`;
    goalStore.saveAttempt({
      goalId: goal.id,
      n: 1,
      sessionKey,
      outputMd: null,
      artifacts: null,
      verdict: null,
      strategyUsed: 'first',
      costUsd: null,
      traceId: null,
      startedAt: Date.now(),
      completedAt: null,
    });

    const session = await sessionStore.createSession({
      key: sessionKey,
      platform: 'goal',
      model: 'm',
      provider: 'p',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });

    await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc-42', name: 'read_file', input: { path: '/etc/hosts' } }],
    });

    await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'tool_result',
      content: 'FILE CONTENTS HERE',
      toolCallId: 'tc-42',
      toolName: 'read_file',
    });

    const res = await service.toolResult(goal.id, 'tc-42');

    expect(res.found).toBe(true);
    expect(res.output).toBe('FILE CONTENTS HERE');
    expect(res.toolName).toBe('read_file');
    expect(res.input).toContain('/etc/hosts');
  });
});
