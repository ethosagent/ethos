import { join } from 'node:path';
import { classifyGoal, GoalRunner } from '@ethosagent/goal-runner';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import type { Goal, GoalAttempt, GoalEvent } from '@ethosagent/types';

export interface GoalsServiceOptions {
  dataDir: string;
}

export class GoalsService {
  private store: SQLiteGoalStore;
  private runner: GoalRunner;

  constructor(opts: GoalsServiceOptions) {
    this.store = new SQLiteGoalStore(join(opts.dataDir, 'goals.db'));
    this.runner = new GoalRunner({ store: this.store });
    this.runner.recoverOrphans();
  }

  async get(id: string): Promise<{ goal: Goal; events: GoalEvent[]; attempts: GoalAttempt[] }> {
    const goal = this.store.get(id);
    if (!goal) throw new Error(`Goal not found: ${id}`);
    const events = this.store.getEvents(id);
    const attempts = this.store.getAttempts(id);
    return { goal, events, attempts };
  }

  async list(opts?: { status?: string; limit?: number }): Promise<{ goals: Goal[] }> {
    const goals = this.store.list(opts as Parameters<SQLiteGoalStore['list']>[0]);
    return { goals };
  }

  async steer(id: string, message: string): Promise<{ ok: boolean }> {
    return { ok: this.runner.steer(id, message) };
  }

  async cancel(id: string): Promise<{ ok: boolean }> {
    return { ok: this.runner.cancel(id) };
  }

  async resume(id: string): Promise<{ ok: boolean }> {
    return { ok: await this.runner.resume(id) };
  }

  async classify(message: string) {
    return classifyGoal(message);
  }
}
