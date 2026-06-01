// FW-13 — BackgroundRunner
// Runs agent turns in the background while the foreground REPL stays responsive.

import { randomBytes } from 'node:crypto';
import type { AgentLoop } from '@ethosagent/core';

export interface BackgroundTask {
  id: string;
  prompt: string;
  sessionKey: string;
  startedAt: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  result?: string;
  error?: string;
}

export interface BackgroundRunnerOptions {
  maxConcurrent?: number;
}

export class BackgroundRunner {
  private readonly maxConcurrent: number;
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly handlers: Array<(task: BackgroundTask) => void> = [];

  constructor(options?: BackgroundRunnerOptions) {
    this.maxConcurrent = options?.maxConcurrent ?? 4;
  }

  /**
   * Spawns a background agent turn. Returns a BackgroundTask immediately.
   * Throws with code BACKGROUND_QUEUE_FULL when maxConcurrent tasks are running.
   */
  run(prompt: string, loop: AgentLoop, sessionKey?: string): BackgroundTask {
    const running = [...this.tasks.values()].filter((t) => t.status === 'running');
    if (running.length >= this.maxConcurrent) {
      throw Object.assign(new Error('BACKGROUND_QUEUE_FULL'), { code: 'BACKGROUND_QUEUE_FULL' });
    }

    const now = Date.now();
    const suffix = randomBytes(3).toString('hex');
    const id = `bg_${now % 1_000_000_000}_${suffix}`;
    const key = sessionKey ?? `bg:${now}:${suffix}`;

    const task: BackgroundTask = {
      id,
      prompt,
      sessionKey: key,
      startedAt: now,
      status: 'running',
    };

    this.tasks.set(id, task);

    const controller = new AbortController();
    this.controllers.set(id, controller);

    void this.executeTask(task, loop, controller.signal);

    return task;
  }

  /** Abort a running task. Returns true if the task was found and cancelled. */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (task?.status !== 'running') return false;

    const controller = this.controllers.get(taskId);
    if (controller) {
      controller.abort();
    }
    return true;
  }

  /** All tasks, including completed ones. */
  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  /** Look up a task by id. */
  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Register a completion handler. Fires when a task transitions to `done` or
   * `error`. Returns a cleanup function to deregister.
   */
  onComplete(handler: (task: BackgroundTask) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async executeTask(
    task: BackgroundTask,
    loop: AgentLoop,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      let finalText = '';
      for await (const event of loop.run(task.prompt, {
        sessionKey: task.sessionKey,
        abortSignal: signal,
      })) {
        if (signal.aborted) break;
        const e = event as { type: string; text?: string };
        if (e.type === 'done' && e.text !== undefined) {
          finalText = e.text;
        }
      }

      if (signal.aborted) {
        task.status = 'cancelled';
      } else {
        task.status = 'done';
        task.result = finalText;
        this.fireComplete(task);
      }
    } catch (err) {
      if (signal.aborted) {
        task.status = 'cancelled';
      } else {
        task.status = 'error';
        task.error = err instanceof Error ? err.message : String(err);
        this.fireComplete(task);
      }
    } finally {
      this.controllers.delete(task.id);
    }
  }

  private fireComplete(task: BackgroundTask): void {
    for (const handler of [...this.handlers]) {
      handler(task);
    }
  }
}
