// FW-13 — BackgroundRunner tests
// Tests are written first (TDD). BackgroundRunner lives in
// packages/agent-bridge/src/background-runner.ts.

import { BackgroundRunner } from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* makeEventStream(
  events: { type: string; [k: string]: unknown }[],
  opts?: { delayMs?: number },
): AsyncGenerator<unknown> {
  for (const e of events) {
    if (opts?.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    } else {
      await Promise.resolve();
    }
    yield e;
  }
}

/** Build a minimal mock AgentLoop whose run() returns a simple text response. */
function makeLoop(text = 'hello', delayMs?: number): AgentLoop {
  return {
    run: vi.fn(() =>
      makeEventStream(
        [
          { type: 'text_delta', text },
          { type: 'done', text, turnCount: 1 },
        ],
        { delayMs },
      ),
    ),
  } as unknown as AgentLoop;
}

/** A loop that never resolves (holds the task open for testing cancel/list). */
function makeNeverEndingLoop(): AgentLoop {
  return {
    run: vi.fn((_text: string, opts: { abortSignal?: AbortSignal }) => {
      return (async function* () {
        while (true) {
          if (opts.abortSignal?.aborted) {
            return;
          }
          await new Promise((r) => setTimeout(r, 10));
          yield { type: 'text_delta', text: 'thinking...' };
        }
      })();
    }),
  } as unknown as AgentLoop;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackgroundRunner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. run() returns a task object immediately
  // -------------------------------------------------------------------------

  it('run() returns a task with a unique id and status=running immediately', () => {
    const runner = new BackgroundRunner();
    const loop = makeLoop();

    const task = runner.run('hello world', loop);

    expect(task.id).toMatch(/^bg_\d+_[a-f0-9]+$/);
    expect(task.status).toBe('running');
    expect(task.prompt).toBe('hello world');
    expect(task.startedAt).toBeGreaterThan(0);
    expect(task.sessionKey).toMatch(/^bg:/);
  });

  // -------------------------------------------------------------------------
  // 2. Foreground stays responsive — second run() while first is running succeeds
  // -------------------------------------------------------------------------

  it('a second run() call while the first is running succeeds immediately (both tasks returned)', () => {
    const runner = new BackgroundRunner();
    const loop1 = makeLoop('first', 50);
    const loop2 = makeLoop('second', 50);

    const task1 = runner.run('prompt one', loop1);
    const task2 = runner.run('prompt two', loop2);

    // Both returned without waiting
    expect(task1.id).not.toBe(task2.id);
    expect(task1.status).toBe('running');
    expect(task2.status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // 3. onComplete handler fires when agent finishes
  // -------------------------------------------------------------------------

  it('onComplete fires with the completed task when the agent emits done', async () => {
    const runner = new BackgroundRunner();
    const loop = makeLoop('done text');

    const completed: import('@ethosagent/agent-bridge').BackgroundTask[] = [];
    runner.onComplete((t) => completed.push(t));

    const task = runner.run('my prompt', loop);

    // Wait for the async agent turn to finish
    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 2000 });

    expect(completed[0]?.id).toBe(task.id);
    expect(completed[0]?.status).toBe('done');
    expect(completed[0]?.result).toBe('done text');
  });

  // -------------------------------------------------------------------------
  // 4. Concurrent cap: 5th run() with 4 already running throws BACKGROUND_QUEUE_FULL
  // -------------------------------------------------------------------------

  it('throws BACKGROUND_QUEUE_FULL when maxConcurrent tasks are already running', () => {
    const runner = new BackgroundRunner({ maxConcurrent: 4 });

    // Fill up to max
    for (let i = 0; i < 4; i++) {
      runner.run(`prompt ${i}`, makeNeverEndingLoop());
    }

    // 5th should throw
    expect(() => runner.run('overflow', makeNeverEndingLoop())).toThrow('BACKGROUND_QUEUE_FULL');
  });

  it('allows up to exactly maxConcurrent tasks', () => {
    const runner = new BackgroundRunner({ maxConcurrent: 2 });

    runner.run('first', makeNeverEndingLoop());
    runner.run('second', makeNeverEndingLoop());

    expect(() => runner.run('third', makeNeverEndingLoop())).toThrow('BACKGROUND_QUEUE_FULL');
  });

  // -------------------------------------------------------------------------
  // 5. cancel(taskId) aborts a running task; task.status → 'cancelled'
  // -------------------------------------------------------------------------

  it('cancel() aborts the running task and marks it cancelled', async () => {
    const runner = new BackgroundRunner();
    const loop = makeNeverEndingLoop();

    const task = runner.run('long running', loop);
    expect(task.status).toBe('running');

    const cancelled = runner.cancel(task.id);
    expect(cancelled).toBe(true);

    // Wait for the cancellation to propagate
    await vi.waitFor(() => expect(task.status).toBe('cancelled'), { timeout: 2000 });
  });

  it('cancel() returns false for unknown task id', () => {
    const runner = new BackgroundRunner();
    expect(runner.cancel('bg_nonexistent')).toBe(false);
  });

  it('cancel() returns false for already-completed task', async () => {
    const runner = new BackgroundRunner();
    const loop = makeLoop('done');

    const completed: import('@ethosagent/agent-bridge').BackgroundTask[] = [];
    runner.onComplete((t) => completed.push(t));

    const task = runner.run('fast', loop);
    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 2000 });

    expect(runner.cancel(task.id)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. list() shows running tasks; completed tasks remain in the list
  // -------------------------------------------------------------------------

  it('list() includes running tasks', () => {
    const runner = new BackgroundRunner();
    runner.run('task a', makeNeverEndingLoop());
    runner.run('task b', makeNeverEndingLoop());

    const tasks = runner.list();
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === 'running')).toBe(true);
  });

  it('list() includes completed tasks after they finish', async () => {
    const runner = new BackgroundRunner();
    const completed: import('@ethosagent/agent-bridge').BackgroundTask[] = [];
    runner.onComplete((t) => completed.push(t));

    runner.run('quick', makeLoop('result'));

    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 2000 });

    const tasks = runner.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('done');
  });

  // -------------------------------------------------------------------------
  // getTask() — retrieval by id
  // -------------------------------------------------------------------------

  it('getTask() returns the task for a known id', () => {
    const runner = new BackgroundRunner();
    const task = runner.run('get me', makeNeverEndingLoop());

    const found = runner.getTask(task.id);
    expect(found?.id).toBe(task.id);
  });

  it('getTask() returns undefined for unknown id', () => {
    const runner = new BackgroundRunner();
    expect(runner.getTask('nope')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // onComplete cleanup fn
  // -------------------------------------------------------------------------

  it('onComplete cleanup fn prevents future handler calls', async () => {
    const runner = new BackgroundRunner();

    let count = 0;
    const cleanup = runner.onComplete(() => {
      count++;
    });

    // Remove handler before first task completes
    cleanup();

    const completed: import('@ethosagent/agent-bridge').BackgroundTask[] = [];
    runner.onComplete((t) => completed.push(t));

    runner.run('test', makeLoop('x'));

    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 2000 });

    // The cleaned-up handler should never have fired
    expect(count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // error task status
  // -------------------------------------------------------------------------

  it('task.status becomes error when the agent throws', async () => {
    const loop = {
      run: vi.fn(() => {
        throw new Error('agent explosion');
      }),
    } as unknown as AgentLoop;

    const runner = new BackgroundRunner();
    const completed: import('@ethosagent/agent-bridge').BackgroundTask[] = [];
    runner.onComplete((t) => completed.push(t));

    const task = runner.run('explode', loop);

    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 2000 });

    expect(task.status).toBe('error');
    expect(task.error).toContain('agent explosion');
  });
});
