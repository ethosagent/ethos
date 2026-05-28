// Phase 4 — Restart resilience: reconstruction tests.
//
// Validates the invariant that the kanban board is the SOLE source of truth:
// a supervisor can be destroyed mid-dispatch with no cleanup, and a fresh
// supervisor against the same board recovers to the same logical state — no
// ticket lost, no duplicate claim, no orphaned in-flight work that fails to
// surface for re-dispatch.
//
// ---------------------------------------------------------------------------
// Audit — in-memory state in extensions/team-supervisor/src/
// ---------------------------------------------------------------------------
// dispatcher.ts:
//   - `inflight` (Map<taskId, AbortController>) — the open HTTP dispatch and
//     its abort handle. NOT persisted, and intentionally so: the durable
//     footprint of an in-flight dispatch is the `running` task + open
//     `task_runs` row already on the board. On a crash that map is dropped;
//     the open run goes stale and a fresh dispatcher reclaims it on the next
//     tick (heartbeat-stale → blockRun, or Phase 2 staleness/no-owner →
//     reclaimTask → ready). Reconstructable from board content alone.
//   - `timer` / `running` — scheduler bookkeeping for the setInterval loop.
//     Pure process-local state; a fresh Dispatcher rebuilds them on `start()`.
//     Nothing work-related lives here.
// supervisor.ts:
//   - `memberMap` (Map<personality, MemberState>) — ports, pids, child
//     handles, lifecycle status. Rebuilt deterministically on startup:
//     ports are re-allocated, children are re-spawned, status is re-derived.
//     The board references members only by personality id (the `assignee`
//     string), which is stable across restarts.
//   - `recentFailures` / `failureCount` — restart-backoff *policy*, not work
//     state. Losing them on restart means a fresh supervisor starts the
//     crash-rate window clean; that is acceptable (a restart IS the recovery
//     action) and explicitly NOT a durability bug.
//   - `shuttingDown` / `startedAt` — process-local lifecycle flags.
// runtime.ts: `*.runtime.json` is a best-effort *observability* snapshot for
//   `ethos team status`, never read back as authority — readRuntime exists
//   only for status display.
//
// Conclusion: no non-reconstructable *work* state exists. Phases 1+2 already
// built every reclaim path the audit would otherwise demand. These tests
// prove the reconstruction works; no schema or contract surface is added.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '@ethosagent/kanban-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../dispatcher';

