import type {
  CreateGoalInput,
  Goal,
  GoalAttempt,
  GoalEvent,
  GoalEventType,
  GoalStatus,
  GoalStore,
} from '@ethosagent/types';
import type { GoalExecutor } from '../goals.service';

/**
 * Map-backed `GoalStore` for GoalsService tests — no SQLite. Mirrors the
 * `SQLiteGoalStore` defaults these tests observe: a new goal starts `running`
 * with `maxAttempts` 3, and events carry a per-goal `seq` starting at 1
 * (extensions/goal-store/src/index.ts `create` / `appendEvent`).
 */
export class InMemoryGoalStore implements GoalStore {
  private goals = new Map<string, Goal>();
  private events = new Map<string, GoalEvent[]>();
  private attempts = new Map<string, GoalAttempt[]>();
  private nextGoalId = 1;
  private nextRowId = 1;

  create(input: CreateGoalInput): Goal {
    const goal: Goal = {
      id: `goal-${this.nextGoalId++}`,
      userId: input.userId,
      personalityId: input.personalityId,
      origin: input.origin,
      sourceSession: input.sourceSession ?? null,
      title: input.title,
      goalText: input.goalText,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      planMd: null,
      status: 'running',
      maxAttempts: input.maxAttempts ?? 3,
      maxCostUsd: input.maxCostUsd ?? null,
      deadline: input.deadline ?? null,
      outputMd: null,
      outputPartial: null,
      errorText: null,
      startedAt: Date.now(),
      completedAt: null,
      resumeCount: 0,
      turnCount: null,
      toolCount: null,
      tokenCount: null,
      costUsd: null,
    };
    this.goals.set(goal.id, goal);
    return goal;
  }

  get(id: string): Goal | null {
    return this.goals.get(id) ?? null;
  }

  list(opts?: { userId?: string; status?: GoalStatus; limit?: number }): Goal[] {
    const rows = [...this.goals.values()].filter(
      (g) =>
        (opts?.userId === undefined || g.userId === opts.userId) &&
        (opts?.status === undefined || g.status === opts.status),
    );
    return opts?.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  }

  updateStatus(id: string, status: GoalStatus, extra?: Partial<Goal>): void {
    const goal = this.goals.get(id);
    if (goal) this.goals.set(id, { ...goal, ...extra, status });
  }

  appendEvent(goalId: string, eventType: GoalEventType, payload: Record<string, unknown>): void {
    const list = this.events.get(goalId) ?? [];
    list.push({
      id: this.nextRowId++,
      goalId,
      seq: list.length + 1,
      eventType,
      payload,
      createdAt: Date.now(),
    });
    this.events.set(goalId, list);
  }

  getEvents(goalId: string): GoalEvent[] {
    return [...(this.events.get(goalId) ?? [])];
  }

  saveAttempt(attempt: Omit<GoalAttempt, 'id'>): GoalAttempt {
    const row: GoalAttempt = { ...attempt, id: `attempt-${this.nextRowId++}` };
    this.attempts.set(attempt.goalId, [...(this.attempts.get(attempt.goalId) ?? []), row]);
    return row;
  }

  updateAttempt(goalId: string, n: number, patch: Partial<GoalAttempt>): void {
    const list = this.attempts.get(goalId) ?? [];
    this.attempts.set(
      goalId,
      list.map((a) => (a.n === n ? { ...a, ...patch } : a)),
    );
  }

  getAttempts(goalId: string): GoalAttempt[] {
    return [...(this.attempts.get(goalId) ?? [])];
  }

  incrementResumeCount(id: string): void {
    const goal = this.goals.get(id);
    if (goal) this.goals.set(id, { ...goal, resumeCount: goal.resumeCount + 1 });
  }
}

/** A `GoalExecutor` that records which goal ids it was asked to run. */
export function recordingExecutor(opts: { canExecute: boolean }): GoalExecutor & {
  started: string[];
} {
  const started: string[] = [];
  return {
    started,
    canExecute: () => opts.canExecute,
    startGoal: async (goalId) => {
      started.push(goalId);
    },
    steer: () => true,
    cancel: () => true,
    resume: async () => true,
  };
}
