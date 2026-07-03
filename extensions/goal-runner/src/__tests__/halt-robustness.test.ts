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

const BUDGET_HALT_BLOCK: AgentEvent[] = [
  { type: 'text_delta', text: 'working...' },
  {
    type: 'halt',
    kind: 'budget',
    rule: 'tool-budget',
    toolName: '_budget',
    count: 50,
    message: 'Stopped: hit 50-tool-call budget for this turn',
  },
  { type: 'done', text: 'truncated output', turnCount: 1 },
];

const WATCHER_HALT_BLOCK: AgentEvent[] = [
  {
    type: 'halt',
    kind: 'watcher',
    rule: 'compounding-error',
    message: 'terminal failed 3 times in a row',
  },
  { type: 'done', text: 'truncated output', turnCount: 1 },
];

describe('GoalRunner — structured halt events', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  function makeGoal(extra?: { allowDangerousToolCalls?: boolean; maxRecoveryAttempts?: number }) {
    return store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      ...extra,
    });
  }

  it('recovers from a budget halt with a budget-tailored reflection', async () => {
    const { fn, calls } = makeScriptedRunner([
      BUDGET_HALT_BLOCK,
      [{ type: 'done', text: 'finished cleanly', turnCount: 1 }],
    ]);
    const goal = makeGoal();
    const runner = new GoalRunner({ store, runAttempt: fn });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('tool-call budget');
    expect(calls[1]).toContain('Work more efficiently');
    expect(store.get(goal.id)?.outputMd).toBe('finished cleanly');

    const events = store.getEvents(goal.id);
    const markers = events.filter(
      (e) => e.eventType === 'turn_text' && String(e.payload.text ?? '').includes('↻ Recovering'),
    );
    expect(markers.length).toBe(1);
  });

  it('fails (never completes) when budget-halt recoveries are exhausted', async () => {
    const { fn, calls } = makeScriptedRunner([BUDGET_HALT_BLOCK]);
    const hooks = new DefaultHookRegistry();
    const completedSpy = vi.fn(async () => {});
    const failedSpy = vi.fn(async () => {});
    hooks.registerVoid('goal_completed', completedSpy);
    hooks.registerVoid('goal_failed', failedSpy);

    const goal = makeGoal({ maxRecoveryAttempts: 2 });
    const runner = new GoalRunner({ store, hooks, runAttempt: fn });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('failed');
    expect(final?.errorText).toMatch(/couldn't recover.*tool-call budgets/i);
    expect(calls.length).toBe(3);

    await new Promise((r) => setTimeout(r, 10));
    expect(completedSpy).not.toHaveBeenCalled();
    expect(failedSpy).toHaveBeenCalledWith(expect.objectContaining({ goalId: goal.id }));
  });

  it('recovers from a watcher halt with the stuck-in-a-loop reflection', async () => {
    const { fn, calls } = makeScriptedRunner([
      WATCHER_HALT_BLOCK,
      [{ type: 'done', text: 'fixed it', turnCount: 1 }],
    ]);
    const goal = makeGoal();
    const runner = new GoalRunner({ store, runAttempt: fn });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('stuck in a loop');
    expect(calls[1]).toContain('terminal failed 3 times in a row');
  });

  it('budget halts still recover in dangerous mode', async () => {
    const { fn, calls } = makeScriptedRunner([
      BUDGET_HALT_BLOCK,
      [{ type: 'done', text: 'finished cleanly', turnCount: 1 }],
    ]);
    const goal = makeGoal({ allowDangerousToolCalls: true });
    const runner = new GoalRunner({ store, runAttempt: fn });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('tool-call budget');
  });

  it('watcher halts do NOT trigger recovery in dangerous mode', async () => {
    const { fn, calls } = makeScriptedRunner([WATCHER_HALT_BLOCK]);
    const goal = makeGoal({ allowDangerousToolCalls: true });
    const runner = new GoalRunner({ store, runAttempt: fn });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(calls.length).toBe(1);
    const events = store.getEvents(goal.id);
    const markers = events.filter(
      (e) => e.eventType === 'turn_text' && String(e.payload.text ?? '').includes('↻ Recovering'),
    );
    expect(markers.length).toBe(0);
  });

  it('threads the tool_end error into the failure-streak reflection', async () => {
    const { fn, calls } = makeScriptedRunner([
      [
        { type: 'tool_start', toolCallId: 't1', toolName: 'terminal', args: {} },
        {
          type: 'tool_end',
          toolCallId: 't1',
          toolName: 'terminal',
          ok: false,
          durationMs: 1,
          error: 'boom',
        },
        { type: 'tool_start', toolCallId: 't2', toolName: 'terminal', args: {} },
        {
          type: 'tool_end',
          toolCallId: 't2',
          toolName: 'terminal',
          ok: false,
          durationMs: 1,
          error: 'boom',
        },
        { type: 'tool_start', toolCallId: 't3', toolName: 'terminal', args: {} },
        {
          type: 'tool_end',
          toolCallId: 't3',
          toolName: 'terminal',
          ok: false,
          durationMs: 1,
          error: 'boom',
        },
        { type: 'done', text: 'partial', turnCount: 3 },
      ],
      [{ type: 'done', text: 'recovered', turnCount: 1 }],
    ]);
    const goal = makeGoal();
    const runner = new GoalRunner({ store, runAttempt: fn });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('stuck in a loop');
    expect(calls[1]).toContain('boom');
  });
});

