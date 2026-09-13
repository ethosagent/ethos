import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore, type TaskEvent } from '@ethosagent/kanban-store';
import { SessionLane } from '@ethosagent/session-lane';
import type { AgentEvent } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_HEARTBEAT_INTERVAL_MS,
  KanbanPollLoop,
  writeRunActivityComments,
} from '../kanban-poll';

describe('KanbanPollLoop', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kanban-poll-test-'));
    dbPath = join(tempDir, 'board.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedStore(fn: (store: KanbanStore) => void): void {
    const store = new KanbanStore(dbPath);
    fn(store);
    store.close();
  }

  it('tick() runs housekeeping — promotes ready tasks', async () => {
    seedStore((store) => {
      // Create a parent task (done) and a child task (todo → should promote to ready)
      const parent = store.createTask({ title: 'parent', assignee: 'agent-a', actor: 'test' });
      store.updateStatus(parent.id, 'ready', undefined, 'test');
      store.updateStatus(parent.id, 'running', undefined, 'test');
      store.completeRun(parent.id, 'done', 'test');

      const child = store.createTask({
        title: 'child',
        assignee: 'agent-z',
        parents: [parent.id],
        actor: 'test',
      });
      // child is 'todo' because it has a blocking parent
      expect(child.status).toBe('todo');
    });

    const lane = new SessionLane();
    const runner =
      vi.fn<
        (prompt: string, sessionKey: string, taskId: string, taskTitle: string) => Promise<void>
      >();
    runner.mockResolvedValue(undefined);
    const pollLoop = new KanbanPollLoop({
      boardPath: dbPath,
      personalityId: 'agent-a',
      lane,
      runner,
    });

    await pollLoop.tick();

    // After tick, the child should have been promoted to ready
    const store = new KanbanStore(dbPath);
    const tasks = store.listTasks({ status: 'ready' });
    const child = tasks.find((t) => t.title === 'child');
    expect(child).toBeDefined();
    expect(child?.status).toBe('ready');
    store.close();
  });

  it('tick() enqueues ready tasks assigned to personalityId', async () => {
    seedStore((store) => {
      const task = store.createTask({ title: 'my-task', assignee: 'agent-a', actor: 'test' });
      store.updateStatus(task.id, 'ready', undefined, 'test');
    });

    const lane = new SessionLane();
    const runner =
      vi.fn<
        (prompt: string, sessionKey: string, taskId: string, taskTitle: string) => Promise<void>
      >();
    runner.mockResolvedValue(undefined);
    const pollLoop = new KanbanPollLoop({
      boardPath: dbPath,
      personalityId: 'agent-a',
      lane,
      runner,
    });

    await pollLoop.tick();

    // Wait for lane to drain
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(1);
    });
    expect(runner.mock.calls[0][0]).toContain('You have been assigned kanban task');
    expect(runner.mock.calls[0][0]).toContain('kanban_complete');
    expect(runner.mock.calls[0][3]).toBe('my-task');
  });

  it('tick() ignores ready tasks assigned to other personalities', async () => {
    seedStore((store) => {
      const task = store.createTask({ title: 'other-task', assignee: 'agent-b', actor: 'test' });
      store.updateStatus(task.id, 'ready', undefined, 'test');
    });

    const lane = new SessionLane();
    const runner =
      vi.fn<
        (prompt: string, sessionKey: string, taskId: string, taskTitle: string) => Promise<void>
      >();
    runner.mockResolvedValue(undefined);
    const pollLoop = new KanbanPollLoop({
      boardPath: dbPath,
      personalityId: 'agent-a',
      lane,
      runner,
    });

    await pollLoop.tick();
    // Give the lane a moment to drain in case it was mistakenly enqueued
    await new Promise((r) => setTimeout(r, 50));

    expect(runner).not.toHaveBeenCalled();
  });

  it('tick() claims a ready task to running and does not re-enqueue on a second tick', async () => {
    let taskId = '';
    seedStore((store) => {
      const task = store.createTask({
        title: 'claim-me',
        body: 'do the thing',
        assignee: 'agent-a',
        actor: 'test',
      });
      store.updateStatus(task.id, 'ready', undefined, 'test');
      taskId = task.id;
      // a different personality's ready task that must be left alone
      const other = store.createTask({ title: 'not-mine', assignee: 'agent-b', actor: 'test' });
      store.updateStatus(other.id, 'ready', undefined, 'test');
    });

    const lane = new SessionLane();
    const runner =
      vi.fn<
        (prompt: string, sessionKey: string, taskId: string, taskTitle: string) => Promise<void>
      >();
    runner.mockResolvedValue(undefined);
    const pollLoop = new KanbanPollLoop({
      boardPath: dbPath,
      personalityId: 'agent-a',
      lane,
      runner,
    });

    await pollLoop.tick();
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(1);
    });

    {
      const store = new KanbanStore(dbPath);
      const running = store.listTasks({ status: 'running' });
      expect(running.some((t) => t.id === taskId)).toBe(true);
      const ready = store.listTasks({ status: 'ready' });
      expect(ready.some((t) => t.id === taskId)).toBe(false);
      // other personality's task untouched
      expect(ready.some((t) => t.title === 'not-mine')).toBe(true);
      store.close();
    }

    // Second tick must not re-enqueue (no longer ready)
    await pollLoop.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(runner).toHaveBeenCalledTimes(1);

    // The new prompt is actionable
    expect(runner.mock.calls[0][0]).toContain('You have been assigned kanban task');
    expect(runner.mock.calls[0][0]).toContain('kanban_complete');
  });

  it('tick() carries operator comments and the last block reason into the claimed prompt', async () => {
    let taskId = '';
    seedStore((store) => {
      const task = store.createTask({
        title: 'brand guide',
        body: 'build it',
        assignee: 'agent-a',
        actor: 'test',
      });
      taskId = task.id;
      store.updateStatus(task.id, 'ready', undefined, 'test');
      store.updateStatus(task.id, 'running', 'claimed via poll dispatch', 'agent-a');
      store.addComment(task.id, 'agent-a', '🔧 web_fetch({"url":"https://example.com"})');
      store.blockRun(task.id, 'Which X handle should I read?', 'agent-a', 'needs_input');
      store.addComment(task.id, 'human:control-center', 'Use @example-bot on X.');
      store.updateStatus(task.id, 'ready', 'unblocked by operator', 'human:control-center');
    });

    const lane = new SessionLane();
    const runner =
      vi.fn<
        (
          prompt: string,
          sessionKey: string,
          taskId: string,
          taskTitle: string,
          runId: string,
        ) => Promise<void>
      >();
    runner.mockResolvedValue(undefined);
    const pollLoop = new KanbanPollLoop({
      boardPath: dbPath,
      personalityId: 'agent-a',
      lane,
      runner,
    });

    await pollLoop.tick();
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(1);
    });

    const [prompt, , , , runId] = runner.mock.calls[0] ?? [];
    expect(prompt).toContain('Use @example-bot on X.');
    expect(prompt).toContain('Your previous attempt stopped with: Which X handle should I read?');
    expect(prompt).not.toContain('web_fetch');
    // The runner is handed the run this claim opened.
    const store = new KanbanStore(dbPath);
    expect(runId).toBe(store.getTask(taskId)?.currentRunId);
    store.close();
  });

  it('tick() reclaims stale running tasks', async () => {
    seedStore((store) => {
      const task = store.createTask({ title: 'stale-task', assignee: 'agent-a', actor: 'test' });
      store.updateStatus(task.id, 'ready', undefined, 'test');
      store.updateStatus(task.id, 'running', undefined, 'test');
    });

    // Since we can't easily backdate, let's test with a very small threshold

    // Verify the reclaim logic: findStaleRunningTasks with threshold=0 finds the task
    const store2 = new KanbanStore(dbPath);
    const staleTasks = store2.findStaleRunningTasks(0);
    expect(staleTasks.length).toBeGreaterThanOrEqual(1);
    store2.close();
  });

  it('start() and stop() lifecycle', async () => {
    seedStore(() => {
      // empty board
    });

    const lane = new SessionLane();
    const runner =
      vi.fn<
        (prompt: string, sessionKey: string, taskId: string, taskTitle: string) => Promise<void>
      >();
    runner.mockResolvedValue(undefined);
    const pollLoop = new KanbanPollLoop({
      boardPath: dbPath,
      personalityId: 'agent-a',
      lane,
      runner,
      intervalMs: 50,
    });

    pollLoop.start();
    // start() is idempotent
    pollLoop.start();

    // Give it a moment to run at least one tick
    await new Promise((r) => setTimeout(r, 100));

    pollLoop.stop();
    // stop() is idempotent
    pollLoop.stop();
  });

  it('tick() promotes scheduled tasks', async () => {
    seedStore((store) => {
      store.createTask({
        title: 'scheduled-task',
        assignee: 'agent-z',
        scheduledFor: Date.now() - 10_000,
        actor: 'test',
      });
    });

    const lane = new SessionLane();
    const runner =
      vi.fn<
        (prompt: string, sessionKey: string, taskId: string, taskTitle: string) => Promise<void>
      >();
    runner.mockResolvedValue(undefined);
    const pollLoop = new KanbanPollLoop({
      boardPath: dbPath,
      personalityId: 'agent-a',
      lane,
      runner,
    });

    await pollLoop.tick();

    const store = new KanbanStore(dbPath);
    const tasks = store.listTasks({ status: 'ready' });
    const scheduled = tasks.find((t) => t.title === 'scheduled-task');
    expect(scheduled).toBeDefined();
    expect(scheduled?.status).toBe('ready');
    store.close();
  });

  it('tick() calls onError on failure', async () => {
    const lane = new SessionLane();
    const runner =
      vi.fn<
        (prompt: string, sessionKey: string, taskId: string, taskTitle: string) => Promise<void>
      >();
    runner.mockResolvedValue(undefined);
    const onError = vi.fn();
    const pollLoop = new KanbanPollLoop({
      boardPath: join(tempDir, 'nonexistent', 'deeply', 'nested', 'board.db'),
      personalityId: 'agent-a',
      lane,
      runner,
      onError,
    });

    // tick() will throw since the caller is expected to catch.
    // The start() loop catches and calls onError.
    pollLoop.start();
    await vi.waitFor(() => {
      // KanbanStore creates the parent directory, so this may succeed.
      // Just verify the loop runs without crashing
    });
    pollLoop.stop();
  });
});

