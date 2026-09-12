import { KanbanStore, renderOperatorContext, type Task } from '@ethosagent/kanban-store';
import type { SessionLane } from '@ethosagent/session-lane';
import { type AgentEvent, answerSuffix } from '@ethosagent/types';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_STALENESS_THRESHOLD_MS = 1_800_000;

/**
 * Discount a pause from the board's staleness clocks (gates #6/#7 of
 * plan/phases/clock-tolerance-pass.md), returning the number of rows corrected.
 *
 * Lives here rather than in `serve.ts` because this file owns both halves of the
 * problem: `DEFAULT_STALENESS_THRESHOLD_MS` above is the 30-minute window a
 * resumed process would otherwise blow straight through, and `tick()` below is
 * what would then reclaim a healthy task and burn a retry against its
 * `max_retries` budget. Opened and closed per call, exactly as `tick()` does —
 * the loop reopens the board every interval, so there is no long-lived handle to
 * reuse and holding one across a pause would add a second writer.
 */
export function bumpKanbanHeartbeats(boardPath: string, pauseDurationMs: number): number {
  const store = new KanbanStore(boardPath);
  try {
    return store.bumpActiveHeartbeats(pauseDurationMs);
  } finally {
    store.close();
  }
}

export interface KanbanPollConfig {
  /** Path to the board SQLite file. */
  boardPath: string;
  /** Personality ID to match against `assignee`. */
  personalityId: string;
  /** SessionLane to enqueue stimuli through. */
  lane: SessionLane;
  /**
   * Runner to execute the stimulus prompt. `runId` is the run this loop's claim
   * opened — pass it to `writeRunActivityComments` so it heartbeats only that run.
   */
  runner: (
    prompt: string,
    sessionKey: string,
    taskId: string,
    taskTitle: string,
    runId: string,
  ) => Promise<void>;
  /** Poll interval. Default 5000ms. */
  intervalMs?: number;
  /** Optional error callback. */
  onError?: (err: Error) => void;
}

export class KanbanPollLoop {
  private readonly cfg: Required<
    Pick<KanbanPollConfig, 'boardPath' | 'personalityId' | 'intervalMs'>
  > &
    KanbanPollConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(config: KanbanPollConfig) {
    this.cfg = {
      ...config,
      intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.cfg.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.cfg.intervalMs);
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const store = new KanbanStore(this.cfg.boardPath);
    try {
      // Housekeeping — idempotent, safe to run from multiple serves
      store.promoteReady('poll-housekeeping');
      store.promoteScheduled(Date.now(), 'poll-housekeeping');
      store.rollupCompletedGoals('poll-housekeeping');

      // Reclaim stale running tasks
      for (const task of store.findStaleRunningTasks(DEFAULT_STALENESS_THRESHOLD_MS)) {
        try {
          store.reclaimTask(task.id, 'orphan_stale', 'poll-housekeeping');
        } catch {
          // Race: another writer handled it
        }
      }

      // Check for ready tasks assigned to this personality
      const readyTasks = store
        .listTasks({ status: 'ready' })
        .filter((t) => t.assignee === this.cfg.personalityId);

      for (const task of readyTasks) {
        // Atomically claim ready -> running before dispatch. This both moves the
        // task into progress and prevents the next tick from re-notifying it
        // (the status filter is 'ready'). If another writer already claimed it,
        // skip gracefully.
        let claimed: Task;
        try {
          claimed = store.updateStatus(
            task.id,
            'running',
            'claimed via poll dispatch',
            this.cfg.personalityId,
          );
        } catch (err) {
          this.cfg.onError?.(err instanceof Error ? err : new Error(String(err)));
          continue;
        }
        // A re-claim past the retry budget lands `failed` with no run
        // (`updateStatus`'s budgetExhausted branch) — nothing to run.
        const runId = claimed.status === 'running' ? claimed.currentRunId : null;
        if (runId === null) continue;

        // Each claim runs in a fresh session, so what the operator has said on
        // the ticket since (answers to a kanban_block question) rides in the
        // prompt — see renderOperatorContext.
        const operatorContext = renderOperatorContext(
          store.listComments(task.id),
          store.listRuns(task.id),
        );
        const prompt =
          `You have been assigned kanban task ${task.id}: "${task.title}". ${task.body}\n` +
          'The task is now in progress (running). Use your tools to complete the work. ' +
          'When finished, call kanban_complete with a short summary. ' +
          'If you are blocked, call kanban_block with the reason. ' +
          'For long-running work, call kanban_heartbeat periodically.' +
          (operatorContext ? `\n\n${operatorContext}` : '');
        const sessionKey = `poll:kanban:${task.id}:${Date.now()}`;
        void this.cfg.lane.enqueue(async () => {
          await this.cfg.runner(prompt, sessionKey, task.id, task.title, runId).catch((err) => {
            this.cfg.onError?.(err instanceof Error ? err : new Error(String(err)));
          });
        });
      }
    } finally {
      store.close();
    }
  }
}

