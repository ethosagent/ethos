import type { KanbanStore, Task } from '@ethosagent/kanban-store';
import type { MemberRuntime } from './runtime';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Minimal supervisor view the dispatcher needs.
 *
 * Production wiring passes the real `Map<personality, MemberState>` from
 * `runSupervisor`; tests pass a small mock.
 */
export interface SupervisorState {
  /** Port the assignee personality is listening on (`null` if unknown). */
  portOf(personality: string): number | null;
  /** Lifecycle status for the assignee process. Only `running` is dispatchable. */
  statusOf(personality: string): MemberRuntime['status'] | null;
}

/**
 * Sends a one-shot prompt to a peer agent's `/rpc` endpoint. Mirrors
 * `callMeshAgent` from `tools-delegation` but exposed for the dispatcher,
 * which fires outside any agent turn. Injected so tests can substitute a stub.
 */
export type DispatchCall = (args: {
  host: string;
  port: number;
  prompt: string;
  personalityId: string;
  signal: AbortSignal;
}) => Promise<string>;

export interface DispatcherOptions {
  board: KanbanStore;
  supervisor: SupervisorState;
  /** Dispatch transport. Defaults to {@link defaultDispatchCall}. */
  dispatch?: DispatchCall;
  /**
   * Heartbeat threshold. A task whose open run hasn't heartbeated in this many
   * milliseconds gets marked `blocked` ("stalled — no heartbeat"). Default: 90 s.
   */
  staleMs?: number;
  /** Loop cadence for the polling fallback. Default 1 s. */
  pollMs?: number;
  /**
   * Per-dispatch timeout. A fetch that hasn't resolved in this many ms gets
   * aborted and the task is marked `blocked`. Without this, a hung worker
   * would leak an in-flight HTTP request indefinitely while the stale-heartbeat
   * reclaim runs alongside it (two outcomes racing for the same run). Default:
   * 300 s — generous enough to cover normal agent turns, tight enough that
   * crashed transports drain inside a few minutes.
   */
  dispatchTimeoutMs?: number;
  /** Optional callback fired on every dispatch error (logging hook). */
  onError?: (err: Error, taskId: string) => void;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const DEFAULT_STALE_MS = 90_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 300_000;
const DISPATCH_HOST = 'localhost';

export class Dispatcher {
  private readonly board: KanbanStore;
  private readonly supervisor: SupervisorState;
  private readonly dispatch: DispatchCall;
  private readonly staleMs: number;
  private readonly pollMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly onError: (err: Error, taskId: string) => void;
  private readonly inflight = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: DispatcherOptions) {
    this.board = opts.board;
    this.supervisor = opts.supervisor;
    this.dispatch = opts.dispatch ?? defaultDispatchCall;
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.dispatchTimeoutMs = opts.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    this.onError = opts.onError ?? (() => {});
  }

  /**
   * Run one full cycle: promote ready/scheduled, reclaim stalled, dispatch
   * ready-with-assignee. Exposed so tests can drive the dispatcher
   * deterministically. The polling loop is just `tick()` on a setInterval.
   */
  async tick(): Promise<void> {
    // 1. Promote — parents-done and scheduled-time-passed both unblock work.
    this.board.promoteReady();
    this.board.promoteScheduled();
    // 1a. Roll up goals whose children have all finished. Closes the "Q3
    //     roadmap sits at ready forever after every sub-task completes" hole.
    this.board.rollupCompletedGoals('dispatcher');

    // 2. Reclaim — any run with a stale heartbeat is treated as the worker
    //    crashing. We mark the task `blocked` so a human (or a future reassign)
    //    can decide next step. The run row is closed atomically by `blockRun`.
    for (const stalled of this.board.findStalledRuns(this.staleMs)) {
      try {
        this.board.blockRun(stalled.taskId, 'stalled — no heartbeat');
      } catch {
        // Race: another writer ended the run between our read and our write.
        // Acceptable — they handled it, we don't double-process.
      }
    }

    // 3. Dispatch — claim each ready+assigned task and POST it to the assignee.
    //    The claim (status flip + open run + current_run_id) happens via
    //    updateStatus(running). If the assignee isn't reachable, we mark the
    //    task blocked so it surfaces on the board instead of disappearing.
    for (const task of this.board.findReadyToDispatch()) {
      if (this.inflight.has(task.id)) continue; // already in-flight from a prior tick
      const assignee = task.assignee;
      if (assignee === null) continue;
      const port = this.supervisor.portOf(assignee);
      const status = this.supervisor.statusOf(assignee);
      if (port === null || status !== 'running') continue;

      // Claim atomically; if a concurrent claim already moved it to running,
      // findReadyToDispatch wouldn't have returned it — still, guard.
      try {
        this.board.updateStatus(task.id, 'running', 'dispatched', 'dispatcher');
      } catch {
        continue;
      }

      const controller = new AbortController();
      this.inflight.set(task.id, controller);
      void this.fireDispatch(task, assignee, port, controller).finally(() => {
        this.inflight.delete(task.id);
      });
    }
  }

