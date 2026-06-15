import { DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { AcceptanceSpec, AgentEvent, GoalStore, SteerSink } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalRunner } from '../index';

/** Build an async generator that yields the given events in order. */
function fakeRunAttempt(events: AgentEvent[]) {
  return async function* (): AsyncGenerator<AgentEvent> {
    for (const event of events) yield event;
  };
}

function scriptedRunAttempt(perAttempt: AgentEvent[][]) {
  let call = 0;
  return async function* (): AsyncGenerator<AgentEvent> {
    const events = perAttempt[call] ?? perAttempt[perAttempt.length - 1] ?? [];
    call++;
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

function makeGoal(store: GoalStore, opts?: { withCriteria?: boolean }) {
  return store.create({
    userId: 'user-1',
    personalityId: 'tester',
    origin: 'cli',
    title: 'Test goal',
    goalText: 'Do the thing',
    ...(opts?.withCriteria
      ? {
          acceptanceCriteria: {
            checks: [{ id: 'c1', description: 'It compiles' }],
            rubric: [{ id: 'r1', description: 'It is good', weight: 1 }],
            threshold: 0.8,
          },
        }
      : {}),
  });
}

function makeGoalWithSpec(store: GoalStore, spec: AcceptanceSpec, maxAttempts?: number) {
  return store.create({
    userId: 'user-1',
    personalityId: 'tester',
    origin: 'cli',
    title: 'Test goal',
    goalText: 'Do the thing',
    acceptanceCriteria: spec,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  });
}

describe('GoalRunner phase a — single-attempt execution', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  it('completes one attempt and coalesces text deltas into a single turn_text', async () => {
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      runAttempt: fakeRunAttempt([
        { type: 'text_delta', text: 'hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'done', text: 'final output', turnCount: 2 },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('completed');
    expect(final?.outputMd).toBe('final output');
    expect(final?.turnCount).toBe(2);

    const events = store.getEvents(goal.id);
    const turnTexts = events.filter((e) => e.eventType === 'turn_text');
    expect(turnTexts).toHaveLength(1);
    expect(turnTexts[0]?.payload.text).toBe('hello world');
    expect(events.some((e) => e.eventType === 'done')).toBe(true);
  });

  it('persists tool count, cost, and tool/usage events', async () => {
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      runAttempt: fakeRunAttempt([
        { type: 'tool_start', toolCallId: 't1', toolName: 'read_file', args: {} },
        { type: 'tool_end', toolCallId: 't1', toolName: 'read_file', ok: true, durationMs: 12 },
        { type: 'usage', inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.25 },
        { type: 'done', text: 'done', turnCount: 1 },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    const final = store.get(goal.id);
    expect(final?.toolCount).toBe(1);
    expect(final?.costUsd).toBeCloseTo(0.25);
    expect(final?.tokenCount).toBe(150);

    const types = store.getEvents(goal.id).map((e) => e.eventType);
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
    expect(types).toContain('usage');
  });

  it('gates tool_progress by audience', async () => {
    const internalGoal = makeGoal(store);
    const internalRunner = new GoalRunner({
      store,
      runAttempt: fakeRunAttempt([
        {
          type: 'tool_progress',
          toolName: 'bash',
          message: 'internal noise',
          audience: 'internal',
        },
        { type: 'done', text: 'ok', turnCount: 1 },
      ]),
    });
    await internalRunner.startGoal(internalGoal.id);
    await waitForStatus(store, internalGoal.id, 'completed');
    expect(store.getEvents(internalGoal.id).some((e) => e.eventType === 'turn_text')).toBe(false);

    const userGoal = makeGoal(store);
    const userRunner = new GoalRunner({
      store,
      runAttempt: fakeRunAttempt([
        { type: 'tool_progress', toolName: 'bash', message: 'visible step', audience: 'user' },
        { type: 'done', text: 'ok', turnCount: 1 },
      ]),
    });
    await userRunner.startGoal(userGoal.id);
    await waitForStatus(store, userGoal.id, 'completed');
    const turnTexts = store.getEvents(userGoal.id).filter((e) => e.eventType === 'turn_text');
    expect(turnTexts).toHaveLength(1);
    expect(turnTexts[0]?.payload.text).toBe('visible step');
  });

  it('marks the goal failed on an error event (no done)', async () => {
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      runAttempt: fakeRunAttempt([
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: 'boom', code: 'execution_failed' },
        { type: 'done', text: 'should be ignored', turnCount: 9 },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('failed');
    expect(final?.errorText).toBe('boom');

    const types = store.getEvents(goal.id).map((e) => e.eventType);
    expect(types).toContain('error');
    expect(types).not.toContain('done');
  });
});

describe('GoalRunner phase b — convergence/retry loop', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  const checkOnlySpec: AcceptanceSpec = {
    checks: [{ id: 'c1', description: 'DONE-MARKER' }],
    rubric: [],
    threshold: 0,
  };

  it('retries until the output satisfies the check, then completes', async () => {
    const goal = makeGoalWithSpec(store, checkOnlySpec);
    const runner = new GoalRunner({
      store,
      runAttempt: scriptedRunAttempt([
        [
          { type: 'text_delta', text: 'no marker here' },
          { type: 'done', text: 'no marker here', turnCount: 1 },
        ],
        [{ type: 'done', text: 'now DONE-MARKER present', turnCount: 1 }],
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('completed');
    expect(final?.outputMd).toContain('DONE-MARKER');

    const attempts = store.getAttempts(goal.id);
    expect(attempts).toHaveLength(2);

    // No duplicate attempt rows for any n (guards the duplicate-insert bug).
    const ns = attempts.map((a) => a.n);
    expect(new Set(ns).size).toBe(ns.length);

    // Both attempt rows have verdicts persisted via updateAttempt.
    expect(attempts.every((a) => a.verdict !== null)).toBe(true);

    // Attempt 2 has the conventional session key.
    const attempt2 = attempts.find((a) => a.n === 2);
    expect(attempt2?.sessionKey).toBe(`goal:${goal.id}:attempt-2`);

    const events = store.getEvents(goal.id);
    expect(events.some((e) => e.eventType === 'run_start')).toBe(true);
    const attemptStart = events.find((e) => e.eventType === 'attempt_start');
    expect(attemptStart).toBeDefined();
    expect(attemptStart?.payload.attemptN).toBe(2);
  });

  it('exhausts after maxAttempts when the output never satisfies the check', async () => {
    const goal = makeGoalWithSpec(store, checkOnlySpec, 2);
    const runner = new GoalRunner({
      store,
      runAttempt: scriptedRunAttempt([[{ type: 'done', text: 'still no marker', turnCount: 1 }]]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'exhausted');

    const final = store.get(goal.id);
    expect(final?.status).toBe('exhausted');
    // Exactly maxAttempts rows — the maxAttempts branch fires at n=2 before the
    // no-progress guard, so exactly 2 rows with no duplicates.
    const attempts = store.getAttempts(goal.id);
    expect(attempts).toHaveLength(2);
    const ns = attempts.map((a) => a.n);
    expect(new Set(ns).size).toBe(ns.length);
  });

  it('completes a no-criteria goal immediately with exactly one attempt row', async () => {
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      runAttempt: scriptedRunAttempt([[{ type: 'done', text: 'output', turnCount: 1 }]]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    const attempts = store.getAttempts(goal.id);
    expect(attempts).toHaveLength(1);
    expect(store.get(goal.id)?.status).toBe('completed');
  });
});

describe('GoalRunner phase c — multi-attempt event completeness', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  const checkOnlySpec: AcceptanceSpec = {
    checks: [{ id: 'c1', description: 'DONE-MARKER' }],
    rubric: [],
    threshold: 0,
  };

  // Guards SSE/journey-graph replay coherence for multi-attempt runs: the SSE route
  // replays goal_events in seq order, so a consumer (e.g. ExecutionGraph) must see a
  // coherent ordered trace — attempt-1 work, then rejection, then the attempt-2 boundary,
  // then done. No attempt_start before complete_rejected; no done before attempt_start.
  it('persists a coherent ordered multi-attempt event trace', async () => {
    const goal = makeGoalWithSpec(store, checkOnlySpec);
    const runner = new GoalRunner({
      store,
      runAttempt: scriptedRunAttempt([
        [
          { type: 'tool_start', toolCallId: 't1', toolName: 'read_file', args: {} },
          { type: 'tool_end', toolCallId: 't1', toolName: 'read_file', ok: true, durationMs: 12 },
          { type: 'text_delta', text: 'no marker here' },
          { type: 'done', text: 'no marker here', turnCount: 1 },
        ],
        [{ type: 'done', text: 'now DONE-MARKER present', turnCount: 1 }],
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    const events = store.getEvents(goal.id);
    const types = events.map((e) => e.eventType);

    // First event is run_start; last is done.
    expect(types[0]).toBe('run_start');
    expect(types[types.length - 1]).toBe('done');

    // Exactly one run_start and one attempt_start (attempt 1 = run_start, attempt 2 = attempt_start).
    expect(types.filter((t) => t === 'run_start')).toHaveLength(1);
    expect(types.filter((t) => t === 'attempt_start')).toHaveLength(1);

    // The rejection of attempt 1 precedes the start of attempt 2.
    const rejectedIdx = types.indexOf('complete_rejected');
    const attemptStartIdx = types.indexOf('attempt_start');
    const doneIdx = types.indexOf('done');
    expect(rejectedIdx).toBeGreaterThanOrEqual(0);
    expect(attemptStartIdx).toBeGreaterThan(rejectedIdx);
    expect(doneIdx).toBeGreaterThan(attemptStartIdx);

    // Attempt-1 tool events are interleaved between run_start and the rejection.
    const toolStartIdx = types.indexOf('tool_start');
    const toolEndIdx = types.indexOf('tool_end');
    expect(toolStartIdx).toBeGreaterThan(0);
    expect(toolStartIdx).toBeLessThan(rejectedIdx);
    expect(toolEndIdx).toBeGreaterThan(toolStartIdx);
    expect(toolEndIdx).toBeLessThan(rejectedIdx);

    // The attempt_start payload identifies attempt 2 with the conventional session key.
    const attemptStart = events.find((e) => e.eventType === 'attempt_start');
    expect(attemptStart?.payload.attemptN).toBe(2);
    expect(attemptStart?.payload.sessionKey).toBe(`goal:${goal.id}:attempt-2`);
  });
});

describe('GoalRunner phase d — lifecycle', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  /** Resolves once the signal aborts (or immediately if already aborted). */
  function waitForAbort(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  it('saves the accumulated partial output when cancelled mid-run', async () => {
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      runAttempt: async function* (
        _sk: string,
        _fm: string,
        opts: { abortSignal: AbortSignal },
      ): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'partial ' };
        yield { type: 'text_delta', text: 'work' };
        await waitForAbort(opts.abortSignal);
      },
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'running');
    // Let the two text_deltas land before cancelling.
    await new Promise((r) => setTimeout(r, 20));

    runner.cancel(goal.id);

    const final = store.get(goal.id);
    expect(final?.status).toBe('cancelled');
    expect(final?.outputPartial).toContain('partial work');
  });

  it('pushes a mid-run steer into the live sink and records a steer event', async () => {
    const goal = makeGoal(store);
    let capturedSink: SteerSink | undefined;
    const runner = new GoalRunner({
      store,
      runAttempt: async function* (
        _sk: string,
        _fm: string,
        opts: { abortSignal: AbortSignal; steerSink?: SteerSink },
      ): AsyncGenerator<AgentEvent> {
        capturedSink = opts.steerSink;
        yield { type: 'text_delta', text: 'x' };
        await waitForAbort(opts.abortSignal);
      },
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'running');
    // Let the sink get captured before steering.
    await new Promise((r) => setTimeout(r, 20));

    const steered = runner.steer(goal.id, 'do X');
    expect(steered).toBe(true);
    expect(capturedSink).toBeDefined();
    const drained = capturedSink?.drain() ?? [];
    expect(drained.some((s) => s.includes('do X') && s.includes('[USER STEER]'))).toBe(true);

    const events = store.getEvents(goal.id);
    expect(events.some((e) => e.eventType === 'steer' && e.payload.message === 'do X')).toBe(true);

    // Clean up the in-flight generator.
    runner.cancel(goal.id);
  });

  it('resumes the latest attempt in place without creating a new attempt row', async () => {
    const goal = makeGoal(store);
    // Seed attempt rows n=1 and n=2 directly so we control the attempt history.
    store.saveAttempt({
      goalId: goal.id,
      n: 1,
      sessionKey: `goal:${goal.id}:attempt-1`,
      outputMd: 'a1',
      artifacts: null,
      verdict: null,
      strategyUsed: 'first',
      costUsd: null,
      traceId: null,
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    store.saveAttempt({
      goalId: goal.id,
      n: 2,
      sessionKey: `goal:${goal.id}:attempt-2`,
      outputMd: null,
      artifacts: null,
      verdict: null,
      strategyUsed: 'first',
      costUsd: null,
      traceId: null,
      startedAt: Date.now(),
      completedAt: null,
    });
    store.updateStatus(goal.id, 'interrupted');

    let usedSessionKey: string | undefined;
    const runner = new GoalRunner({
      store,
      runAttempt: async function* (sk: string): AsyncGenerator<AgentEvent> {
        usedSessionKey = sk;
        yield { type: 'done', text: 'resumed output', turnCount: 1 };
      },
    });

    await runner.resume(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    // Re-entered the SAME latest attempt's session key — not attempt-1 or attempt-3.
    expect(usedSessionKey).toBe(`goal:${goal.id}:attempt-2`);

    const attempts = store.getAttempts(goal.id);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((a) => a.n))).toEqual(new Set([1, 2]));

    expect(store.get(goal.id)?.resumeCount).toBe(1);
  });
});

describe('GoalRunner phase e — ceilings, failure, completion gate', () => {
  let store: SQLiteGoalStore;

  beforeEach(() => {
    store = new SQLiteGoalStore(':memory:');
  });

  function waitForAbort(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  it('interrupts the run when the cost budget ceiling is exceeded', async () => {
    const goal = store.create({
      userId: 'user-1',
      personalityId: 'tester',
      origin: 'cli',
      title: 'T',
      goalText: 'do',
      maxCostUsd: 0.1,
    });
    const runner = new GoalRunner({
      store,
      runAttempt: async function* (
        _sk: string,
        _fm: string,
        opts: { abortSignal: AbortSignal },
      ): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'partial' };
        yield { type: 'usage', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.06 };
        yield { type: 'usage', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.06 };
        await waitForAbort(opts.abortSignal);
      },
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'interrupted');

    const final = store.get(goal.id);
    expect(final?.status).toBe('interrupted');
    expect(final?.outputPartial).toContain('partial');
    expect(final?.errorText).toMatch(/limit/i);

    const events = store.getEvents(goal.id);
    expect(
      events.some((e) => e.eventType === 'error' && e.payload.code === 'budget_exceeded'),
    ).toBe(true);
  });

  it('interrupts the run when the max-turns safety valve trips', async () => {
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      maxTurnsSafetyValve: 2,
      runAttempt: fakeRunAttempt([{ type: 'done', text: 'capped', turnCount: 5 }]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'interrupted');

    const final = store.get(goal.id);
    expect(final?.status).toBe('interrupted');
    expect(final?.status).not.toBe('completed');
    expect(final?.outputMd).not.toBe('capped');
    expect(final?.errorText).toMatch(/limit/i);
  });

  it('fires goal_failed on an error event', async () => {
    const goal = makeGoal(store);
    const hooks = new DefaultHookRegistry();
    const spy = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', spy);
    const runner = new GoalRunner({
      store,
      hooks,
      runAttempt: fakeRunAttempt([
        { type: 'text_delta', text: 'work' },
        { type: 'error', error: 'boom', code: 'execution_failed' },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('failed');
    expect(final?.errorText).toBe('boom');
    expect(final?.outputPartial).toContain('work');

    await new Promise((r) => setTimeout(r, 10));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ goalId: goal.id }));
  });

  it('fires goal_failed when the generator throws', async () => {
    const goal = makeGoal(store);
    const hooks = new DefaultHookRegistry();
    const spy = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', spy);
    const runner = new GoalRunner({
      store,
      hooks,
      // biome-ignore lint/correctness/useYield: generator throws before it can yield
      runAttempt: async function* (): AsyncGenerator<AgentEvent> {
        throw new Error('kaboom');
      },
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('failed');
    expect(final?.errorText).toBe('kaboom');

    await new Promise((r) => setTimeout(r, 10));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: goal.id, errorText: 'kaboom' }),
    );
  });

  it('rejects completion via before_goal_complete and exhausts at maxAttempts', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming('before_goal_complete', async () => ({
      handled: true,
      reason: 'needs work',
    }));
    const goal = makeGoalWithSpec(
      store,
      { checks: [{ id: 'c1', description: 'X' }], rubric: [], threshold: 0 },
      1,
    );
    const runner = new GoalRunner({
      store,
      hooks,
      runAttempt: fakeRunAttempt([
        {
          type: 'tool_start',
          toolCallId: 't1',
          toolName: 'goal_complete',
          args: { summary: 'sum', output_md: 'out' },
        },
        { type: 'tool_end', toolCallId: 't1', toolName: 'goal_complete', ok: true, durationMs: 1 },
        { type: 'done', text: 'out', turnCount: 1 },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'exhausted');

    const final = store.get(goal.id);
    expect(final?.status).toBe('exhausted');
    expect(final?.status).not.toBe('completed');

    const events = store.getEvents(goal.id);
    expect(
      events.some((e) => e.eventType === 'complete_rejected' && e.payload.reason === 'needs work'),
    ).toBe(true);
  });

  it('completes when no before_goal_complete handler is registered', async () => {
    const hooks = new DefaultHookRegistry();
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      hooks,
      runAttempt: fakeRunAttempt([
        {
          type: 'tool_start',
          toolCallId: 't1',
          toolName: 'goal_complete',
          args: { summary: 'sum', output_md: 'out' },
        },
        { type: 'tool_end', toolCallId: 't1', toolName: 'goal_complete', ok: true, durationMs: 1 },
        { type: 'done', text: 'out', turnCount: 1 },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    expect(store.get(goal.id)?.status).toBe('completed');
  });

  it('injects an autonomy directive into the goal session system prompt', async () => {
    const goal = makeGoal(store);
    const hooks = new DefaultHookRegistry();
    let captured: string | undefined;
    const runAttempt = async function* (
      sessionKey: string,
      _firstMessage: string,
      _opts: { abortSignal: AbortSignal; steerSink?: SteerSink },
    ): AsyncGenerator<AgentEvent> {
      const res = await hooks.fireModifying('before_prompt_build', {
        sessionId: sessionKey,
        history: [],
      });
      captured = res.prependSystem;
      yield { type: 'done', text: 'ok', turnCount: 1 };
    };
    const runner = new GoalRunner({ store, hooks, runAttempt });
    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');
    expect(captured).toBeDefined();
    expect(captured).toContain('Do NOT ask');
    expect(captured).toContain('autonomous goal run');
  });

  it('fails after recovery is exhausted on a compounding tool failure', async () => {
    const hooks = new DefaultHookRegistry();
    const failedSpy = vi.fn(async () => {});
    const completedSpy = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', failedSpy);
    hooks.registerVoid('goal_completed', completedSpy);
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      hooks,
      // Three consecutive failures from the same tool, then a watcher-style done.
      runAttempt: fakeRunAttempt([
        { type: 'tool_start', toolCallId: 't1', toolName: 'terminal', args: {} },
        { type: 'tool_end', toolCallId: 't1', toolName: 'terminal', ok: false, durationMs: 1 },
        { type: 'tool_start', toolCallId: 't2', toolName: 'terminal', args: {} },
        { type: 'tool_end', toolCallId: 't2', toolName: 'terminal', ok: false, durationMs: 1 },
        { type: 'tool_start', toolCallId: 't3', toolName: 'terminal', args: {} },
        { type: 'tool_end', toolCallId: 't3', toolName: 'terminal', ok: false, durationMs: 1 },
        { type: 'done', text: 'partial output', turnCount: 3 },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'failed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('failed');
    expect(final?.status).not.toBe('completed');
    expect(final?.errorText).toMatch(/stuck|couldn't recover/i);
    expect(final?.outputPartial).toContain('partial output');

    await new Promise((r) => setTimeout(r, 10));
    expect(failedSpy).toHaveBeenCalledWith(expect.objectContaining({ goalId: goal.id }));
    // The judge never completed the run.
    expect(completedSpy).not.toHaveBeenCalled();
  });

  it('does NOT mark failed when a success breaks the failure streak (control)', async () => {
    const hooks = new DefaultHookRegistry();
    const failedSpy = vi.fn(async () => {});
    hooks.registerVoid('goal_failed', failedSpy);
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      hooks,
      // Two failures, then a success resets the streak — normal completion.
      runAttempt: fakeRunAttempt([
        { type: 'tool_start', toolCallId: 't1', toolName: 'terminal', args: {} },
        { type: 'tool_end', toolCallId: 't1', toolName: 'terminal', ok: false, durationMs: 1 },
        { type: 'tool_start', toolCallId: 't2', toolName: 'terminal', args: {} },
        { type: 'tool_end', toolCallId: 't2', toolName: 'terminal', ok: false, durationMs: 1 },
        { type: 'tool_start', toolCallId: 't3', toolName: 'terminal', args: {} },
        { type: 'tool_end', toolCallId: 't3', toolName: 'terminal', ok: true, durationMs: 1 },
        { type: 'done', text: 'all good', turnCount: 3 },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    const final = store.get(goal.id);
    expect(final?.status).toBe('completed');
    expect(final?.outputMd).toBe('all good');

    await new Promise((r) => setTimeout(r, 10));
    expect(failedSpy).not.toHaveBeenCalled();
  });

  it('threads the goal_complete summary into goal_completed', async () => {
    const hooks = new DefaultHookRegistry();
    const spy = vi.fn(async () => {});
    hooks.registerVoid('goal_completed', spy);
    const goal = makeGoal(store);
    const runner = new GoalRunner({
      store,
      hooks,
      runAttempt: fakeRunAttempt([
        {
          type: 'tool_start',
          toolCallId: 't1',
          toolName: 'goal_complete',
          args: { summary: 'THE SUMMARY', output_md: 'x' },
        },
        { type: 'tool_end', toolCallId: 't1', toolName: 'goal_complete', ok: true, durationMs: 1 },
        { type: 'done', text: 'x', turnCount: 1 },
      ]),
    });

    await runner.startGoal(goal.id);
    await waitForStatus(store, goal.id, 'completed');

    await new Promise((r) => setTimeout(r, 10));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ summary: 'THE SUMMARY' }));
  });
});
