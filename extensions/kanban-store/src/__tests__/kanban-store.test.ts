import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanStore } from '../index';

function makeStore() {
  return new KanbanStore(':memory:');
}

describe('KanbanStore', () => {
  let store: KanbanStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  it('opens an in-memory database and applies the schema', () => {
    // If migrations run cleanly, the store is usable. We probe by counting tasks.
    const tasks = store.listTasks();
    expect(tasks).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // createTask + getTask
  // ---------------------------------------------------------------------------

  it('creates a task with required fields and retrieves it by id', () => {
    const task = store.createTask({ title: 'fix the bug' });

    expect(task.id).toMatch(/^t_[0-9a-f]{16}$/);
    expect(task.title).toBe('fix the bug');
    expect(task.body).toBe('');
    expect(task.status).toBe('todo');
    expect(task.priority).toBe(0);
    expect(task.workspaceMode).toBe('scratch');
    expect(task.assignee).toBeNull();

    const found = store.getTask(task.id);
    expect(found?.id).toBe(task.id);
    expect(found?.title).toBe('fix the bug');
  });

  it('returns null for an unknown task id', () => {
    expect(store.getTask('t_nope')).toBeNull();
  });

  it('persists optional fields when supplied', () => {
    const task = store.createTask({
      title: 'refactor hasher',
      body: 'argon2id, parameter tuning',
      assignee: 'engineer',
      priority: 2,
      workspaceMode: 'worktree',
    });

    const found = store.getTask(task.id);
    expect(found?.body).toBe('argon2id, parameter tuning');
    expect(found?.assignee).toBe('engineer');
    expect(found?.priority).toBe(2);
    expect(found?.workspaceMode).toBe('worktree');
  });

  it('createTask is idempotent on idempotencyKey — same key returns the existing task', () => {
    const first = store.createTask({ title: 'one', idempotencyKey: 'caller-123' });
    const second = store.createTask({ title: 'one', idempotencyKey: 'caller-123' });

    expect(second.id).toBe(first.id);
    expect(store.listTasks()).toHaveLength(1);
  });

  it('createTask with null/undefined idempotencyKey always creates a new task', () => {
    store.createTask({ title: 'a' });
    store.createTask({ title: 'b' });
    expect(store.listTasks()).toHaveLength(2);
  });

  it('createTask with parents inserts task_links rows', () => {
    const parent = store.createTask({ title: 'parent' });
    const child = store.createTask({ title: 'child', parents: [parent.id] });

    const children = store.listTasks({ parentId: parent.id });
    expect(children).toHaveLength(1);
    expect(children[0]?.id).toBe(child.id);
  });

  // ---------------------------------------------------------------------------
  // listTasks filters
  // ---------------------------------------------------------------------------

  it('listTasks filters by status', () => {
    store.createTask({ title: 'a' }); // todo
    const b = store.createTask({ title: 'b' });
    store.updateStatus(b.id, 'done', 'done quickly');

    const todos = store.listTasks({ status: 'todo' });
    expect(todos).toHaveLength(1);
    expect(todos[0]?.title).toBe('a');
  });

  it('listTasks filters by assignee (null vs string)', () => {
    store.createTask({ title: 'unassigned' });
    store.createTask({ title: 'mine', assignee: 'engineer' });

    expect(store.listTasks({ assignee: 'engineer' })).toHaveLength(1);
    expect(store.listTasks({ assignee: 'engineer' })[0]?.title).toBe('mine');
  });

  it('listTasks honours limit', () => {
    for (let i = 0; i < 5; i++) store.createTask({ title: `t${i}` });
    expect(store.listTasks({ limit: 2 })).toHaveLength(2);
  });

  it('listTasks q filter does FTS5 phrase/token match over title+body+comments and ANDs with other filters', () => {
    const want = store.createTask({ title: 'rotate keys', body: 'kms rotation overdue' });
    const unrelated = store.createTask({ title: 'unrelated stuff' });
    const otherAssignee = store.createTask({ title: 'rotate certs', assignee: 'sre' });

    const hits = store.listTasks({ q: 'rotate' });
    const ids = hits.map((t) => t.id);
    expect(ids).toContain(want.id);
    expect(ids).toContain(otherAssignee.id);
    expect(ids).not.toContain(unrelated.id);

    // q AND assignee
    const sreHits = store.listTasks({ q: 'rotate', assignee: 'sre' });
    expect(sreHits.map((t) => t.id)).toEqual([otherAssignee.id]);
  });

  // ---------------------------------------------------------------------------
  // Run lifecycle
  // ---------------------------------------------------------------------------

  it('updateStatus(_, running) opens a task_run and sets current_run_id', () => {
    const task = store.createTask({ title: 'work' });
    const updated = store.updateStatus(task.id, 'running');

    expect(updated.status).toBe('running');
    expect(updated.currentRunId).toMatch(/^r_[0-9a-f]{16}$/);

    const runs = store.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(updated.currentRunId);
    expect(runs[0]?.endedAt).toBeNull();
  });

  it('updateStatus does not open a second run if one is already open', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    store.updateStatus(task.id, 'running'); // no-op for run creation
    expect(store.listRuns(task.id)).toHaveLength(1);
  });

  it('completeRun ends the current run with outcome=completed + summary and sets status=done', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const done = store.completeRun(task.id, 'shipped argon2id');

    expect(done.status).toBe('done');
    expect(done.currentRunId).toBeNull();

    const runs = store.listRuns(task.id);
    expect(runs[0]?.outcome).toBe('completed');
    expect(runs[0]?.summary).toBe('shipped argon2id');
    expect(runs[0]?.endedAt).not.toBeNull();
  });

  it('blockRun ends the current run with outcome=blocked + reason as comment and sets status=blocked', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const blocked = store.blockRun(task.id, 'waiting on infra');

    expect(blocked.status).toBe('blocked');
    expect(blocked.currentRunId).toBeNull();

    const runs = store.listRuns(task.id);
    expect(runs[0]?.outcome).toBe('blocked');
    expect(runs[0]?.endedAt).not.toBeNull();
  });

  it('heartbeatRun bumps last_heartbeat_at on the current run', async () => {
    const task = store.createTask({ title: 'long' });
    store.updateStatus(task.id, 'running');
    const before = store.listRuns(task.id)[0]?.lastHeartbeatAt ?? 0;

    await new Promise((r) => setTimeout(r, 5));
    store.heartbeatRun(task.id);

    const after = store.listRuns(task.id)[0]?.lastHeartbeatAt ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('completeRun on a task with no open run throws — does not corrupt audit trail', () => {
    const task = store.createTask({ title: 't' });
    expect(() => store.completeRun(task.id, 'wat')).toThrowError(/no open run/i);

    // Status unchanged, no spurious run_completed event
    expect(store.getTask(task.id)?.status).toBe('todo');
    const kinds = store.listEvents(task.id).map((e) => e.kind);
    expect(kinds).not.toContain('run_completed');
  });

  it('blockRun on a task with no open run throws', () => {
    const task = store.createTask({ title: 't' });
    expect(() => store.blockRun(task.id, 'wat')).toThrowError(/no open run/i);
    expect(store.getTask(task.id)?.status).toBe('todo');
  });

  it('heartbeatRun on a task with no open run throws and does not emit a heartbeat event', () => {
    const task = store.createTask({ title: 't' });
    expect(() => store.heartbeatRun(task.id)).toThrowError(/no open run/i);
    const kinds = store.listEvents(task.id).map((e) => e.kind);
    expect(kinds).not.toContain('heartbeat');
  });

  it('updateStatus transitioning out of running auto-cancels the open run (avoids divergent state)', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const updated = store.updateStatus(task.id, 'done'); // bypassing completeRun

    expect(updated.status).toBe('done');
    expect(updated.currentRunId).toBeNull();
    const run = store.listRuns(task.id)[0];
    expect(run?.endedAt).not.toBeNull();
    expect(run?.outcome).toBe('cancelled');
  });

  it('archive on a running task also closes the open run', () => {
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'running');
    const archived = store.archive(task.id);

    expect(archived.status).toBe('archived');
    expect(archived.currentRunId).toBeNull();
    expect(store.listRuns(task.id)[0]?.outcome).toBe('cancelled');
  });

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  it('addComment appends a comment and lists them in order', () => {
    const task = store.createTask({ title: 't' });
    store.addComment(task.id, 'engineer', 'first');
    store.addComment(task.id, 'engineer', 'second');

    const comments = store.listComments(task.id);
    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toBe('first');
    expect(comments[1]?.body).toBe('second');
    expect(comments[0]?.id).toMatch(/^c_[0-9a-f]{16}$/);
  });

  // ---------------------------------------------------------------------------
  // Assign / archive / unblock
  // ---------------------------------------------------------------------------

  it('assign sets the assignee and persists', () => {
    const task = store.createTask({ title: 't' });
    const updated = store.assign(task.id, 'reviewer');
    expect(updated.assignee).toBe('reviewer');
    expect(store.getTask(task.id)?.assignee).toBe('reviewer');
  });

  it('archive sets status=archived', () => {
    const task = store.createTask({ title: 't' });
    const archived = store.archive(task.id);
    expect(archived.status).toBe('archived');
  });

  // ---------------------------------------------------------------------------
  // Link + cycle prevention
  // ---------------------------------------------------------------------------

  it('link creates a parent/child edge that listTasks({parentId}) can find', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    store.link(a.id, b.id);

    const children = store.listTasks({ parentId: a.id });
    expect(children.map((t) => t.id)).toEqual([b.id]);
  });

  it('link throws "not found" for an unknown parent_id', () => {
    const a = store.createTask({ title: 'a' });
    expect(() => store.link('t_nonexistent_____', a.id)).toThrowError(/not found/i);
  });

  it('link throws "not found" for an unknown child_id', () => {
    const a = store.createTask({ title: 'a' });
    expect(() => store.link(a.id, 't_nonexistent_____')).toThrowError(/not found/i);
  });

  it('link is idempotent: linking the same edge twice does not emit a duplicate event', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    store.link(a.id, b.id);
    const before = store.listEvents(a.id).filter((e) => e.kind === 'linked').length;
    store.link(a.id, b.id);
    const after = store.listEvents(a.id).filter((e) => e.kind === 'linked').length;
    expect(after).toBe(before);
  });

  it('link rejects a direct cycle (a -> a)', () => {
    const a = store.createTask({ title: 'a' });
    expect(() => store.link(a.id, a.id)).toThrowError(/cycle/i);
  });

  it('link rejects an indirect cycle (a -> b -> c, then c -> a)', () => {
    const a = store.createTask({ title: 'a' });
    const b = store.createTask({ title: 'b' });
    const c = store.createTask({ title: 'c' });
    store.link(a.id, b.id);
    store.link(b.id, c.id);
    expect(() => store.link(c.id, a.id)).toThrowError(/cycle/i);
  });

  // ---------------------------------------------------------------------------
  // FTS5 search
  // ---------------------------------------------------------------------------

  it('searchFts finds tasks by FTS5 query over title or body', () => {
    const target = store.createTask({ title: 'fix flaky integration test', body: 'vitest hang' });
    store.createTask({ title: 'rotate keys' });

    const hits = store.searchFts('flaky');
    expect(hits.map((t) => t.id)).toContain(target.id);
    expect(hits.map((t) => t.id)).not.toContain(
      store.listTasks().find((t) => t.title === 'rotate keys')?.id,
    );
  });

  it('searchFts finds tasks via comment body', () => {
    const target = store.createTask({ title: 'login bug' });
    store.addComment(target.id, 'engineer', 'reproduced with safari + private mode');
    store.createTask({ title: 'cache warm' });

    const hits = store.searchFts('safari');
    expect(hits.map((t) => t.id)).toEqual([target.id]);
  });

  // ---------------------------------------------------------------------------
  // Audit trail (task_events)
  // ---------------------------------------------------------------------------

  it('every mutation inserts a task_events row with the expected kind', () => {
    const task = store.createTask({ title: 'audit me', actor: 'engineer' });

    store.updateStatus(task.id, 'running', undefined);
    store.heartbeatRun(task.id);
    store.addComment(task.id, 'engineer', 'progress note');
    const child = store.createTask({ title: 'child', actor: 'engineer' });
    store.link(task.id, child.id);
    store.assign(task.id, 'reviewer');
    store.completeRun(task.id, 'shipped');
    store.archive(task.id);

    const events = store.listEvents(task.id);
    const kinds = events.map((e) => e.kind);

    // The exact ordering of run_started vs status_changed-on-running is an
    // implementation detail; assert the multiset of expected kinds is present.
    expect(kinds).toEqual(
      expect.arrayContaining([
        'created',
        'status_changed', // todo -> running, and running -> done, and done -> archived
        'run_started',
        'heartbeat',
        'commented',
        'linked',
        'assigned',
        'run_completed',
        'archived',
      ]),
    );
  });

  // ---------------------------------------------------------------------------
  // File-backed DB re-open
  // ---------------------------------------------------------------------------

  it('re-opens an existing on-disk database without re-migrating and preserves data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-reopen-'));
    const dbPath = join(dir, 'kanban.db');
    try {
      const s1 = new KanbanStore(dbPath);
      const created = s1.createTask({ title: 'persisted' });
      s1.close();

      const s2 = new KanbanStore(dbPath);
      const found = s2.getTask(created.id);
      expect(found?.title).toBe('persisted');
      // Schema still works for new inserts after re-open
      const fresh = s2.createTask({ title: 'after reopen' });
      expect(s2.listTasks()).toHaveLength(2);
      expect(fresh.id).not.toBe(created.id);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Plan B dispatcher helpers
  // ---------------------------------------------------------------------------

  it('promoteReady gates on real-work parents (assignee set) and treats goal parents (assignee=null) as transparent', () => {
    const noParent = store.createTask({ title: 'standalone' });
    const realParent = store.createTask({ title: 'real-work', assignee: 'engineer' });
    const goalParent = store.createTask({ title: 'goal' }); // no assignee = goal
    const childOfReal = store.createTask({ title: 'child-real', parents: [realParent.id] });
    const childOfGoal = store.createTask({ title: 'child-goal', parents: [goalParent.id] });

    // Real-work parent not done → its child stays todo. Goal parent is
    // transparent → its child promotes immediately. Standalone has no parents.
    let promoted = store.promoteReady();
    expect(promoted).toContain(noParent.id);
    expect(promoted).toContain(childOfGoal.id);
    expect(promoted).not.toContain(childOfReal.id);

    // Finish the real-work parent → its child becomes eligible.
    store.updateStatus(realParent.id, 'running');
    store.completeRun(realParent.id, 'real parent done');
    promoted = store.promoteReady();
    expect(promoted).toContain(childOfReal.id);
  });

  it('promoteScheduled promotes scheduled tasks whose time has passed', () => {
    const past = store.createTask({ title: 'past', scheduledFor: 1 });
    const future = store.createTask({ title: 'future', scheduledFor: Date.now() + 60_000 });
    const promoted = store.promoteScheduled(Date.now());
    expect(promoted).toEqual([past.id]);
    expect(promoted).not.toContain(future.id);
    expect(store.getTask(past.id)?.status).toBe('ready');
    expect(store.getTask(future.id)?.status).toBe('scheduled');
  });

  it('findStalledRuns returns only runs whose last_heartbeat_at is older than cutoff', () => {
    const fresh = store.createTask({ title: 'fresh' });
    store.updateStatus(fresh.id, 'running');
    const stale = store.createTask({ title: 'stale' });
    store.updateStatus(stale.id, 'running');

    const now = Date.now();
    // Backdate the second run by 200ms via direct UPDATE (test-only shortcut).
    const staleRunId = store.getTask(stale.id)?.currentRunId;
    expect(staleRunId).toBeTruthy();
    // Pretend stale run hasn't heartbeated in 200ms
    (
      store as unknown as {
        db: { prepare: (s: string) => { run: (a: number, b: string) => void } };
      }
    ).db
      .prepare('UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ?')
      .run(now - 200, staleRunId as string);

    const stalled = store.findStalledRuns(100, now);
    expect(stalled.map((r) => r.taskId)).toEqual([stale.id]);
  });

  // ---------------------------------------------------------------------------
  // Goal rollup — assignee=null parents complete when all their children do
  // ---------------------------------------------------------------------------

  it('rollupCompletedGoals promotes a goal to done when every child is done', () => {
    const goal = store.createTask({ title: 'Q3 roadmap' });
    const c1 = store.createTask({ title: 'a', assignee: 'engineer', parents: [goal.id] });
    const c2 = store.createTask({ title: 'b', assignee: 'researcher', parents: [goal.id] });
    store.updateStatus(c1.id, 'running');
    store.completeRun(c1.id, 'done a');
    store.updateStatus(c2.id, 'running');
    store.completeRun(c2.id, 'done b');

    const completed = store.rollupCompletedGoals();
    expect(completed).toContain(goal.id);
    expect(store.getTask(goal.id)?.status).toBe('done');
  });

  it('rollupCompletedGoals leaves goals alone while any child is unfinished', () => {
    const goal = store.createTask({ title: 'wip' });
    const c1 = store.createTask({ title: 'a', assignee: 'engineer', parents: [goal.id] });
    store.createTask({ title: 'b', assignee: 'researcher', parents: [goal.id] });
    store.updateStatus(c1.id, 'running');
    store.completeRun(c1.id, 'half-done');

    const completed = store.rollupCompletedGoals();
    expect(completed).not.toContain(goal.id);
    expect(store.getTask(goal.id)?.status).not.toBe('done');
  });

  it('rollupCompletedGoals ignores goals with no children (nothing to roll up from)', () => {
    const empty = store.createTask({ title: 'placeholder goal' });
    expect(store.rollupCompletedGoals()).not.toContain(empty.id);
  });

  it('rollupCompletedGoals ignores goals whose every child was archived (refuses to silently swallow)', () => {
    const goal = store.createTask({ title: 'abandoned' });
    const c = store.createTask({ title: 'c', assignee: 'engineer', parents: [goal.id] });
    store.archive(c.id);

    expect(store.rollupCompletedGoals()).not.toContain(goal.id);
    expect(store.getTask(goal.id)?.status).not.toBe('done');
  });

  it('rollupCompletedGoals never touches real-work tasks (assignee set)', () => {
    const parent = store.createTask({ title: 'real-work parent', assignee: 'engineer' });
    const c = store.createTask({ title: 'c', assignee: 'researcher', parents: [parent.id] });
    store.updateStatus(c.id, 'running');
    store.completeRun(c.id, 'done c');

    expect(store.rollupCompletedGoals()).not.toContain(parent.id);
    // Parent stays at whatever status it was — rollup is a goal-only operation.
    expect(store.getTask(parent.id)?.status).not.toBe('done');
  });

  // ---------------------------------------------------------------------------
  // Orphan adoption — unassigned non-goal tickets get reassigned to coordinator
  // ---------------------------------------------------------------------------

  it('adoptOrphanTickets reassigns a leaf task with no assignee to the coordinator', () => {
    const orphan = store.createTask({ title: 'lost ticket' });
    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0 });
    expect(adopted).toContain(orphan.id);
    expect(store.getTask(orphan.id)?.assignee).toBe('coordinator');
  });

  it('adoptOrphanTickets does NOT touch goals (assignee=null + has children)', () => {
    const goal = store.createTask({ title: 'Q3 roadmap' });
    store.createTask({ title: 'child', assignee: 'engineer', parents: [goal.id] });
    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0 });
    expect(adopted).not.toContain(goal.id);
    expect(store.getTask(goal.id)?.assignee).toBeNull();
  });

  it('adoptOrphanTickets does NOT touch already-assigned tasks', () => {
    const assigned = store.createTask({ title: 'real work', assignee: 'engineer' });
    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0 });
    expect(adopted).not.toContain(assigned.id);
    expect(store.getTask(assigned.id)?.assignee).toBe('engineer');
  });

  it('adoptOrphanTickets does NOT touch done or archived tasks (closed work)', () => {
    const done = store.createTask({ title: 'done leaf' });
    const archived = store.createTask({ title: 'archived leaf' });
    store.updateStatus(done.id, 'done');
    store.archive(archived.id);

    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0 });
    expect(adopted).not.toContain(done.id);
    expect(adopted).not.toContain(archived.id);
  });

  it('adoptOrphanTickets honours gracePeriodMs — fresh orphans are protected from race', () => {
    // Without the grace window, kanban_create_goal would race the dispatcher:
    // the goal lives ~milliseconds without children before the coordinator
    // calls kanban_create on each child. A non-zero grace prevents premature
    // adoption during that window.
    const fresh = store.createTask({ title: 'goal in flight' });
    const adopted = store.adoptOrphanTickets('coordinator', { gracePeriodMs: 60_000 });
    expect(adopted).not.toContain(fresh.id);
    expect(store.getTask(fresh.id)?.assignee).toBeNull();
  });

  it('adoptOrphanTickets emits an `assigned` event so the coordinator sees the adoption', () => {
    const orphan = store.createTask({ title: 'lost ticket' });
    store.adoptOrphanTickets('coordinator', { gracePeriodMs: 0, actor: 'dispatcher' });
    const events = store.listEvents(orphan.id);
    const assigned = events.find((e) => e.kind === 'assigned');
    expect(assigned).toBeDefined();
    expect(assigned?.actor).toBe('dispatcher');
  });

  it('findReadyToDispatch returns ready tasks with an assignee and no open run, ordered by priority', () => {
    const t1 = store.createTask({ title: 'p2', assignee: 'engineer', priority: 2 });
    const t2 = store.createTask({ title: 'p9', assignee: 'researcher', priority: 9 });
    store.createTask({ title: 'unassigned' }); // no assignee
    const t4 = store.createTask({ title: 'in-prog', assignee: 'engineer' });
    store.updateStatus(t1.id, 'ready');
    store.updateStatus(t2.id, 'ready');
    store.updateStatus(t4.id, 'ready');
    store.updateStatus(t4.id, 'running'); // has a current_run_id now

    const out = store.findReadyToDispatch();
    expect(out.map((t) => t.id)).toEqual([t2.id, t1.id]); // priority 9 before 2
  });

  // ---------------------------------------------------------------------------
  // Cycle prevention — deterministic stress
  // ---------------------------------------------------------------------------

  it('no sequence of link() calls can produce a cycle (200 attempts)', () => {
    const ids = Array.from({ length: 30 }, (_, i) => store.createTask({ title: `n${i}` }).id);
    // Deterministic PRNG
    let seed = 0xc0ffee;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };

    let succeeded = 0;
    let rejected = 0;
    for (let i = 0; i < 200; i++) {
      const a = ids[next() % ids.length] as string;
      const b = ids[next() % ids.length] as string;
      try {
        store.link(a, b);
        succeeded++;
      } catch (e) {
        if ((e as Error).message.includes('cycle')) {
          rejected++;
        } else {
          throw e;
        }
      }
    }

    expect(succeeded + rejected).toBe(200);

    // Reachability check: traverse the child edges from each node and confirm
    // we never reach the starting node. This is necessary (and sufficient for
    // these small graphs) for the resulting edge set to be a DAG.
    for (const start of ids) {
      const visited = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (visited.has(cur)) continue;
        visited.add(cur);
        const children = store.listTasks({ parentId: cur });
        for (const c of children) {
          if (c.id === start) {
            throw new Error(`Cycle detected: ${start} reaches itself via ${cur}`);
          }
          stack.push(c.id);
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Retry budgets
  // ---------------------------------------------------------------------------

  it('createTask defaults retryCount to 0 and maxRetries to null (unlimited)', () => {
    const task = store.createTask({ title: 'work' });
    expect(task.retryCount).toBe(0);
    expect(task.maxRetries).toBeNull();
  });

  it('createTask persists an explicit maxRetries', () => {
    const task = store.createTask({ title: 'work', maxRetries: 2 });
    expect(task.maxRetries).toBe(2);
    expect(store.getTask(task.id)?.maxRetries).toBe(2);
  });

  it('createTask rejects a negative or non-integer maxRetries', () => {
    expect(() => store.createTask({ title: 'work', maxRetries: -1 })).toThrow(/non-negative/);
    expect(() => store.createTask({ title: 'work', maxRetries: 1.5 })).toThrow(/non-negative/);
  });

  it('updateStatus increments retryCount on re-claim but not on the first claim', () => {
    const task = store.createTask({ title: 'work' });

    // First claim — no prior runs, so this is not a re-claim.
    const firstClaim = store.updateStatus(task.id, 'running', 'dispatched');
    expect(firstClaim.retryCount).toBe(0);
    store.blockRun(task.id, 'stalled');

    // Second claim — a prior run exists, so this counts as a re-claim.
    const reclaim = store.updateStatus(task.id, 'running', 'dispatched');
    expect(reclaim.retryCount).toBe(1);
  });

  it('updateStatus keeps re-claiming forever when maxRetries is null (unlimited)', () => {
    const task = store.createTask({ title: 'work' });
    for (let i = 0; i < 5; i++) {
      const claimed = store.updateStatus(task.id, 'running', 'dispatched');
      expect(claimed.status).toBe('running');
      store.blockRun(task.id, `stalled ${i}`);
    }
    expect(store.getTask(task.id)?.retryCount).toBe(4);
  });

  it('fails a task with maxRetries=2 on the re-claim that exceeds the budget, with the typed reason', () => {
    const task = store.createTask({ title: 'impossible', maxRetries: 2 });

    // Claim 1 (retryCount stays 0 — first claim, not a re-claim), fails.
    expect(store.updateStatus(task.id, 'running', 'dispatched').status).toBe('running');
    store.blockRun(task.id, 'failed attempt 1');

    // Claim 2 (re-claim -> retryCount 1, within budget), fails.
    expect(store.updateStatus(task.id, 'running', 'dispatched').status).toBe('running');
    store.blockRun(task.id, 'failed attempt 2');

    // Claim 3 (re-claim -> retryCount 2, 2 <= 2 still within budget), fails.
    expect(store.updateStatus(task.id, 'running', 'dispatched').status).toBe('running');
    store.blockRun(task.id, 'failed attempt 3');

    // Claim 4 (re-claim -> retryCount 3, 3 > 2): budget exhausted. updateStatus
    // itself lands the task in 'failed' instead of opening another run.
    const failed = store.updateStatus(task.id, 'running', 'dispatched');
    expect(failed.status).toBe('failed');
    expect(failed.currentRunId).toBeNull();
    expect(failed.retryCount).toBe(3);
    // No fourth run was opened — the budget guard fired before the run insert.
    expect(store.listRuns(task.id)).toHaveLength(3);

    // The transition emits status_changed with the typed reason.
    const events = store.listEvents(task.id);
    const statusEvents = events.filter((e) => e.kind === 'status_changed');
    const last = statusEvents[statusEvents.length - 1];
    expect(last?.data.to).toBe('failed');
    expect(last?.data.reason).toBe('retry_budget_exhausted');
  });

  it('a task with maxRetries=0 fails on its first re-claim', () => {
    const task = store.createTask({ title: 'one-shot', maxRetries: 0 });
    expect(store.updateStatus(task.id, 'running').status).toBe('running'); // first claim ok
    store.blockRun(task.id, 'failed once');
    // First re-claim: retryCount would go to 1 > 0 — fails immediately.
    expect(store.updateStatus(task.id, 'running').status).toBe('failed');
  });

  // ---------------------------------------------------------------------------
  // Schema migration v1 -> v2
  // ---------------------------------------------------------------------------

  it('migrates a v1 database to v2: data survives, new columns appear, failed becomes insertable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-mig-'));
    const dbPath = join(dir, 'board.db');
    try {
      // Hand-build the FULL v1 database: every table, index, and trigger that
      // shipped at user_version=1, populated with rows in each FK child table
      // (task_comments / task_links / task_runs / task_events). The riskiest
      // part of the migration is the tasks-table rebuild while those FKs point
      // at it, so the fixture must exercise that surface.
      const v1 = new Database(dbPath);
      v1.pragma('journal_mode = WAL');
      v1.pragma('foreign_keys = ON');
      v1.exec(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL DEFAULT '',
          assignee        TEXT,
          status          TEXT NOT NULL
                          CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled')),
          priority        INTEGER NOT NULL DEFAULT 0,
          workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                          CHECK (workspace_mode IN ('scratch','worktree','dir')),
          workspace_path  TEXT,
          scheduled_for   INTEGER,
          idempotency_key TEXT,
          current_run_id  TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX tasks_idem ON tasks(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX tasks_status_assignee ON tasks(status, assignee);
        CREATE INDEX tasks_scheduled ON tasks(scheduled_for)
          WHERE scheduled_for IS NOT NULL;

        CREATE TABLE task_comments (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL,
          author     TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_comments_task ON task_comments(task_id, created_at);

        CREATE TABLE task_links (
          parent_id TEXT NOT NULL,
          child_id  TEXT NOT NULL,
          PRIMARY KEY (parent_id, child_id),
          FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (child_id)  REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_links_child ON task_links(child_id);

        CREATE TABLE task_runs (
          id                TEXT PRIMARY KEY,
          task_id           TEXT NOT NULL,
          started_at        INTEGER NOT NULL,
          ended_at          INTEGER,
          outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','stalled','cancelled')),
          summary           TEXT,
          last_heartbeat_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_runs_task ON task_runs(task_id, started_at);
        CREATE UNIQUE INDEX task_runs_open_one ON task_runs(task_id)
          WHERE ended_at IS NULL;

        CREATE TABLE task_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id    TEXT NOT NULL,
          kind       TEXT NOT NULL
                     CHECK (kind IN ('created','status_changed','commented','assigned','linked','unlinked','run_started','run_completed','heartbeat','archived')),
          actor      TEXT NOT NULL,
          data_json  TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX task_events_task ON task_events(task_id, created_at);
        CREATE INDEX task_events_recent ON task_events(created_at);

        CREATE VIRTUAL TABLE task_fts USING fts5(
          task_id UNINDEXED, title, body, comments, tokenize = 'porter'
        );
        CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
          INSERT INTO task_fts(task_id, title, body, comments)
          VALUES (new.id, new.title, new.body, '');
        END;
        CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, body ON tasks BEGIN
          UPDATE task_fts SET title = new.title, body = new.body
          WHERE task_id = new.id;
        END;
        CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
          DELETE FROM task_fts WHERE task_id = old.id;
        END;
        CREATE TRIGGER comments_fts_ai AFTER INSERT ON task_comments BEGIN
          UPDATE task_fts
          SET comments = (
            SELECT COALESCE(GROUP_CONCAT(body, ' '), '')
            FROM task_comments WHERE task_id = new.task_id
          )
          WHERE task_id = new.task_id;
        END;

        INSERT INTO tasks (id, title, body, assignee, status, priority, workspace_mode,
                           current_run_id, created_at, updated_at)
          VALUES
            ('t_parent', 'legacy parent', 'pre-migration body', NULL, 'ready', 0, 'scratch', NULL, 900, 900),
            ('t_seed', 'legacy task', 'pre-migration body', 'engineer', 'running', 1, 'scratch', 'r_open', 1000, 1000);
        INSERT INTO task_links (parent_id, child_id) VALUES ('t_parent', 't_seed');
        INSERT INTO task_comments (id, task_id, author, body, created_at)
          VALUES ('c_1', 't_seed', 'engineer', 'a legacy comment', 1100);
        INSERT INTO task_runs (id, task_id, started_at, ended_at, outcome, summary, last_heartbeat_at)
          VALUES
            ('r_done', 't_seed', 1000, 1050, 'blocked', 'first attempt', 1050),
            ('r_open', 't_seed', 1200, NULL, NULL, NULL, 1200);
        INSERT INTO task_events (task_id, kind, actor, data_json, created_at)
          VALUES ('t_seed', 'created', 'engineer', '{}', 1000);
      `);
      v1.pragma('user_version = 1');
      v1.close();

      // Opening with the current code runs the v1 -> v2 migration.
      const store = new KanbanStore(dbPath);
      try {
        const seed = store.getTask('t_seed');
        expect(seed).not.toBeNull();
        expect(seed?.title).toBe('legacy task');
        expect(seed?.body).toBe('pre-migration body');
        expect(seed?.assignee).toBe('engineer');
        expect(seed?.priority).toBe(1);
        expect(seed?.status).toBe('running');
        expect(seed?.currentRunId).toBe('r_open');
        // New columns are present with their backfill defaults.
        expect(seed?.maxRetries).toBeNull();
        expect(seed?.retryCount).toBe(0);

        // FK child rows survive the tasks-table rebuild.
        expect(store.listComments('t_seed').map((c) => c.id)).toEqual(['c_1']);
        expect(store.listRuns('t_seed').map((r) => r.id)).toEqual(['r_done', 'r_open']);
        expect(store.getParents('t_seed').map((p) => p.id)).toEqual(['t_parent']);
        expect(store.listEvents('t_seed').map((e) => e.kind)).toContain('created');

        // The widened CHECK accepts the new 'failed' status: a re-claim past
        // budget on the post-migration schema lands the task in 'failed'.
        const failable = store.createTask({ title: 'will fail', maxRetries: 0 });
        store.updateStatus(failable.id, 'running');
        store.blockRun(failable.id, 'attempt 1');
        expect(store.updateStatus(failable.id, 'running').status).toBe('failed');

        // FTS triggers were rebuilt — search over title still works.
        expect(
          store
            .listTasks({ q: 'legacy' })
            .map((t) => t.id)
            .sort(),
        ).toEqual(['t_parent', 't_seed'].sort());
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls the v1->v2 migration back atomically when it fails — no half-migrated state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-mig-fail-'));
    const dbPath = join(dir, 'board.db');
    try {
      // A v1 DB with an orphan task_comments row (FK points at a missing task).
      // The migration's `foreign_key_check` catches it and throws — which must
      // roll the WHOLE transaction back: no new columns, user_version still 1.
      const v1 = new Database(dbPath);
      v1.pragma('journal_mode = WAL');
      // foreign_keys OFF so the orphan row can be inserted in the first place.
      v1.pragma('foreign_keys = OFF');
      v1.exec(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL DEFAULT '',
          assignee        TEXT,
          status          TEXT NOT NULL
                          CHECK (status IN ('todo','ready','running','blocked','done','archived','scheduled')),
          priority        INTEGER NOT NULL DEFAULT 0,
          workspace_mode  TEXT NOT NULL DEFAULT 'scratch'
                          CHECK (workspace_mode IN ('scratch','worktree','dir')),
          workspace_path  TEXT,
          scheduled_for   INTEGER,
          idempotency_key TEXT,
          current_run_id  TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE task_comments (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL,
          author     TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        ) STRICT;
        CREATE VIRTUAL TABLE task_fts USING fts5(
          task_id UNINDEXED, title, body, comments, tokenize = 'porter'
        );
        INSERT INTO tasks (id, title, status, created_at, updated_at)
          VALUES ('t_ok', 'fine', 'todo', 1, 1);
        INSERT INTO task_comments (id, task_id, author, body, created_at)
          VALUES ('c_orphan', 't_missing', 'someone', 'dangling', 2);
      `);
      v1.pragma('user_version = 1');
      v1.close();

      // The migration must throw — and leave nothing behind.
      expect(() => new KanbanStore(dbPath)).toThrow(/foreign-key violation/);

      // Inspect the raw DB: still v1, no retry columns, original rows intact.
      const after = new Database(dbPath);
      try {
        const version = (after.pragma('user_version') as Array<{ user_version: number }>)[0]
          ?.user_version;
        expect(version).toBe(1);
        const cols = (after.pragma('table_info(tasks)') as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(cols).not.toContain('max_retries');
        expect(cols).not.toContain('retry_count');
        const taskCount = (after.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number })
          .n;
        expect(taskCount).toBe(1);
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to open a database whose user_version is newer than the code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-ver-'));
    const dbPath = join(dir, 'board.db');
    try {
      const future = new Database(dbPath);
      future.pragma('user_version = 3');
      future.close();
      expect(() => new KanbanStore(dbPath)).toThrow(/newer than code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
