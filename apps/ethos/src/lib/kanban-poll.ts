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
        const prompt =
          `You have been notified: kind=kanban. ref=${task.id}. ` +
          'Use your tools to check the relevant state and act on this notification.';
        const sessionKey = `poll:kanban:${task.id}:${Date.now()}`;
        void this.cfg.lane.enqueue(async () => {
          await this.cfg.runner(prompt, sessionKey).catch(() => {});
        });
      }
    } finally {
      store.close();
    }
  }
}