const ARG_PREVIEW_CAP = 500;
const ERROR_CAP = 500;
/**
 * Period of the automatic heartbeat `writeRunActivityComments` writes while it
 * consumes a run's event stream. Agents rarely call `kanban_heartbeat`
 * themselves, and the supervisor `Dispatcher` reclaims a `running` task whose
 * `updated_at` is older than `stalenessThresholdMs` (5 min default,
 * `findStaleRunningTasks`) and blocks a run whose `last_heartbeat_at` is older
 * than `staleMs` (90 s default, `findStalledRuns`) — `heartbeatRun` bumps both
 * columns. Must stay below the smaller of the two.
 */
export const AUTO_HEARTBEAT_INTERVAL_MS = 60_000;

function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/**
 * Drive an agent event stream, writing the agent's activity into the task as
 * comments authored by `author` (the personalityId). Opens one short-lived
 * KanbanStore for the whole run and closes it in a finally — the poll loop's
 * own store is already closed by the time the runner executes, so the runner
 * MUST open its own handle keyed by boardPath. WAL allows concurrent writers.
 * Each comment write is wrapped so a write failure never aborts the run.
 *
 * While the stream is being consumed, the task's run is heartbeated once
 * immediately and then every `AUTO_HEARTBEAT_INTERVAL_MS` on a timer — not per
 * event, because one tool call can run silent for many minutes (GEO's `geo_run`
 * makes many paid engine calls inside a single call) and must not be reclaimed
 * mid-call. Only while the task's current run is still `runId`, the run this
 * runner's claim opened: once the agent ends it (`kanban_complete` /
 * `kanban_block`) or it is reclaimed and re-claimed, heartbeating would keep
 * somebody else's run alive, so the timer stops for good. The timer is
 * `unref()`d and cleared in the `finally`.
 *
 * Limitation: this heartbeat proves the process is alive and still inside this
 * run, not that the turn is progressing. A turn that hangs forever inside the
 * stream is heartbeated for as long as it hangs; the board's staleness gates
 * catch a dead process, not a stuck one.
 */
export async function writeRunActivityComments(
  boardPath: string,
  taskId: string,
  runId: string,
  author: string,
  events: AsyncIterable<AgentEvent>,
  onError?: (err: Error) => void,
): Promise<void> {
  const store = new KanbanStore(boardPath);
  const addComment = (body: string): void => {
    try {
      store.addComment(taskId, author, body);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  const heartbeat = (): void => {
    try {
      if (store.getTask(taskId)?.currentRunId !== runId) {
        stopHeartbeat();
        return;
      }
      store.heartbeatRun(taskId, 'auto: agent active', author);
    } catch (err) {
      // The run ended between the check and the write (the agent closed it
      // mid-stream) — `heartbeatRun` throws "no open run" for exactly that.
      if (err instanceof Error && err.message.startsWith('no open run')) {
        stopHeartbeat();
        return;
      }
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };
  try {
    heartbeatTimer = setInterval(heartbeat, AUTO_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
    heartbeat();
    let finalText = '';
    for await (const event of events) {
      if (event.type === 'text_delta') {
        finalText += event.text;
      } else if (event.type === 'tool_start') {
        const argsJson = (() => {
          try {
            return JSON.stringify(event.args);
          } catch {
            return '';
          }
        })();
        addComment(`🔧 ${event.toolName}(${truncate(argsJson, ARG_PREVIEW_CAP)})`);
      } else if (event.type === 'error') {
        addComment(`⚠️ error: ${truncate(event.error, ERROR_CAP)}`);
      } else if (event.type === 'done') {
        // A `returnDirect` tool's answer arrives only as `done.text`, after any
        // preamble that streamed: the comment carries the whole reply
        // (`answerSuffix`, @ethosagent/types).
        finalText += answerSuffix(finalText, event.text);
      }
    }
    const trimmed = finalText.trim();
    if (trimmed.length > 0) {
      addComment(trimmed);
    }
  } finally {
    stopHeartbeat();
    store.close();
  }
}
