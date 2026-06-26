import { KanbanStore } from '@ethosagent/kanban-store';
import type { SessionLane } from '@ethosagent/session-lane';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_STALENESS_THRESHOLD_MS = 300_000;

export interface KanbanPollConfig {
  /** Path to the board SQLite file. */
  boardPath: string;
  /** Personality ID to match against `assignee`. */
  personalityId: string;
  /** SessionLane to enqueue stimuli through. */
  lane: SessionLane;
  /** Runner to execute the stimulus prompt. */
  runner: (prompt: string, sessionKey: string) => Promise<void>;
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
        try {
          store.updateStatus(
            task.id,
            'running',
            'claimed via poll dispatch',
            this.cfg.personalityId,
          );
        } catch (err) {
          this.cfg.onError?.(err instanceof Error ? err : new Error(String(err)));
          continue;
        }

        const prompt =
          `You have been assigned kanban task ${task.id}: "${task.title}". ${task.body}\n` +
          'The task is now in progress (running). Use your tools to complete the work. ' +
          'When finished, call kanban_complete with a short summary. ' +
          'If you are blocked, call kanban_block with the reason. ' +
          'For long-running work, call kanban_heartbeat periodically.';
        const sessionKey = `poll:kanban:${task.id}:${Date.now()}`;
        void this.cfg.lane.enqueue(async () => {
          await this.cfg.runner(prompt, sessionKey).catch((err) => {
            this.cfg.onError?.(err instanceof Error ? err : new Error(String(err)));
          });
        });
      }
    } finally {
      store.close();
    }
  }
}