// A real temp-file board is the honest model of "same durable store, new
// supervisor process": closing one KanbanStore handle and opening a fresh one
// against the same path is exactly what a supervisor restart does. `:memory:`
// would not survive the close.
function makeSupervisor(members) {
  return {
    portOf: (p) => members[p]?.port ?? null,
    statusOf: (p) => members[p]?.status ?? null,
  };
}
// Backdate a run's heartbeat so the heartbeat-stale reclaim path fires without
// sleeping. Mirrors the helper in dispatcher.test.ts.
function backdateHeartbeat(board, runId, ms) {
  board.db
    .prepare('UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ?')
    .run(Date.now() - ms, runId);
}
// Backdate a task's updated_at so the Phase 2 staleness reclaim path fires
// without sleeping. Mirrors the helper in dispatcher.test.ts.
function backdateUpdatedAt(board, taskId, ms) {
  board.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - ms, taskId);
}
describe('supervisor reconstruction — kanban is the sole source of truth', () => {
  let workDir;
  let boardPath;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ethos-reconstruction-'));
    boardPath = join(workDir, 'board.db');
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
  it('recovers in-flight tickets after a mid-dispatch crash (clean-ish: stop() the dispatcher, drop the handle)', async () => {
    // --- Supervisor instance #1 — dispatch N tickets to M members. ---
    const sup1 = makeSupervisor({
      engineer: { port: 3001, status: 'running' },
      researcher: { port: 3002, status: 'running' },
    });
    const board1 = new KanbanStore(boardPath);
    const t1 = board1.createTask({ title: 'fix bug', assignee: 'engineer' });
    const t2 = board1.createTask({ title: 'market scan', assignee: 'researcher' });
    const t3 = board1.createTask({ title: 'write docs', assignee: 'engineer' });
    board1.updateStatus(t1.id, 'ready');
    board1.updateStatus(t2.id, 'ready');
    board1.updateStatus(t3.id, 'ready');
    // A dispatch transport that never resolves — the dispatches stay in-flight,
    // exactly the state a supervisor would be in when it crashes mid-dispatch.
    // Intentionally ignores the abort `signal` so the promise stays pending
    // forever — do not "fix" it to honor the signal (its .finally() would then
    // run after board1 is closed → use-after-close).
    const hang = () => new Promise(() => {});
    const dispatcher1 = new Dispatcher({ board: board1, supervisor: sup1, dispatch: hang });
    await dispatcher1.tick();
    // Active state matches expectations: all three tickets claimed (running,
    // open run) — no ticket left ready, none lost.
    expect(board1.getTask(t1.id)?.status).toBe('running');
    expect(board1.getTask(t2.id)?.status).toBe('running');
    expect(board1.getTask(t3.id)?.status).toBe('running');
    const runIds = [t1, t2, t3].map((t) => board1.getTask(t.id)?.currentRunId);
    expect(runIds.every((r) => typeof r === 'string')).toBe(true);
    // --- Crash mid-dispatch. stop() aborts in-flight calls and drops the
    //     in-memory `inflight` map; the open runs stay `running` on disk. ---
    await dispatcher1.stop();
    board1.close();
    // --- Supervisor instance #2 — fresh Dispatcher + fresh KanbanStore handle
    //     against the SAME board file. The in-flight runs' heartbeats are now
    //     stale (a crashed worker stopped heartbeating). ---
    const board2 = new KanbanStore(boardPath);
    for (const runId of runIds) {
      if (typeof runId === 'string') backdateHeartbeat(board2, runId, 200_000);
    }
    const sup2 = makeSupervisor({
      engineer: { port: 3001, status: 'running' },
      researcher: { port: 3002, status: 'running' },
    });
    const dispatch2 = vi.fn(async () => 'ok');
    const dispatcher2 = new Dispatcher({
      board: board2,
      supervisor: sup2,
      dispatch: dispatch2,
      staleMs: 90_000,
    });
    await dispatcher2.tick();
    await new Promise((r) => setImmediate(r));
    // No ticket lost: all three still exist on the board.
    expect(board2.getTask(t1.id)).not.toBeNull();
    expect(board2.getTask(t2.id)).not.toBeNull();
    expect(board2.getTask(t3.id)).not.toBeNull();
    // The stale in-flight runs surfaced for re-dispatch — heartbeat-stale path
    // marked them `blocked`, which is the board state a human / reassign can
    // act on. No ticket is stuck silently `running` with a dead owner.
    for (const t of [t1, t2, t3]) {
      const task = board2.getTask(t.id);
      expect(task?.status).toBe('blocked');
      // The open run was closed atomically by blockRun — no orphaned run.
      expect(task?.currentRunId).toBeNull();
    }
    // No duplicate claims: each task has exactly one run, and it is ended.
    for (const t of [t1, t2, t3]) {
      const events = board2.listEvents(t.id);
      const runStarts = events.filter((e) => e.kind === 'run_started');
      expect(runStarts).toHaveLength(1);
      const runEnds = events.filter((e) => e.kind === 'run_completed');
      expect(runEnds).toHaveLength(1);
    }
    await dispatcher2.stop();
    board2.close();
  });
  it('recovers in-flight tickets after a kill -9 crash (no stop(), no cleanup — just drop the reference)', async () => {
    // --- Supervisor instance #1 — dispatch tickets, then VANISH. ---
    const sup1 = makeSupervisor({
      engineer: { port: 3001, status: 'running' },
      researcher: { port: 3002, status: 'running' },
    });
    const board1 = new KanbanStore(boardPath);
    const t1 = board1.createTask({ title: 'fix bug', assignee: 'engineer' });
    const t2 = board1.createTask({ title: 'market scan', assignee: 'researcher' });
    board1.updateStatus(t1.id, 'ready');
    board1.updateStatus(t2.id, 'ready');
    // Intentionally ignores the abort `signal` so the promise stays pending
    // forever — do not "fix" it to honor the signal (its .finally() would then
    // run after board1 is closed → use-after-close).
    const hang = () => new Promise(() => {});
    const dispatcher1 = new Dispatcher({ board: board1, supervisor: sup1, dispatch: hang });
    await dispatcher1.tick();
    expect(board1.getTask(t1.id)?.status).toBe('running');
    expect(board1.getTask(t2.id)?.status).toBe('running');
    const t1RunId = board1.getTask(t1.id)?.currentRunId;
    const t2RunId = board1.getTask(t2.id)?.currentRunId;
    // kill -9 equivalent: NO dispatcher1.stop(). The dispatcher's in-memory
    // state — `inflight`, `timer`, the AbortControllers — is dropped on the
    // floor with no graceful drain, exactly as it would be if the process were
    // SIGKILLed. Closing board1 only models the OS releasing the file
    // descriptor on process death; it does NOT close the open `task_runs`
    // rows, so the durable board still carries the in-flight runs as `running`.
    board1.close();
    // --- Supervisor instance #2 — brand-new handle against the same file. ---
    const board2 = new KanbanStore(boardPath);
    // The crashed worker stopped heartbeating AND stopped making progress, so
    // both reclaim paths are eligible. We model that by backdating updated_at
    // past the staleness threshold — the Phase 2 path re-queues the task to
    // `ready` and the same tick re-dispatches it.
    if (typeof t1RunId === 'string') backdateUpdatedAt(board2, t1.id, 600_000);
    if (typeof t2RunId === 'string') backdateUpdatedAt(board2, t2.id, 600_000);
    const sup2 = makeSupervisor({
      engineer: { port: 3001, status: 'running' },
      researcher: { port: 3002, status: 'running' },
    });
    // A never-resolving dispatch keeps the re-dispatched runs unambiguously
    // in-flight: the task staying `running` with an open run means "re-claimed
    // and re-dispatched", not "dispatch silently completed". (The dispatcher
    // never auto-completes a run — the assignee owns kanban_complete — so a
    // resolving stub would still leave the run open, which reads as nonsense.)
    const hang2 = () => new Promise(() => {});
    const dispatch2 = vi.fn(hang2);
    const dispatcher2 = new Dispatcher({
      board: board2,
      supervisor: sup2,
      dispatch: dispatch2,
      stalenessThresholdMs: 300_000,
    });
    await dispatcher2.tick();
    await new Promise((r) => setImmediate(r));
    // No ticket lost.
    expect(board2.getTask(t1.id)).not.toBeNull();
    expect(board2.getTask(t2.id)).not.toBeNull();
    // Each task was reclaimed (orphan_stale) and re-dispatched within the same
    // tick — it surfaced for re-dispatch, exactly the invariant under test.
    for (const t of [t1, t2]) {
      const events = board2.listEvents(t.id);
      const reclaim = events.find(
        (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_stale',
      );
      expect(reclaim).toBeDefined();
      expect(board2.getTask(t.id)?.status).toBe('running');
    }
    // The fresh dispatcher re-dispatched both reclaimed tickets — work was not
    // dropped, it surfaced and got picked up again.
    expect(dispatch2).toHaveBeenCalledTimes(2);
    // No duplicate claims: the original run was cancelled by reclaimTask, then
    // exactly one fresh run was opened. Two run_started events total, the first
    // one ended (cancelled), the second still open.
    for (const t of [t1, t2]) {
      const events = board2.listEvents(t.id);
      const runStarts = events.filter((e) => e.kind === 'run_started');
      expect(runStarts).toHaveLength(2);
      const cancelled = events.find(
        (e) => e.kind === 'run_completed' && e.data.outcome === 'cancelled',
      );
      expect(cancelled).toBeDefined();
      // retry budget was spent once on the re-claim.
      expect(board2.getTask(t.id)?.retryCount).toBe(1);
    }
    await dispatcher2.stop();
    board2.close();
  });
  it('reclaims in-flight work whose assignee process did not come back after the crash (orphan_no_owner)', async () => {
    // A crash can take a member process with it. If the fresh supervisor
    // re-spawns members and one fails to come back, its in-flight ticket must
    // still surface — not stay silently `running` forever.
    const sup1 = makeSupervisor({ engineer: { port: 3001, status: 'running' } });
    const board1 = new KanbanStore(boardPath);
    const t = board1.createTask({ title: 'fix bug', assignee: 'engineer' });
    board1.updateStatus(t.id, 'ready');
    // Intentionally ignores the abort `signal` so the promise stays pending
    // forever — do not "fix" it to honor the signal (its .finally() would then
    // run after board1 is closed → use-after-close).
    const hang = () => new Promise(() => {});
    const dispatcher1 = new Dispatcher({ board: board1, supervisor: sup1, dispatch: hang });
    await dispatcher1.tick();
    expect(board1.getTask(t.id)?.status).toBe('running');
    // kill -9: no dispatcher1.stop() — in-flight dispatch state is dropped
    // ungracefully. board1.close() only models the OS reclaiming the fd; the
    // open run stays `running` on the durable board.
    board1.close();
    // Fresh supervisor — but `engineer` failed to re-spawn (status: 'failed').
    const board2 = new KanbanStore(boardPath);
    const sup2 = makeSupervisor({ engineer: { port: 3001, status: 'failed' } });
    const dispatch2 = vi.fn(async () => 'ok');
    const dispatcher2 = new Dispatcher({
      board: board2,
      supervisor: sup2,
      dispatch: dispatch2,
      // updated_at is fresh — this exercises the no-owner path, not staleness.
      stalenessThresholdMs: 600_000,
    });
    await dispatcher2.tick();
    await new Promise((r) => setImmediate(r));
    // The orphaned in-flight ticket surfaced: reclaimed back to `ready` with
    // reason orphan_no_owner. It is NOT silently stuck `running`.
    const events = board2.listEvents(t.id);
    const reclaim = events.find(
      (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_no_owner',
    );
    expect(reclaim).toBeDefined();
    expect(board2.getTask(t.id)?.status).toBe('ready');
    // Owner is gone, so it can't be re-dispatched this tick — it waits, visible
    // on the board, for the member to come back.
    expect(dispatch2).not.toHaveBeenCalled();
    await dispatcher2.stop();
    board2.close();
  });
});
