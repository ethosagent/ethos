import type { GoalStore } from '@ethosagent/types';

/**
 * A loop's goal store and the executor `createAgentLoop` built with it
 * (`CreateAgentLoopResult.goals`) — what `ethos chat`'s `/goal` drives (threaded
 * through `resolveActiveLoop`) and what onboarding serve late-binds
 * (lib/late-goals.ts). Structural so apps/ethos never names the concrete
 * runner; `GoalRunner` satisfies it. Borrowed — never closed here.
 */
export interface LoopGoals {
  store: GoalStore;
  executor: {
    /** `GoalRunner.canExecute`: true only when a loop-bearing `runAttempt` is wired. */
    canExecute(): boolean;
    startGoal(goalId: string): Promise<void>;
    steer(goalId: string, message: string): boolean;
    cancel(goalId: string): boolean;
    resume(goalId: string): Promise<boolean>;
  };
}

export interface GoalSlashDeps {
  goals: LoopGoals;
  personalityId: string;
  out: (s: string) => void;
  c: { reset: string; dim: string; green: string; red: string; yellow: string };
}

/** Refusal printed instead of creating (or resuming) a goal nothing would run. */
export const GOAL_EXECUTION_UNAVAILABLE =
  'Goal execution is not available in this session — nothing would run the goal.';

/**
 * `/goal <text>` and `/goal cancel|resume|steer <id> [message]`. Create and
 * resume check `canExecute()` first and refuse without touching the store, so
 * a goal is never left `running` with nothing executing it — the same rule as
 * apps/web-api `GoalsService.requireExecution`. Pinned by
 * lib/__tests__/goal-slash.test.ts.
 */
export async function runGoalSlash(arg: string, deps: GoalSlashDeps): Promise<void> {
  const { goals, out, c } = deps;
  if (!arg) {
    out(
      `${c.dim}Usage: /goal <description> | /goal cancel|resume|steer <id> [message]${c.reset}\n`,
    );
    return;
  }
  const subParts = arg.split(/\s+/);
  const sub = subParts[0]?.toLowerCase();

  if (sub === 'cancel' || sub === 'resume' || sub === 'steer') {
    const goalId = subParts[1];
    if (!goalId) {
      out(`${c.yellow}Usage: /goal ${sub} <goal-id>${c.reset}\n`);
      return;
    }
    if (sub === 'cancel') {
      const ok = goals.executor.cancel(goalId);
      out(
        ok
          ? `${c.green}Goal cancelled.${c.reset}\n`
          : `${c.yellow}Cannot cancel goal ${goalId}.${c.reset}\n`,
      );
    } else if (sub === 'resume') {
      if (!goals.executor.canExecute()) {
        out(`${c.red}${GOAL_EXECUTION_UNAVAILABLE}${c.reset}\n`);
        return;
      }
      const ok = await goals.executor.resume(goalId);
      out(
        ok
          ? `${c.green}Goal resumed.${c.reset}\n`
          : `${c.yellow}Cannot resume goal ${goalId}.${c.reset}\n`,
      );
    } else {
      const msg = subParts.slice(2).join(' ');
      if (!msg) {
        out(`${c.yellow}Usage: /goal steer <id> <message>${c.reset}\n`);
        return;
      }
      const ok = goals.executor.steer(goalId, msg);
      out(
        ok
          ? `${c.dim}Steer sent.${c.reset}\n`
          : `${c.yellow}Cannot steer goal ${goalId}.${c.reset}\n`,
      );
    }
    return;
  }

  // Default: create a new goal — only when something will actually run it.
  if (!goals.executor.canExecute()) {
    out(`${c.red}${GOAL_EXECUTION_UNAVAILABLE}${c.reset}\n`);
    return;
  }
  const goal = goals.store.create({
    userId: 'default-user',
    personalityId: deps.personalityId,
    origin: 'cli',
    title: arg.slice(0, 80),
    goalText: arg,
  });
  out(`${c.green}Goal created: ${goal.id}${c.reset}\n`);
  out(`${c.dim}  "${goal.goalText}"${c.reset}\n`);
  out(`${c.dim}  Status: ${goal.status} · /goals to list${c.reset}\n`);
  await goals.executor.startGoal(goal.id);
}

/** `/goals` — the ten most recent goals, read from the same store the executor writes. */
export function runGoalsSlash(deps: Omit<GoalSlashDeps, 'personalityId'>): void {
  const { goals, out, c } = deps;
  const list = goals.store.list({ limit: 10 });
  if (list.length === 0) {
    out(`${c.dim}No goals yet. Use /goal <text> to create one.${c.reset}\n`);
    return;
  }
  out(`${c.dim}Recent goals:${c.reset}\n`);
  for (const g of list) {
    const status =
      g.status === 'completed'
        ? `${c.green}${g.status}${c.reset}`
        : g.status === 'failed'
          ? `${c.red}${g.status}${c.reset}`
          : `${c.dim}${g.status}${c.reset}`;
    const title = g.title.length > 50 ? `${g.title.slice(0, 50)}...` : g.title;
    out(`  ${c.dim}${g.id.slice(0, 8)}${c.reset}  ${status}  ${title}\n`);
  }
}
