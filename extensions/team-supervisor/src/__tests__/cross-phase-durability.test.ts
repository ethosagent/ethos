// Cross-phase durability verification — the final task of the "Team
// Durability" plan, run after all five phases land.
//
// The five phases were each unit-tested in isolation. This test proves the
// *interactions*: retry budgets (Phase 1) + staleness reclaim (Phase 2) +
// acceptance-criteria / needs_revision (Phase 3) + crash reconstruction
// (Phase 4) + team_member_stats (Phase 5) all holding simultaneously across a
// realistic dispatch cycle.
//
// Harness shape (modelled on dispatcher.test.ts + supervisor-reconstruction.test.ts):
//   - A REAL KanbanStore on a temp-file board. A file board — not `:memory:` —
//     is what makes "supervisor crash" honest: closing one handle and opening a
//     fresh one against the same path is exactly a supervisor restart.
//   - A mock SupervisorState (the `portOf` / `statusOf` view the dispatcher needs).
//   - A stub DispatchCall whose per-member behaviour we control to simulate
//     failures. We do NOT spawn real CLI children — `runSupervisor` blocks
//     forever and is not unit-testable; every existing test operates at the
//     Dispatcher + KanbanStore level and so does this one.
//
// The cycle: ~100 tickets across 3 members, each with a `max_retries` budget,
// driven through dispatch + simulated failures + supervisor crashes + stale
// claims, then the five plan invariants are asserted.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '@ethosagent/kanban-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DispatchCall, Dispatcher, type SupervisorState } from '../dispatcher';

const TEAM_ID = 'team-durability';
const MEMBERS = ['engineer', 'researcher', 'writer'] as const;
type Member = (typeof MEMBERS)[number];

function makeSupervisor(
  members: Record<string, { port: number; status: 'running' | 'starting' | 'failed' }>,
): SupervisorState {
  return {
    portOf: (p) => members[p]?.port ?? null,
    statusOf: (p) => members[p]?.status ?? null,
  };
}

// All three members up and reachable — the steady-state supervisor view.
function allRunning(): SupervisorState {
  return makeSupervisor({
    engineer: { port: 3001, status: 'running' },
    researcher: { port: 3002, status: 'running' },
    writer: { port: 3003, status: 'running' },
  });
}

// Backdate a task's updated_at so the Phase 2 staleness reclaim path fires
// without sleeping. Same helper shape the sibling tests use.
function backdateUpdatedAt(board: KanbanStore, taskId: string, ms: number): void {
  (
    board as unknown as {
      db: { prepare: (s: string) => { run: (a: number, b: string) => void } };
    }
  ).db
    .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
    .run(Date.now() - ms, taskId);
}

// A logical snapshot of the board, reconstructed purely from store reads — the
// thing a fresh supervisor would see. Phase 4's invariant is that this is a
// pure function of board content, so two reads against the same board (across
// a crash) must be byte-identical.
interface BoardSnapshot {
  tasks: Array<{
    id: string;
    status: string;
    assignee: string | null;
    retryCount: number;
    maxRetries: number | null;
    currentRunId: string | null;
  }>;
  stats: Array<{
    memberId: string;
    completed: number;
    failed: number;
    orphaned: number;
  }>;
}