  /** Start the polling loop. Safe to call once; no-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.onError(err as Error, 'tick');
      }
      this.timer = setTimeout(loop, this.pollMs);
    };
    void loop();
  }

  /**
   * Stop the polling loop and abort any in-flight HTTP calls. The runs they
   * left open stay `running` on disk — the reclaim path picks them up on
   * supervisor restart once their heartbeats go stale.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const controller of this.inflight.values()) {
      controller.abort();
    }
    this.inflight.clear();
  }

  private async fireDispatch(
    task: Task,
    assignee: string,
    port: number,
    controller: AbortController,
  ): Promise<void> {
    const prompt = renderTaskPrompt(task);

    // Per-dispatch timeout so a hung transport doesn't outlive its task. Without
    // this, the stale-heartbeat reclaim path could mark the task `blocked` while
    // an in-flight fetch is still running — two outcomes racing for one run.
    const timer = setTimeout(() => {
      controller.abort(new Error(`dispatch timeout after ${this.dispatchTimeoutMs}ms`));
    }, this.dispatchTimeoutMs);

    try {
      await this.dispatch({
        host: DISPATCH_HOST,
        port,
        prompt,
        personalityId: assignee,
        signal: controller.signal,
      });
      // We do not auto-complete here — the assignee is responsible for calling
      // `kanban_complete` / `kanban_block` to record the outcome on the board.
    } catch (err) {
      // Graceful-shutdown aborts skip the block-write. Timeout-driven aborts
      // (signal.reason is an Error from our setTimeout above) flow through the
      // failure path so the task ends up `blocked` with a clear reason.
      const reason = controller.signal.reason;
      const timedOut = reason instanceof Error && /dispatch timeout/.test(reason.message);
      if (controller.signal.aborted && !timedOut) return;

      const error = timedOut
        ? (reason as Error)
        : err instanceof Error
          ? err
          : new Error(String(err));
      this.onError(error, task.id);
      try {
        this.board.blockRun(task.id, `dispatch failed: ${error.message}`);
      } catch {
        /* run may already be ended */
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

// Known limitation: this prompt assumes the assignee personality has
// kanban_complete / kanban_block / kanban_heartbeat in its toolset. The role
// gate would block the call if they DO have the tools but aren't the assignee;
// it doesn't help if the tools are absent entirely. Teams must add the kanban
// closer-tools to every member personality that can be assigned work. A future
// pass should validate this at `ethos team start` time, loading each member's
// toolset and refusing to boot when a closer-tool is missing.
function renderTaskPrompt(task: Task): string {
  const lines = [
    `## Task ${task.id}: ${task.title}`,
    '',
    task.body || '(no body)',
    '',
    `When you finish, call \`kanban_complete\` with a one-line summary.`,
    `If you get stuck, call \`kanban_block\` with the reason.`,
    `Heartbeat with \`kanban_heartbeat\` if the work takes longer than a minute.`,
    `Task id: \`${task.id}\` — pass this exact id to the kanban tools.`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Default HTTP transport — mirrors callMeshAgent in tools-delegation
// ---------------------------------------------------------------------------

export const defaultDispatchCall: DispatchCall = async ({
  host,
  port,
  prompt,
  personalityId,
  signal,
}) => {
  const base = `http://${host}:${port}/rpc`;

  const sessionRes = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'new_session',
      params: { personalityId },
    }),
    signal,
  });
  if (!sessionRes.ok) {
    throw new Error(`new_session failed: HTTP ${sessionRes.status} ${sessionRes.statusText}`);
  }
  const sessionData = (await sessionRes.json()) as {
    result?: { sessionKey?: string };
    error?: unknown;
  };
  if (sessionData.error) {
    throw new Error(`new_session RPC error: ${JSON.stringify(sessionData.error)}`);
  }
  const sessionKey = sessionData.result?.sessionKey;
  if (typeof sessionKey !== 'string') {
    throw new Error('new_session returned no sessionKey');
  }

  const promptRes = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompt',
      params: { sessionKey, prompt },
    }),
    signal,
  });
  if (!promptRes.ok) {
    throw new Error(`prompt failed: HTTP ${promptRes.status} ${promptRes.statusText}`);
  }
  const promptData = (await promptRes.json()) as { result?: { text?: string }; error?: unknown };
  if (promptData.error) {
    throw new Error(`dispatch RPC error: ${JSON.stringify(promptData.error)}`);
  }
  return promptData.result?.text ?? '';
};
