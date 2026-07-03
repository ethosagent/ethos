import { DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AgentEvent, GoalStore } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { GoalRunner } from '../index';

/** Async generator yielding the given events in order. */
function fakeGen(events: AgentEvent[]) {
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
    if (store.get(id)?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for goal ${id} to reach status "${status}"`);
}

function makeGoal(store: GoalStore) {
  return store.create({
    userId: 'user-1',
    personalityId: 'tester',
    origin: 'cli',
    title: 'Test goal',
    goalText: 'Do the thing',
  });
}

describe('GoalRunner planning phase', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  it('(a) plans first: run_start → plan_start → plan_ready, then runs attempt 1 with the plan', async () => {
    const goal = makeGoal(store);
    let attemptFirstMessage: string | undefined;
    const runner = new GoalRunner({
      store,
      runPlan: fakeGen([
        { type: 'text_delta', text: 'STEP 1: investigate. STEP 2: act.' },
        { type: 'done', text: 'STEP 1: investigate. STEP 2: act.', turnCount: 1 },
      ]),
      runAttempt: async function* (_sk: string, firstMessage: string): AsyncGenerator<AgentEvent> {
        attemptFirstMessage = firstMessage;
        yield { type: 'done', text: 'final output', turnCount: 1 };
      },
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    // Plan persisted onto the goal.
    const final = store.get(goal.id);
    expect(final?.planMd).toBe('STEP 1: investigate. STEP 2: act.');

    // Event ordering: run_start → plan_start → plan_ready, all before execution.
    const types = store.getEvents(goal.id).map((e) => e.eventType);
    expect(types[0]).toBe('run_start');
    expect(types[1]).toBe('plan_start');
    expect(types[2]).toBe('plan_ready');
    expect(types.filter((t) => t === 'run_start')).toHaveLength(1);

    const events = store.getEvents(goal.id);
    const planStart = events.find((e) => e.eventType === 'plan_start');
    expect(planStart?.payload.sessionKey).toBe(`goal:${goal.id}:plan`);
    const planReady = events.find((e) => e.eventType === 'plan_ready');
    expect(planReady?.payload.summary).toContain('STEP 1');

    // The plan is injected into the attempt's first message.
    expect(attemptFirstMessage).toContain('## Plan');
    expect(attemptFirstMessage).toContain('STEP 1: investigate. STEP 2: act.');
  });

  it('(b) planning error → goal failed, attempt NEVER runs', async () => {
    const goal = makeGoal(store);
    let attemptCalled = false;
    const runner = new GoalRunner({
      store,
      runPlan: fakeGen([{ type: 'error', error: 'model exploded', code: 'execution_failed' }]),
      runAttempt: async function* (): AsyncGenerator<AgentEvent> {
        attemptCalled = true;
        yield { type: 'done', text: 'should not run', turnCount: 1 };
      },
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('failed');
    expect(final?.errorText).toMatch(/Planning failed: model exploded/);
    expect(final?.planMd).toBeNull();
    expect(attemptCalled).toBe(false);

    const types = store.getEvents(goal.id).map((e) => e.eventType);
    expect(types).not.toContain('plan_ready');
    expect(types).not.toContain('done');
  });

  it('(c) planning produces no plan → goal failed', async () => {
    const goal = makeGoal(store);
    let attemptCalled = false;
    const runner = new GoalRunner({
      store,
      runPlan: fakeGen([{ type: 'done', text: '   ', turnCount: 1 }]),
      runAttempt: async function* (): AsyncGenerator<AgentEvent> {
        attemptCalled = true;
        yield { type: 'done', text: 'should not run', turnCount: 1 };
      },
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('failed');
    expect(final?.errorText).toMatch(/Planning produced no plan/);
    expect(attemptCalled).toBe(false);
  });

  it('(d) without runPlan: no planning, run_start once, attempt runs (behavior preserved)', async () => {
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      runAttempt: fakeGen([{ type: 'done', text: 'final output', turnCount: 1 }]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    const types = store.getEvents(goal.id).map((e) => e.eventType);
    expect(types[0]).toBe('run_start');
    expect(types.filter((t) => t === 'run_start')).toHaveLength(1);
    expect(types).not.toContain('plan_start');
    expect(types).not.toContain('plan_ready');
    expect(store.get(goal.id)?.status).toBe('completed');
    expect(store.get(goal.id)?.planMd).toBeNull();
  });

  it('(e) resume of an already-ran goal does not re-plan', async () => {
    const goal = makeGoal(store);
    // Seed a prior attempt so resume re-enters the loop directly (already ran).
    store.saveAttempt({
      goalId: goal.id,
      n: 1,
      sessionKey: `goal:${goal.id}:attempt-1`,
      outputMd: 'prior partial',
      artifacts: null,
      verdict: null,
      strategyUsed: 'first',
      costUsd: null,
      traceId: null,
      startedAt: Date.now(),
      completedAt: null,
    });
    store.updateStatus(goal.id, 'interrupted');

    let planCalled = false;
    const runner = new GoalRunner({
      store,
      hooks: new DefaultHookRegistry(),
      runPlan: async function* (): AsyncGenerator<AgentEvent> {
        planCalled = true;
        yield { type: 'done', text: 'plan', turnCount: 1 };
      },
      runAttempt: fakeGen([{ type: 'done', text: 'resumed output', turnCount: 1 }]),
    });

    await runner.resume(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(planCalled).toBe(false);
    const types = store.getEvents(goal.id).map((e) => e.eventType);
    expect(types).not.toContain('plan_start');
    expect(types).not.toContain('plan_ready');
  });
});
