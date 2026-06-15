import { DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent, GoalStore } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalRunner, type GoalRunnerConfig } from '../index';

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

function makeScriptedRunner(scripts: AgentEvent[][]) {
  const calls: string[] = [];
  const fn = (_sessionKey: string, firstMessage: string): AsyncGenerator<AgentEvent> => {
    const i = calls.length;
    calls.push(firstMessage);
    const events = scripts[i] ?? scripts[scripts.length - 1] ?? [];
    return (async function* () {
      for (const e of events) yield e;
    })();
  };
  return { fn: fn as GoalRunnerConfig['runAttempt'], calls };
}

const FAIL_BLOCK: AgentEvent[] = [
  { type: 'tool_start', toolCallId: 't1', toolName: 'terminal', args: {} },
  { type: 'tool_end', toolCallId: 't1', toolName: 'terminal', ok: false, durationMs: 1 },
  { type: 'tool_start', toolCallId: 't2', toolName: 'terminal', args: {} },
  { type: 'tool_end', toolCallId: 't2', toolName: 'terminal', ok: false, durationMs: 1 },
  { type: 'tool_start', toolCallId: 't3', toolName: 'terminal', args: {} },
  { type: 'tool_end', toolCallId: 't3', toolName: 'terminal', ok: false, durationMs: 1 },
  { type: 'done', text: 'partial output', turnCount: 3 },
];

describe('GoalRunner — reflect-and-recover', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  it('recovers then completes', async () => {
    const { fn, calls } = makeScriptedRunner([
      FAIL_BLOCK,
      [
        { type: 'text_delta', text: 'fixed it' },
        { type: 'done', text: 'fixed it', turnCount: 1 },
      ],
    ]);
    const hooks = new DefaultHookRegistry();
    const failedSpy = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', failedSpy);

    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });

    const runner = new GoalRunner({ store, hooks, runAttempt: fn });
    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(store.get(goal.id)?.status).toBe('completed');
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('stuck in a loop');

    const events = store.getEvents(goal.id);
    const recoveryMarkers = events.filter(
      (e) => e.eventType === 'turn_text' && String(e.payload.text ?? '').includes('↻ Recovering'),
    );
    expect(recoveryMarkers.length).toBeGreaterThanOrEqual(1);

    await new Promise((r) => setTimeout(r, 10));
    expect(failedSpy).not.toHaveBeenCalled();
  });

  it('fails after recovery is exhausted', async () => {
    const { fn, calls } = makeScriptedRunner([FAIL_BLOCK]);
    const hooks = new DefaultHookRegistry();
    const failedSpy = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', failedSpy);

    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      maxRecoveryAttempts: 2,
    });

    const runner = new GoalRunner({ store, hooks, runAttempt: fn });
    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('failed');
    expect(calls.length).toBe(3);
    expect(final?.errorText).toMatch(/stuck|couldn't recover/i);

    const events = store.getEvents(goal.id);
    const recoveryMarkers = events.filter(
      (e) => e.eventType === 'turn_text' && String(e.payload.text ?? '').includes('↻ Recovering'),
    );
    expect(recoveryMarkers.length).toBe(2);

    await new Promise((r) => setTimeout(r, 10));
    expect(failedSpy).toHaveBeenCalledWith(expect.objectContaining({ goalId: goal.id }));
  });

  it('dangerous mode bypasses recovery and completes', async () => {
    const { fn, calls } = makeScriptedRunner([FAIL_BLOCK]);
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

    const runner = new GoalRunner({ store, hooks, runAttempt: fn });
    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(calls.length).toBe(1);
    expect(store.get(goal.id)?.status).toBe('completed');

    const events = store.getEvents(goal.id);
    const recoveryMarkers = events.filter(
      (e) => e.eventType === 'turn_text' && String(e.payload.text ?? '').includes('↻ Recovering'),
    );
    expect(recoveryMarkers.length).toBe(0);

    await new Promise((r) => setTimeout(r, 10));
    expect(failedSpy).not.toHaveBeenCalled();
  });
});