describe('GoalRunner — transient error retry', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  function makeGoal() {
    return store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });
  }

  it('retries the same attempt on a transient error and succeeds', async () => {
    const sleeps: number[] = [];
    const sessionKeys: string[] = [];
    const calls: string[] = [];
    const scripts: AgentEvent[][] = [
      [
        { type: 'text_delta', text: 'partial ' },
        { type: 'error', error: 'Rate limit exceeded (429)', code: 'llm_error' },
      ],
      [{ type: 'done', text: 'finished after retry', turnCount: 1 }],
    ];
    const fn = (sessionKey: string, firstMessage: string): AsyncGenerator<AgentEvent> => {
      const i = calls.length;
      calls.push(firstMessage);
      sessionKeys.push(sessionKey);
      const events = scripts[i] ?? [];
      return (async function* () {
        for (const e of events) yield e;
      })();
    };
    const goal = makeGoal();
    const runner = new GoalRunner({
      store,
      runAttempt: fn as GoalRunnerConfig['runAttempt'],
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    const start = Date.now();
    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    // Injectable sleep — the 2s backoff was recorded but not actually waited.
    expect(sleeps).toEqual([2000]);
    expect(Date.now() - start).toBeLessThan(1500);

    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('failed transiently');
    expect(calls[1]).toContain('Rate limit exceeded (429)');
    // Same attempt: identical session key, exactly one attempt row.
    expect(sessionKeys[1]).toBe(sessionKeys[0]);
    expect(store.getAttempts(goal.id)).toHaveLength(1);
    expect(store.get(goal.id)?.outputMd).toBe('finished after retry');
  });

  it('fails terminally once transient retries are exhausted', async () => {
    const sleeps: number[] = [];
    const { fn, calls } = makeScriptedRunner([
      [{ type: 'error', error: 'upstream 503 overloaded', code: 'llm_error' }],
    ]);
    const goal = makeGoal();
    const runner = new GoalRunner({
      store,
      runAttempt: fn,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    // 1 initial call + 3 retries, backoff schedule respected.
    expect(calls.length).toBe(4);
    expect(sleeps).toEqual([2000, 8000, 20000]);
    expect(store.get(goal.id)?.errorText).toContain('503');
  });

  it('does not retry non-transient errors', async () => {
    const { fn, calls } = makeScriptedRunner([
      [{ type: 'error', error: 'boom', code: 'execution_failed' }],
    ]);
    const goal = makeGoal();
    const runner = new GoalRunner({ store, runAttempt: fn });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    expect(calls.length).toBe(1);
    expect(store.get(goal.id)?.errorText).toBe('boom');
  });

  it('does not retry watcher terminations even when the message looks transient', async () => {
    const { fn, calls } = makeScriptedRunner([
      [{ type: 'error', error: 'Watcher: request timeout storm', code: 'watcher_kill-switch' }],
    ]);
    const goal = makeGoal();
    const runner = new GoalRunner({ store, runAttempt: fn });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    expect(calls.length).toBe(1);
  });
});

describe('GoalRunner — steer window + double-start guard', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  it('accepts a steer during judging and lands it in the next attempt first message', async () => {
    const hooks = new DefaultHookRegistry();
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    hooks.registerClaiming('before_goal_complete', async () => {
      await gate;
      return { handled: true, reason: 'needs work' };
    });

    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
      maxAttempts: 3,
    });
    const { fn, calls } = makeScriptedRunner([
      [
        {
          type: 'tool_start',
          toolCallId: 't1',
          toolName: 'goal_complete',
          args: { summary: 'sum' },
        },
        { type: 'tool_end', toolCallId: 't1', toolName: 'goal_complete', ok: true, durationMs: 1 },
        { type: 'done', text: 'attempt one', turnCount: 1 },
      ],
      [{ type: 'done', text: 'attempt two', turnCount: 1 }],
    ]);
    const runner = new GoalRunner({ store, hooks, runAttempt: fn });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'judging');

    const accepted = runner.steer(goal.id, 'focus on X');
    expect(accepted).toBe(true);

    resolveGate?.();
    await waitForStatus(store, goal.id, 'completed');

    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('[USER STEER] focus on X');
  });

  it('second startGoal while a run is active is a no-op', async () => {
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'Test goal',
      goalText: 'Do the thing',
    });
    let invocations = 0;
    const runner = new GoalRunner({
      store,
      runAttempt: async function* (
        _sk: string,
        _fm: string,
        opts: { abortSignal: AbortSignal },
      ): AsyncGenerator<AgentEvent> {
        invocations++;
        yield { type: 'text_delta', text: 'x' };
        await new Promise<void>((resolve) => {
          if (opts.abortSignal.aborted) return resolve();
          opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });

    await runner.startGoal(goal.id);
    await new Promise((r) => setTimeout(r, 20));
    await runner.startGoal(goal.id);
    await new Promise((r) => setTimeout(r, 20));

    expect(invocations).toBe(1);
    runner.cancel(goal.id);
  });
});
