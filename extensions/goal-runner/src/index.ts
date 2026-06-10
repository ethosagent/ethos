import type { GoalStore } from '@ethosagent/types';
import { isConverged, judge } from './judge';
import { buildRetryContext, classifyFailure } from './retry-context';

export { type ClassificationResult, classifyGoal, prefilterGoal } from './intake-classifier';
export { isConverged, judge } from './judge';
export { buildRetryContext, classifyFailure, type RetryStrategy } from './retry-context';

export interface GoalRunnerConfig {
  store: GoalStore;
  maxTurnsSafetyValve?: number;
}

export class GoalRunner {
  private store: GoalStore;
  private maxTurnsSafetyValve: number;
  private activeRuns = new Map<string, AbortController>();

  constructor(config: GoalRunnerConfig) {
    this.store = config.store;
    this.maxTurnsSafetyValve = config.maxTurnsSafetyValve ?? 100;
  }

  /**
   * Start a goal run. In a full implementation, this orchestrates AgentLoop.run()
   * in a per-attempt session. Phase 1 stores the structural record and transitions
   * status; the actual agent-loop integration arrives in the wiring phase.
   */
  async startGoal(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    if (goal.status !== 'running') return;

    const controller = new AbortController();
    this.activeRuns.set(goalId, controller);

    this.store.appendEvent(goalId, 'run_start', {
      attemptN: 1,
      sessionKey: `goal:${goalId}:attempt-1`,
    });
  }

  /**
   * Submit a steer message to a running goal.
   */
  steer(goalId: string, message: string): boolean {
    const goal = this.store.get(goalId);
    if (goal?.status !== 'running') return false;

    this.store.appendEvent(goalId, 'steer', {
      message,
      timestamp: Date.now(),
    });
    return true;
  }

  /**
   * Cancel a running goal.
   */
  cancel(goalId: string): boolean {
    const goal = this.store.get(goalId);
    if (!goal) return false;
    if (goal.status !== 'running' && goal.status !== 'judging' && goal.status !== 'retrying') {
      return false;
    }

    const controller = this.activeRuns.get(goalId);
    if (controller) {
      controller.abort();
      this.activeRuns.delete(goalId);
    }

    this.store.updateStatus(goalId, 'cancelled');
    return true;
  }

  /**
   * Resume a failed/cancelled/interrupted goal.
   */
  async resume(goalId: string): Promise<boolean> {
    const goal = this.store.get(goalId);
    if (!goal) return false;
    if (goal.status !== 'failed' && goal.status !== 'cancelled' && goal.status !== 'interrupted') {
      return false;
    }

    this.store.incrementResumeCount(goalId);
    this.store.updateStatus(goalId, 'running');
    await this.startGoal(goalId);
    return true;
  }

  /**
   * Judge an attempt's output against the acceptance criteria.
   * Returns whether the goal converged.
   */
  async judgeAttempt(goalId: string, attemptN: number, output: string): Promise<boolean> {
    const goal = this.store.get(goalId);
    if (!goal) return false;

    const spec = goal.acceptanceCriteria;
    if (!spec) {
      this.store.updateStatus(goalId, 'completed', {
        outputMd: output,
        completedAt: Date.now(),
      });
      return true;
    }

    this.store.updateStatus(goalId, 'judging');
    const verdict = await judge({ output, spec });

    const attempts = this.store.getAttempts(goalId);
    const currentAttempt = attempts.find((a) => a.n === attemptN);
    if (currentAttempt) {
      const { id: _id, ...attemptWithoutId } = currentAttempt;
      this.store.saveAttempt({
        ...attemptWithoutId,
        verdict,
        outputMd: output,
        completedAt: Date.now(),
      });
    }

    if (isConverged(verdict, spec.threshold)) {
      this.store.updateStatus(goalId, 'completed', {
        outputMd: output,
        completedAt: Date.now(),
      });
      this.store.appendEvent(goalId, 'done', {
        score: verdict.score,
        attemptN,
      });
      return true;
    }

    if (attemptN >= goal.maxAttempts) {
      this.store.updateStatus(goalId, 'exhausted', {
        outputPartial: output,
      });
      return false;
    }

    if (attempts.length >= 2) {
      const prevScores = attempts.slice(-2).map((a) => a.verdict?.score ?? 0);
      if (prevScores.every((s) => s >= verdict.score)) {
        this.store.updateStatus(goalId, 'exhausted', {
          outputPartial: output,
        });
        return false;
      }
    }

    this.store.appendEvent(goalId, 'complete_rejected', {
      score: verdict.score,
      gaps: verdict.perCriterion.filter((c) => c.gap).map((c) => c.gap),
    });
    this.store.updateStatus(goalId, 'retrying');

    return false;
  }

  /**
   * Recover orphaned goals on boot.
   */
  recoverOrphans(): void {
    const runningGoals = this.store.list({ status: 'running' });
    const judgingGoals = this.store.list({ status: 'judging' });
    const retryingGoals = this.store.list({ status: 'retrying' });

    for (const goal of [...runningGoals, ...judgingGoals, ...retryingGoals]) {
      if (!this.activeRuns.has(goal.id)) {
        this.store.updateStatus(goal.id, 'interrupted');
      }
    }
  }

  /**
   * Get the retry context for the next attempt.
   */
  getRetryContext(goalId: string): string | null {
    const goal = this.store.get(goalId);
    if (!goal) return null;

    const spec = goal.acceptanceCriteria;
    if (!spec) return null;

    const attempts = this.store.getAttempts(goalId);
    const lastAttempt = attempts[attempts.length - 1];
    if (!lastAttempt?.verdict) return null;

    const strategy = classifyFailure(attempts, lastAttempt.verdict);

    return buildRetryContext({
      goalText: goal.goalText,
      spec,
      attempts,
      latestVerdict: lastAttempt.verdict,
      strategy,
    });
  }
}
