import { KanbanStore } from '@ethosagent/kanban-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DispatchCall, Dispatcher, type SupervisorState } from '../dispatcher';

// In-memory supervisor stand-in. Production uses the real `Map<personality, MemberState>`
// from `runSupervisor`; tests build this directly.
function makeSupervisor(
  members: Record<string, { port: number; status: 'running' | 'starting' | 'failed' }>,
): SupervisorState {
  return {
    portOf: (p) => members[p]?.port ?? null,
    statusOf: (p) => members[p]?.status ?? null,
  };
}

describe('Dispatcher.tick()', () => {
  let board: KanbanStore;

  beforeEach(() => {
    board = new KanbanStore(':memory:');
  });

  afterEach(() => {
    board.close();
  });

  // ---------------------------------------------------------------------------
  // Dispatch path
  // ---------------------------------------------------------------------------

  it('claims ready tasks with running assignees and POSTs to their port', async () => {
    const sup = makeSupervisor({
      engineer: { port: 3001, status: 'running' },
      researcher: { port: 3002, status: 'running' },
    });

    const t1 = board.createTask({ title: 'fix bug', assignee: 'engineer' });
    const t2 = board.createTask({ title: 'market scan', assignee: 'researcher' });
    board.updateStatus(t1.id, 'ready');
    board.updateStatus(t2.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();

    // Both tasks claimed (open run) — status flipped to running.
    expect(board.getTask(t1.id)?.status).toBe('running');
    expect(board.getTask(t2.id)?.status).toBe('running');

    // Wait for the fire-and-forget dispatch to land before asserting calls.
    await new Promise((r) => setImmediate(r));
    expect(dispatch).toHaveBeenCalledTimes(2);
    const calls = dispatch.mock.calls.map(([args]) => ({
      port: args.port,
      personalityId: args.personalityId,
    }));
    expect(calls).toContainEqual({ port: 3001, personalityId: 'engineer' });
    expect(calls).toContainEqual({ port: 3002, personalityId: 'researcher' });
  });

  it('skips ready tasks whose assignee is not running', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'failed' } });
    const t = board.createTask({ title: 'x', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();
    expect(dispatch).not.toHaveBeenCalled();
    expect(board.getTask(t.id)?.status).toBe('ready'); // unchanged
  });

  it('skips ready tasks with no known port for the assignee', async () => {
    const sup = makeSupervisor({});
    const t = board.createTask({ title: 'x', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails a task that exhausts its retry budget on re-claim instead of dispatching it', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    // maxRetries=0: the task gets one claim, and any re-claim fails it.
    const t = board.createTask({ title: 'impossible', assignee: 'engineer', maxRetries: 0 });

    // Simulate a first run that ended badly, leaving the task ready to be re-claimed.
    board.updateStatus(t.id, 'ready');
    board.updateStatus(t.id, 'running', 'first attempt');
    board.blockRun(t.id, 'failed');
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    await dispatcher.tick();

    // The dispatcher's claim re-claimed the task past budget — updateStatus
    // landed it in 'failed', so nothing was dispatched.
    expect(board.getTask(t.id)?.status).toBe('failed');
    await new Promise((r) => setImmediate(r));
    expect(dispatch).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Promotion path — parents-done unlocks children
  // ---------------------------------------------------------------------------

  it('real-work parent gates the child until done, then the dispatcher claims it', async () => {
    const sup = makeSupervisor({
      engineer: { port: 3001, status: 'running' },
      researcher: { port: 3002, status: 'running' },
    });
    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    // Real-work parent (has an assignee) — its completion gates the child.
    const parent = board.createTask({ title: 'parent', assignee: 'researcher' });
    board.updateStatus(parent.id, 'ready');
    const child = board.createTask({
      title: 'work',
      parents: [parent.id],
      assignee: 'engineer',
    });

    // Tick #1: parent dispatches (researcher gets it), child stays in todo.
    await dispatcher.tick();
    expect(board.getTask(child.id)?.status).toBe('todo');

    // Coordinator marks the parent done out of band (simulating a completion).
    board.completeRun(parent.id, 'parent done');

    // Tick #2: promoteReady moves child to ready; then dispatch fires.
    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));
    expect(board.getTask(child.id)?.status).toBe('running');
    // dispatch fired twice: once for the parent, once for the child.
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('rolls a goal up to done once every child completes', async () => {
    const sup = makeSupervisor({});
    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    const goal = board.createTask({ title: 'Q3 roadmap' });
    const c1 = board.createTask({ title: 'a', assignee: 'engineer', parents: [goal.id] });
    const c2 = board.createTask({ title: 'b', assignee: 'researcher', parents: [goal.id] });

    // Children complete out-of-band (the dispatcher would normally do it via
    // callMeshAgent → assignee → kanban_complete, but we shortcut here).
    board.updateStatus(c1.id, 'running');
    board.completeRun(c1.id, 'done a');
    board.updateStatus(c2.id, 'running');
    board.completeRun(c2.id, 'done b');

    // One tick: promoteReady moves the goal todo→ready; rollup sees all
    // children done and finishes it. Both steps run inside the same tick.
    await dispatcher.tick();

    expect(board.getTask(goal.id)?.status).toBe('done');
  });

  it('goal-as-parent (no assignee) is transparent — child promotes immediately', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    // Goal pattern: assignee=null. Goals organize work, they don't gate it.
    // Without this rule, the coordinator's create_goal → create(parents=[goal])
    // flow deadlocks because nothing closes the goal.
    const goal = board.createTask({ title: 'Q3 roadmap' });
    const child = board.createTask({
      title: 'sub-task',
      parents: [goal.id],
      assignee: 'engineer',
    });

    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));
    expect(board.getTask(child.id)?.status).toBe('running');
    expect(dispatch).toHaveBeenCalledTimes(1);
    // The goal itself is promoted (no blockers of its own) but never dispatched:
    // `findReadyToDispatch` filters on assignee IS NOT NULL so the empty-assignee
    // goal stays in `ready` indefinitely, acting as a milestone marker.
    expect(board.getTask(goal.id)?.status).toBe('ready');
  });

  // ---------------------------------------------------------------------------
  // Reclaim path — stale heartbeat → blocked
  // ---------------------------------------------------------------------------

  it('marks a task blocked when its open run hasnt heartbeat in staleMs', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      staleMs: 100,
    });

    const t = board.createTask({ title: 'long', assignee: 'engineer' });
    board.updateStatus(t.id, 'running'); // opens a run

    // Backdate the run's heartbeat so it looks stale.
    const runId = board.getTask(t.id)?.currentRunId;
    expect(runId).toBeTruthy();
    (
      board as unknown as {
        db: { prepare: (s: string) => { run: (a: number, b: string) => void } };
      }
    ).db
      .prepare('UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ?')
      .run(Date.now() - 500, runId as string);

    await dispatcher.tick();

    expect(board.getTask(t.id)?.status).toBe('blocked');
  });

  // ---------------------------------------------------------------------------
  // Dispatch failure → blocked
  // ---------------------------------------------------------------------------

  it('marks a task blocked when the HTTP dispatch fails', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const dispatch = vi.fn<DispatchCall>(async () => {
      throw new Error('connection refused');
    });
    const errors: Array<{ msg: string; id: string }> = [];
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      onError: (err, id) => errors.push({ msg: err.message, id }),
    });

    const t = board.createTask({ title: 'x', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    await dispatcher.tick();
    // dispatcher fires-and-forgets; let the promise settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(board.getTask(t.id)?.status).toBe('blocked');
    expect(errors).toEqual([{ msg: 'connection refused', id: t.id }]);
  });

  // ---------------------------------------------------------------------------
  // Staleness in orphan adoption — stuck `running` tasks get reclaimed
  // ---------------------------------------------------------------------------

  // Backdate a task's updated_at to simulate the passage of time past the
  // staleness threshold without actually sleeping.
  function backdateUpdatedAt(taskId: string, ms: number): void {
    (
      board as unknown as {
        db: { prepare: (s: string) => { run: (a: number, b: string) => void } };
      }
    ).db
      .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
      .run(Date.now() - ms, taskId);
  }

  it('reclaims a running task whose updated_at is past the staleness threshold with reason orphan_stale', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const t = board.createTask({ title: 'stuck', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');
    board.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
    // Push updated_at well past the 1s threshold this dispatcher uses.
    backdateUpdatedAt(t.id, 5_000);

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      stalenessThresholdMs: 1_000,
    });

    await dispatcher.tick();

    const events = board.listEvents(t.id);
    const reclaim = events.find(
      (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_stale',
    );
    expect(reclaim).toBeDefined();
    // Reclaimed → ready → re-dispatched within the same tick → running again.
    expect(board.getTask(t.id)?.status).toBe('running');
    await new Promise((r) => setImmediate(r));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does NOT reclaim a running task whose updated_at is recent', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const t = board.createTask({ title: 'healthy', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');
    board.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
    // updated_at is fresh (just set by updateStatus) — not stale.

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      stalenessThresholdMs: 60_000,
    });

    await dispatcher.tick();

    const events = board.listEvents(t.id);
    const reclaim = events.find(
      (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_stale',
    );
    expect(reclaim).toBeUndefined();
    expect(board.getTask(t.id)?.status).toBe('running');
  });

  it('reclaims a running task whose assignee is no longer active with reason orphan_no_owner', async () => {
    // Assignee exists but its process has failed — supervisor.statusOf is not 'running'.
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'failed' } });
    const t = board.createTask({ title: 'abandoned', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');
    board.updateStatus(t.id, 'running', 'dispatched', 'dispatcher');
    // updated_at is fresh — this is the no-owner path, not the staleness path.

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      stalenessThresholdMs: 60_000,
    });

    await dispatcher.tick();

    const events = board.listEvents(t.id);
    const reclaim = events.find(
      (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_no_owner',
    );
    expect(reclaim).toBeDefined();
    // Owner is gone, so the same-tick dispatch can't re-claim it — stays ready.
    expect(board.getTask(t.id)?.status).toBe('ready');
    await new Promise((r) => setImmediate(r));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not reclaim a running task that is still in-flight from a prior tick', async () => {
    const sup = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const t = board.createTask({ title: 'in-flight', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    // A slow dispatch keeps the task in `inflight` across ticks.
    let release: () => void = () => {};
    const dispatch = vi.fn<DispatchCall>(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('ok');
        }),
    );
    const dispatcher = new Dispatcher({
      board,
      supervisor: sup,
      dispatch,
      stalenessThresholdMs: 1_000,
    });

    await dispatcher.tick(); // claims + dispatches; task is now inflight + running
    backdateUpdatedAt(t.id, 5_000); // make it look stale
    await dispatcher.tick(); // should NOT reclaim — still inflight

    const events = board.listEvents(t.id);
    const reclaim = events.find(
      (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_stale',
    );
    expect(reclaim).toBeUndefined();
    expect(board.getTask(t.id)?.status).toBe('running');

    release();
    await new Promise((r) => setImmediate(r));
  });
});