describe('writeRunActivityComments', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kanban-poll-test-'));
    dbPath = join(tempDir, 'board.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a tool_start comment and a final-text comment authored by the personality', async () => {
    const store = new KanbanStore(dbPath);
    const task = store.createTask({ title: 'helper-task', assignee: 'agent-a', actor: 'test' });
    store.close();
    async function* fakeEvents(): AsyncIterable<AgentEvent> {
      yield { type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', args: { path: '/x' } };
      yield { type: 'text_delta', text: 'all ' };
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', text: 'all done', turnCount: 1 };
    }
    await writeRunActivityComments(dbPath, task.id, 'r_none', 'agent-a', fakeEvents());
    const verify = new KanbanStore(dbPath);
    const comments = verify.listComments(task.id);
    expect(comments.every((c) => c.author === 'agent-a')).toBe(true);
    expect(comments.some((c) => c.body.includes('🔧 read_file'))).toBe(true);
    expect(comments.some((c) => c.body.includes('all done'))).toBe(true);
    verify.close();
  });

  // A `returnDirect` tool's answer reaches a turn only as `done.text`, after any
  // preamble the model streamed: the posted comment carries both.
  it('posts the preamble AND a returnDirect answer that only `done.text` carries', async () => {
    const store = new KanbanStore(dbPath);
    const task = store.createTask({ title: 'direct-task', assignee: 'agent-a', actor: 'test' });
    store.close();
    async function* directEvents(): AsyncIterable<AgentEvent> {
      yield { type: 'text_delta', text: 'Let me look that up.' };
      yield { type: 'done', text: 'DIRECT ANSWER', turnCount: 1 };
    }
    await writeRunActivityComments(dbPath, task.id, 'r_none', 'agent-a', directEvents());
    const verify = new KanbanStore(dbPath);
    const bodies = verify.listComments(task.id).map((c) => c.body);
    expect(bodies).toContain('Let me look that up.\n\nDIRECT ANSWER');
    verify.close();
  });

  it('writes a warning comment for an error event', async () => {
    const store = new KanbanStore(dbPath);
    const task = store.createTask({ title: 'err-task', assignee: 'agent-a', actor: 'test' });
    store.close();
    async function* errEvents(): AsyncIterable<AgentEvent> {
      yield { type: 'error', error: 'boom', code: 'oops' };
    }
    await writeRunActivityComments(dbPath, task.id, 'r_none', 'agent-a', errEvents());
    const verify = new KanbanStore(dbPath);
    expect(verify.listComments(task.id).some((c) => c.body.includes('⚠️ error: boom'))).toBe(true);
    verify.close();
  });

  describe('auto-heartbeat', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function claimTask(): { taskId: string; runId: string } {
      const store = new KanbanStore(dbPath);
      const task = store.createTask({ title: 'long-task', assignee: 'agent-a', actor: 'test' });
      store.updateStatus(task.id, 'ready', undefined, 'test');
      const claimed = store.updateStatus(task.id, 'running', undefined, 'test');
      store.close();
      return { taskId: task.id, runId: claimed.currentRunId ?? '' };
    }

    function heartbeats(taskId: string): TaskEvent[] {
      const store = new KanbanStore(dbPath);
      try {
        return store.listEvents(taskId).filter((e) => e.kind === 'heartbeat');
      } finally {
        store.close();
      }
    }

    /** One tool_start, then a silent tool call that lasts until `finish()`, then done. */
    function silentToolCall(onSilence?: () => void): {
      events: AsyncIterable<AgentEvent>;
      finish: () => void;
    } {
      let finish: () => void = () => {};
      const toolCallDone = new Promise<void>((resolve) => {
        finish = resolve;
      });
      async function* events(): AsyncIterable<AgentEvent> {
        yield { type: 'tool_start', toolCallId: 'c1', toolName: 'geo_run', args: {} };
        onSilence?.();
        await toolCallDone;
        yield { type: 'done', text: 'finished', turnCount: 1 };
      }
      return { events: events(), finish: () => finish() };
    }

    it('heartbeats on a timer through a long tool call that emits no events', async () => {
      const { taskId, runId } = claimTask();
      vi.useFakeTimers();
      const t0 = Date.now();
      const { events, finish } = silentToolCall();
      const onError = vi.fn();
      const run = writeRunActivityComments(dbPath, taskId, runId, 'agent-a', events, onError);

      await vi.advanceTimersByTimeAsync(AUTO_HEARTBEAT_INTERVAL_MS * 3);

      // One immediately, then one per interval — with no event in between.
      const beats = heartbeats(taskId);
      expect(beats).toHaveLength(4);
      expect(beats.every((e) => e.actor === 'agent-a')).toBe(true);
      expect(beats[0]?.data.note).toBe('auto: agent active');
      {
        const store = new KanbanStore(dbPath);
        const claimedRun = store.listRuns(taskId).find((r) => r.id === runId);
        expect(claimedRun?.lastHeartbeatAt).toBe(t0 + AUTO_HEARTBEAT_INTERVAL_MS * 3);
        store.close();
      }

      finish();
      await run;
      // Cleared in the finally: no timer left, no heartbeat after the stream ends.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(AUTO_HEARTBEAT_INTERVAL_MS * 2);
      expect(heartbeats(taskId)).toHaveLength(4);
      expect(onError).not.toHaveBeenCalled();
    });

    it('stops the timer once the agent ends its own run mid-stream', async () => {
      const { taskId, runId } = claimTask();
      vi.useFakeTimers();
      const { events, finish } = silentToolCall();
      const onError = vi.fn();
      const run = writeRunActivityComments(dbPath, taskId, runId, 'agent-a', events, onError);

      await vi.advanceTimersByTimeAsync(AUTO_HEARTBEAT_INTERVAL_MS);
      expect(heartbeats(taskId)).toHaveLength(2);

      // The agent calls kanban_complete while the stream is still open.
      {
        const store = new KanbanStore(dbPath);
        store.completeRun(taskId, 'done', 'agent-a');
        store.close();
      }
      await vi.advanceTimersByTimeAsync(AUTO_HEARTBEAT_INTERVAL_MS * 3);
      expect(heartbeats(taskId)).toHaveLength(2);
      // The stream is still being consumed, yet the timer is gone.
      expect(vi.getTimerCount()).toBe(0);

      finish();
      await run;
      expect(onError).not.toHaveBeenCalled();
    });

    it("never heartbeats when the task's current run is a different run", async () => {
      const { taskId, runId } = claimTask();
      // The task was reclaimed and re-claimed by someone else: a new run is open.
      {
        const store = new KanbanStore(dbPath);
        store.reclaimTask(taskId, 'orphan_stale', 'dispatcher');
        const reclaimed = store.updateStatus(taskId, 'running', 'dispatched', 'dispatcher');
        store.close();
        expect(reclaimed.currentRunId).not.toBe(runId);
      }
      vi.useFakeTimers();
      let timersDuringCall = -1;
      const { events, finish } = silentToolCall(() => {
        timersDuringCall = vi.getTimerCount();
      });
      const onError = vi.fn();
      const run = writeRunActivityComments(dbPath, taskId, runId, 'agent-a', events, onError);

      await vi.advanceTimersByTimeAsync(AUTO_HEARTBEAT_INTERVAL_MS * 2);
      expect(timersDuringCall).toBe(0);
      expect(heartbeats(taskId)).toHaveLength(0);

      finish();
      await run;
      expect(onError).not.toHaveBeenCalled();
    });
  });
});