function snapshot(board: KanbanStore): BoardSnapshot {
  const tasks = board
    .listTasks({ limit: -1 })
    .map((t) => ({
      id: t.id,
      status: t.status,
      assignee: t.assignee,
      retryCount: t.retryCount,
      maxRetries: t.maxRetries,
      currentRunId: t.currentRunId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const stats = [...board.getMemberStats().values()]
    .map((s) => ({
      memberId: s.memberId,
      completed: s.ticketsCompleted,
      failed: s.ticketsFailed,
      orphaned: s.ticketsOrphaned,
    }))
    .sort((a, b) => a.memberId.localeCompare(b.memberId));
  return { tasks, stats };
}

describe('cross-phase durability — 100 tickets, failures, crashes, stale claims', () => {
  let workDir: string;
  let boardPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ethos-cross-phase-'));
    boardPath = join(workDir, 'board.db');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('drives a full cycle and holds all five plan invariants together', async () => {
    // -----------------------------------------------------------------------
    // Seed — 102 tickets across 3 members, each with a finite retry budget.
    // 34 per member. The board is a real team board (teamId set) so the
    // Phase 5 stats counters are live.
    // -----------------------------------------------------------------------
    const TICKETS_PER_MEMBER = 34;
    const board0 = new KanbanStore(boardPath, { teamId: TEAM_ID });

    // Tagging: every ticket gets a deterministic "fate" so the simulation is
    // reproducible. `flaky` ones throw on dispatch until their budget runs
    // out; `ok` ones complete on first claim; `slow` ones go stale mid-run.
    type Fate = 'ok' | 'flaky' | 'slow';
    const fateOf = (idx: number): Fate => {
      const m = idx % 5;
      if (m === 0) return 'flaky';
      if (m === 1) return 'slow';
      return 'ok';
    };

    const seeded: Array<{ id: string; member: Member; fate: Fate; maxRetries: number }> = [];
    for (const member of MEMBERS) {
      for (let i = 0; i < TICKETS_PER_MEMBER; i++) {
        const globalIdx = seeded.length;
        const fate = fateOf(globalIdx);
        // maxRetries 2 for flaky tickets (they need a couple re-claims),
        // 1 for everything else. A flaky ticket needs MORE than its budget of
        // failures to actually exhaust it — see the dispatch stub below.
        const maxRetries = fate === 'flaky' ? 2 : 1;
        const t = board0.createTask({
          title: `${member} task ${i}`,
          assignee: member,
          maxRetries,
        });
        board0.updateStatus(t.id, 'ready');
        seeded.push({ id: t.id, member, fate, maxRetries });
      }
    }
    expect(seeded).toHaveLength(102);
    board0.close();

    // The set of flaky ticket ids whose dispatch should keep throwing. A flaky
    // ticket's dispatch throws every time — it never lets the assignee call
    // kanban_complete — so it gets blocked, re-queued, re-claimed (burning
    // retry budget), and eventually `updateStatus` fails it when the budget
    // is blown. maxRetries=2 → 1st claim + 2 re-claims = 3 attempts, the 3rd
    // re-claim (retry_count would be 3 > 2) lands it in `failed`.
    const flakyIds = new Set(seeded.filter((s) => s.fate === 'flaky').map((s) => s.id));
    const slowIds = new Set(seeded.filter((s) => s.fate === 'slow').map((s) => s.id));
    const okIds = new Set(seeded.filter((s) => s.fate === 'ok').map((s) => s.id));

    // A dispatch stub: throws for flaky tickets (connection-refused style),
    // resolves for everything else. The taskId is recoverable from the prompt
    // (renderTaskPrompt embeds `Task id: \`<id>\``).
    const taskIdFromPrompt = (prompt: string): string => {
      const m = prompt.match(/Task id: `([^`]+)`/);
      if (m === null) throw new Error(`dispatch stub: no task id in prompt`);
      return m[1] as string;
    };
    const makeDispatch = (): ReturnType<typeof vi.fn<DispatchCall>> =>
      vi.fn<DispatchCall>(async ({ prompt }) => {
        const id = taskIdFromPrompt(prompt);
        if (flakyIds.has(id)) {
          throw new Error('connection refused');
        }
        return 'ok';
      });

    // =======================================================================
    // PHASE A — first supervisor instance. One tick: claim + dispatch the
    // whole ready queue. flaky dispatches throw → tasks go `blocked`. ok/slow
    // dispatches resolve → tasks stay `running` with an open run (the
    // dispatcher never auto-completes; the assignee owns kanban_complete).
    // =======================================================================
    const board1 = new KanbanStore(boardPath, { teamId: TEAM_ID });
    const dispatch1 = makeDispatch();
    const errors1: string[] = [];
    const dispatcher1 = new Dispatcher({
      board: board1,
      supervisor: allRunning(),
      dispatch: dispatch1,
      onError: (_e, id) => errors1.push(id),
      stalenessThresholdMs: 60_000,
    });

    await dispatcher1.tick();
    // Let the fire-and-forget dispatches settle (the flaky throws route
    // through blockRun on a microtask).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Every one of the 102 got claimed and POSTed.
    expect(dispatch1).toHaveBeenCalledTimes(102);
    // flaky tickets surfaced as blocked; ok/slow are running with an open run.
    for (const s of seeded) {
      const task = board1.getTask(s.id);
      expect(task).not.toBeNull();
      if (s.fate === 'flaky') {
        expect(task?.status).toBe('blocked');
        expect(task?.currentRunId).toBeNull();
      } else {
        expect(task?.status).toBe('running');
        expect(task?.currentRunId).not.toBeNull();
      }
    }

    // The ok tickets complete out-of-band — model the assignee calling
    // kanban_complete. (The dispatcher resolved; the real assignee would now
    // close the ticket.) slow tickets are intentionally left running so they
    // can go stale in Phase C.
    for (const id of okIds) {
      board1.completeRun(id, 'done by assignee');
    }

    // --- CRASH #1: drop the dispatcher and the store handle. The slow
    //     tickets are mid-run; the flaky ones are blocked; the ok ones done.
    await dispatcher1.stop();
    board1.close();

    // =======================================================================
    // PHASE B — supervisor instance #2. Verify reconstruction is identical,
    // then re-queue the blocked flaky tickets (a coordinator/human action:
    // blocked tasks don't self-promote) and tick again so they get
    // re-claimed — burning retry budget.
    // =======================================================================
    const board2a = new KanbanStore(boardPath, { teamId: TEAM_ID });
    const reconstructA = snapshot(board2a);
    board2a.close();
    // Re-open a *third* handle and snapshot again — reconstruction must be a
    // pure function of board content, so two independent reads match exactly.
    const board2b = new KanbanStore(boardPath, { teamId: TEAM_ID });
    const reconstructB = snapshot(board2b);
    expect(reconstructB).toEqual(reconstructA);

    // Re-queue every blocked flaky ticket. This is the retry path: blocked →
    // ready → (next tick) re-claim via updateStatus('running'), which bumps
    // retry_count. We do several rounds; each round burns one retry per flaky
    // ticket until the budget (maxRetries=2) is exhausted and updateStatus
    // forces the task to `failed`.
    const dispatch2 = makeDispatch();
    const dispatcher2 = new Dispatcher({
      board: board2b,
      supervisor: allRunning(),
      dispatch: dispatch2,
      stalenessThresholdMs: 60_000,
    });

    // Round 1..N: keep re-queueing whatever flaky tickets are still `blocked`
    // and tick. Bounded loop — a flaky ticket with maxRetries=2 needs at most
    // 3 re-queue rounds before it lands in `failed`.
    for (let round = 0; round < 5; round++) {
      const stillBlocked = [...flakyIds].filter((id) => board2b.getTask(id)?.status === 'blocked');
      if (stillBlocked.length === 0) break;
      for (const id of stillBlocked) {
        board2b.updateStatus(id, 'ready', 'requeued for retry', 'coordinator');
      }
      await dispatcher2.tick();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }

    // Every flaky ticket has now exhausted its budget and transitioned to
    // `failed` — none is stuck looping forever.
    for (const id of flakyIds) {
      const task = board2b.getTask(id);
      expect(task?.status).toBe('failed');
      // retry_count went past max_retries — that is exactly the over-budget
      // signal Phase 1 records.
      expect(task?.retryCount).toBeGreaterThan(task?.maxRetries ?? 0);
    }

    await dispatcher2.stop();
    board2b.close();

    // =======================================================================
    // PHASE C — supervisor instance #3. The `slow` tickets have been `running`
    // since Phase A with no heartbeat. Backdate their updated_at so the
    // Phase 2 staleness reclaim fires, then tick: they get reclaimed to
    // `ready` (orphan_stale) and re-dispatched within the same tick.
    // =======================================================================
    const board3a = new KanbanStore(boardPath, { teamId: TEAM_ID });
    // Reconstruction is still identical across this crash boundary too.
    const reconstructC1 = snapshot(board3a);
    board3a.close();
    const board3 = new KanbanStore(boardPath, { teamId: TEAM_ID });
    expect(snapshot(board3)).toEqual(reconstructC1);

    // The slow tickets stopped making progress — backdate them past the
    // staleness threshold.
    for (const id of slowIds) {
      backdateUpdatedAt(board3, id, 600_000);
    }

    const dispatch3 = makeDispatch();
    const dispatcher3 = new Dispatcher({
      board: board3,
      supervisor: allRunning(),
      dispatch: dispatch3,
      stalenessThresholdMs: 300_000,
    });

    await dispatcher3.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Each slow ticket was reclaimed (orphan_stale) — it did NOT stay stuck
    // `running` with a dead owner forever.
    for (const id of slowIds) {
      const events = board3.listEvents(id);
      const reclaim = events.find(
        (e) => e.kind === 'status_changed' && e.data.reason === 'orphan_stale',
      );
      expect(reclaim).toBeDefined();
      // Reclaimed → ready → re-dispatched in the same tick → running again,
      // with a fresh open run. (slow tickets are not in flakyIds, so the
      // dispatch stub resolved.)
      const task = board3.getTask(id);
      expect(task?.status).toBe('running');
      expect(task?.currentRunId).not.toBeNull();
    }

    // The re-dispatched slow tickets now complete out-of-band.
    for (const id of slowIds) {
      board3.completeRun(id, 'done after reclaim');
    }

    await dispatcher3.stop();
    board3.close();

    // =======================================================================
    // FINAL ASSERTIONS — the five plan invariants, against a fresh handle.
    // =======================================================================
    const final = new KanbanStore(boardPath, { teamId: TEAM_ID });
    const allTasks = final.listTasks({ limit: -1 });

    // --- Invariant 1: NO TICKET IS LOST. All 102 still exist, and every one
    //     is in a recognised terminal-or-live status — none vanished, none is
    //     in a nonsense state.
    expect(allTasks).toHaveLength(102);
    const seenIds = new Set(allTasks.map((t) => t.id));
    for (const s of seeded) {
      expect(seenIds.has(s.id)).toBe(true);
    }
    const byId = new Map(allTasks.map((t) => [t.id, t] as const));
    // ok + slow tickets all completed; flaky tickets all failed.
    for (const id of okIds) expect(byId.get(id)?.status).toBe('done');
    for (const id of slowIds) expect(byId.get(id)?.status).toBe('done');
    for (const id of flakyIds) expect(byId.get(id)?.status).toBe('failed');

    // --- Invariant 2: NO TICKET EXCEEDS max_retries WITHOUT TRANSITIONING TO
    //     `failed`. Any task whose retry_count is past its budget MUST be
    //     `failed` — never still `running`/`ready`/`blocked`.
    for (const t of allTasks) {
      if (t.maxRetries !== null && t.retryCount > t.maxRetries) {
        expect(t.status).toBe('failed');
      }
    }

    // --- Invariant 3: NO TICKET IS CLAIMED BUT STUCK FOREVER. Nothing is left
    //     `running`, and every `running` task in Phase C's reclaim window did
    //     surface (asserted above). At cycle end the board is fully quiescent:
    //     no open runs anywhere.
    for (const t of allTasks) {
      expect(t.status).not.toBe('running');
      expect(t.currentRunId).toBeNull();
    }

    // --- Invariant 4: THE SUPERVISOR RECONSTRUCTS IDENTICALLY AFTER EVERY
    //     CRASH. Already proven at each crash boundary (reconstructA===B,
    //     reconstructC1 stable across a re-open). One more: a brand-new handle
    //     here reconstructs the same snapshot as another brand-new handle.
    const finalSnapshotA = snapshot(final);
    final.close();
    const finalReopen = new KanbanStore(boardPath, { teamId: TEAM_ID });
    expect(snapshot(finalReopen)).toEqual(finalSnapshotA);

    // --- Invariant 5: team_member_stats REFLECTS THE SIMULATED OUTCOMES.
    //     Per member: completed === count of ok+slow tickets; failed ===
    //     count of flaky tickets. orphaned === count of slow tickets (each
    //     slow ticket was reclaimed exactly once in Phase C).
    const stats = finalReopen.getMemberStats();
    for (const member of MEMBERS) {
      const memberSeeded = seeded.filter((s) => s.member === member);
      const expectedCompleted = memberSeeded.filter(
        (s) => s.fate === 'ok' || s.fate === 'slow',
      ).length;
      const expectedFailed = memberSeeded.filter((s) => s.fate === 'flaky').length;
      const expectedOrphaned = memberSeeded.filter((s) => s.fate === 'slow').length;
      const s = stats.get(member);
      expect(s).toBeDefined();
      expect(s?.ticketsCompleted).toBe(expectedCompleted);
      expect(s?.ticketsFailed).toBe(expectedFailed);
      expect(s?.ticketsOrphaned).toBe(expectedOrphaned);
    }
    // The whole board's completed tally equals every non-flaky ticket.
    const totalCompleted = [...stats.values()].reduce((n, s) => n + s.ticketsCompleted, 0);
    expect(totalCompleted).toBe(okIds.size + slowIds.size);

    finalReopen.close();
  });

  it('routes a ticket to needs_revision when an acceptance-criteria verifier rejects it (Phase 3), and stats count the rejection', async () => {
    // Phase 3 surface: a ticket carrying `acceptance_criteria` whose
    // before_ticket_complete verifier rejects it lands in `needs_revision`
    // (not `done`), the original assignee can re-claim it — and that re-claim
    // burns the retry budget. `needs_revision` is a `tickets_failed` outcome
    // for Phase 5 stats. We model the verifier's rejection as the store-level
    // transition the `kanban_complete` tool performs on a `handled:true`
    // result: updateStatus(id, 'needs_revision').
    const board = new KanbanStore(boardPath, { teamId: TEAM_ID });
    const sup = allRunning();
    const dispatch = vi.fn<DispatchCall>(async () => 'ok');

    // A ticket with acceptance criteria and a 1-retry budget.
    const t = board.createTask({
      title: 'feature with criteria',
      assignee: 'engineer',
      acceptanceCriteria: 'all tests pass; no console.log',
      maxRetries: 1,
    });
    board.updateStatus(t.id, 'ready');
    expect(board.getTask(t.id)?.acceptanceCriteria).toBe('all tests pass; no console.log');

    const dispatcher = new Dispatcher({ board, supervisor: sup, dispatch });

    // Tick 1: claimed + dispatched → running.
    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));
    expect(board.getTask(t.id)?.status).toBe('running');

    // The assignee calls kanban_complete; the before_ticket_complete verifier
    // rejects it. The tool's rejection path routes the running task to
    // needs_revision instead of done.
    board.updateStatus(t.id, 'needs_revision', 'criteria not met: console.log left in', 'verifier');
    const afterReject = board.getTask(t.id);
    expect(afterReject?.status).toBe('needs_revision');
    // The reclaim/retry budget is untouched so far — the rejection itself is
    // not a re-claim.
    expect(afterReject?.retryCount).toBe(0);

    // The original assignee re-claims the needs_revision ticket to retry.
    // needs_revision → ready → running. The re-claim goes through
    // updateStatus('running') with a prior ended run, so it burns one retry.
    board.updateStatus(t.id, 'ready', 'assignee picks up revision', 'engineer');
    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));
    const afterReclaim = board.getTask(t.id);
    expect(afterReclaim?.status).toBe('running');
    expect(afterReclaim?.retryCount).toBe(1);

    // This time the verifier is satisfied — the assignee completes it cleanly.
    board.completeRun(t.id, 'criteria met on retry');
    expect(board.getTask(t.id)?.status).toBe('done');

    await dispatcher.stop();

    // Phase 5 stats: the needs_revision rejection was counted as a failed
    // outcome, and the eventual completion as a completed one — the member's
    // record honestly shows one of each.
    const stats = board.getMemberStats();
    const engineer = stats.get('engineer');
    expect(engineer?.ticketsFailed).toBe(1);
    expect(engineer?.ticketsCompleted).toBe(1);
    expect(engineer?.ticketsOrphaned).toBe(0);

    board.close();
  });
});
