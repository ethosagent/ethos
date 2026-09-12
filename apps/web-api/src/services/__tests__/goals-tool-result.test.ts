import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { RETURNED_DIRECT_TOOL_RESULT } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type GoalsBackend, GoalsService } from '../goals.service';
import { InMemoryGoalStore, recordingExecutor } from './in-memory-goals';

describe('GoalsService.toolResult', () => {
  let tmp: string;
  let goalStore: InMemoryGoalStore;
  let goals: GoalsBackend;
  let sessionStore: SQLiteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'goals-tool-result-'));
    goalStore = new InMemoryGoalStore();
    goals = { store: goalStore, executor: recordingExecutor({ canExecute: true }) };
    sessionStore = new SQLiteSessionStore(join(tmp, 'sessions.db'));
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns found:false when sessionStore absent', async () => {
    const service = new GoalsService({ goals });
    const res = await service.toolResult('g1', 'tc1');
    expect(res).toEqual({ found: false });
  });

  it('returns found:false when toolCallId not located', async () => {
    const service = new GoalsService({ goals, sessionStore });
    const res = await service.toolResult('g1', 'tc1');
    expect(res.found).toBe(false);
  });

  it('finds the tool_result output (and input) by toolCallId', async () => {
    const service = new GoalsService({ goals, sessionStore });

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

  // A returnDirect call's value is persisted once, as the assistant row after
  // its tool_result; the tool_result row holds only a marker saying so.
  it('a returnDirect call reports the answer row, not the marker', async () => {
    const service = new GoalsService({ goals, sessionStore });
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
      toolCalls: [{ id: 'tc-7', name: 'lookup', input: { q: 'x' } }],
    });
    await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'tool_result',
      content: RETURNED_DIRECT_TOOL_RESULT,
      toolCallId: 'tc-7',
      toolName: 'lookup',
    });
    await sessionStore.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'THE DIRECT ANSWER',
    });

    const res = await service.toolResult(goal.id, 'tc-7');

    expect(res.found).toBe(true);
    expect(res.output).toBe('THE DIRECT ANSWER');
    expect(res.toolName).toBe('lookup');
  });
});
