import type { GoalStore } from '@ethosagent/types';
import type { LoopGoals } from './goal-slash';

/**
 * A goal pair for a host that builds its web API before any agent loop exists
 * (onboarding-mode `ethos serve`). Until `bind` receives the booted loop's own
 * pair it cannot execute and reads empty, so GoalsService refuses create/resume
 * exactly as it does with no backend; afterwards every call goes to that pair.
 * Pinned by lib/__tests__/late-goals.test.ts.
 */
export function createLateBoundGoals(): {
  goals: LoopGoals;
  bind(pair: LoopGoals): void;
  /** Back to "not booted" — for a boot whose adoption failed (lib/onboarding-boot.ts). */
  unbind(): void;
} {
  let pair: LoopGoals | undefined;
  const bound = (): LoopGoals => {
    // Writes before the boot are unreachable through GoalsService, which checks
    // `canExecute()` (false until bound) before it writes anything.
    if (!pair) throw new Error('goal backend is not booted yet');
    return pair;
  };

  const store: GoalStore = {
    create: (input) => bound().store.create(input),
    get: (id) => pair?.store.get(id) ?? null,
    list: (opts) => pair?.store.list(opts) ?? [],
    updateStatus: (id, status, extra) => bound().store.updateStatus(id, status, extra),
    appendEvent: (goalId, type, payload) => bound().store.appendEvent(goalId, type, payload),
    getEvents: (goalId) => pair?.store.getEvents(goalId) ?? [],
    saveAttempt: (attempt) => bound().store.saveAttempt(attempt),
    updateAttempt: (goalId, n, patch) => bound().store.updateAttempt(goalId, n, patch),
    getAttempts: (goalId) => pair?.store.getAttempts(goalId) ?? [],
    incrementResumeCount: (id) => bound().store.incrementResumeCount(id),
  };

  return {
    goals: {
      store,
      executor: {
        canExecute: () => pair?.executor.canExecute() ?? false,
        startGoal: (goalId) => bound().executor.startGoal(goalId),
        steer: (goalId, message) => pair?.executor.steer(goalId, message) ?? false,
        cancel: (goalId) => pair?.executor.cancel(goalId) ?? false,
        resume: (goalId) => bound().executor.resume(goalId),
      },
    },
    bind: (next) => {
      pair = next;
    },
    unbind: () => {
      pair = undefined;
    },
  };
}
