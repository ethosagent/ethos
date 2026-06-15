import { DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent, GoalStore } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalRunner, type GoalRunnerConfig } from '../index';

/** Build an async generator that yields the given events in order. */
function fakeRunAttempt(events: AgentEvent[]) {
  return async function* (): AsyncGenerator<AgentEvent> {
    for (const event of events) yield event;
  };
}

async function waitForStatus(
  store: GoalStore,
  id: string,
  status: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const goal = store.get(id);
    if (goal?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for goal ${id} to reach status "${status}"`);
}

describe('GoalRunner — allowDangerousToolCalls', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  it('skips the compounding-failure rule and completes when dangerous mode is on', async () => {
    const hooks = new DefaultHookRegistry();
    const failedSpy = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', failedSpy);

    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      allowDangerousToolCalls: true,
    });

    const runner = new GoalRunner({
      store,
      hooks,
      // Three consecutive failures from the same tool, then a done — without the
      // dangerous flag this would be marked failed by the compounding rule.
      runAttempt: fakeRunAttempt([
        { type: 'tool_start', toolCallId: 't1', toolName: 'terminal', args: {} },
        { type: 'tool_end', toolCallId: 't1', toolName: 'terminal', ok: false, durationMs: 1 },
        { type: 'tool_start', toolCallId: 't2', toolName: 'terminal', args: {} },
        { type: 'tool_end', toolCallId: 't2', toolName: 'terminal', ok: false, durationMs: 1 },
        { type: 'tool_start', toolCallId: 't3', toolName: 'terminal', args: {} },
        { type: 'tool_end', toolCallId: 't3', toolName: 'terminal', ok: false, durationMs: 1 },
        { type: 'done', text: 'output', turnCount: 3 },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    const final = store.get(goal.id);
    // No acceptanceCriteria → the judge auto-completes.
    expect(final?.status).toBe('completed');

    await new Promise((r) => setTimeout(r, 10));
    expect(failedSpy).not.toHaveBeenCalled();
  });

  it('threads the goal allowDangerousToolCalls into runAttempt opts', async () => {
    let capturedOpts: { allowDangerousToolCalls?: boolean } | undefined;
    const capturingRunAttempt = (
      _sessionKey: string,
      _firstMessage: string,
      opts: { allowDangerousToolCalls?: boolean },
    ): AsyncGenerator<AgentEvent> => {
      capturedOpts = opts;
      return (async function* () {
        yield { type: 'done', text: 'done', turnCount: 1 } as AgentEvent;
      })();
    };

    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      allowDangerousToolCalls: true,
    });

    const runner = new GoalRunner({
      store,
      runAttempt: capturingRunAttempt as GoalRunnerConfig['runAttempt'],
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(capturedOpts?.allowDangerousToolCalls).toBe(true);
  });
});
