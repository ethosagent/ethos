import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  Goal,
  GoalCompletedPayload,
  GoalExhaustedPayload,
  GoalFailedPayload,
  GoalOrigin,
  GoalStatus,
  GoalStore,
  HookRegistry,
  SteerSink,
  Verdict,
} from '@ethosagent/types';
import { answerSuffix } from '@ethosagent/types';
import { type CheckJudge, isConverged, judge } from './judge';
import { buildRetryContext, classifyFailure, type RetryStrategy } from './retry-context';

export {
  type CheckJudge,
  type CheckJudgeInput,
  type CheckJudgeResult,
  isConverged,
  judge,
} from './judge';
export { createLLMCheckJudge, type LLMCheckJudgeOptions } from './llm-check-judge';
export { buildRetryContext, classifyFailure, type RetryStrategy } from './retry-context';

/** Consecutive same-tool failures before the run is treated as a compounding
 *  failure. Mirrors `compoundingErrorRule`'s default threshold in
 *  packages/safety/watcher — this runner-level streak catches failure loops
 *  the loop-level guards miss (e.g. a tool that keeps erroring cheaply). */
const COMPOUNDING_FAILURE_THRESHOLD = 3;

/** A mid-run stop that must be recovered from (or fail the goal) instead of
 *  letting the judge score truncated output as if the attempt finished clean.
 *  `budget` / `watcher` come from structured `halt` AgentEvents; `failure-streak`
 *  is the runner's own consecutive-tool-failure tracking on `tool_end`. */
interface StopCause {
  kind: 'budget' | 'watcher' | 'failure-streak';
  tool: string;
  count: number;
  reason: string;
}

/** Error codes/messages treated as transient: the attempt is retried in place
 *  with backoff instead of terminally failing the goal. Covers rate limits
 *  (429/rate_limit), provider overload (529/overloaded), timeouts (including
 *  the loop's `streaming_timeout` code), and network-level failures. */
const TRANSIENT_ERROR_RE =
  /rate[ _-]?limit|\b429\b|overloaded|timed?[ _-]?out|timeout|econnreset|etimedout|econnrefused|enotfound|fetch failed|socket hang up|network|\b(?:500|502|503|504|529)\b/i;

/** Backoff schedule for transient-error retries — max 3 retries per attempt. */
const TRANSIENT_RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

/** Resolves once `signal` aborts (at once if it already has). */
function abortedPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function isTransientError(error: string, code: string): boolean {
  // Aborts are deliberate; watcher terminations are safety decisions. Never retry.
  if (code === 'aborted' || code.startsWith('watcher_')) return false;
  return TRANSIENT_ERROR_RE.test(code) || TRANSIENT_ERROR_RE.test(error);
}

/** Injected into the goal session's system prompt so the agent never blocks on a
 *  user. A goal is fire-and-forget — there is no interactive user to answer. */
const GOAL_AUTONOMY_DIRECTIVE =
  'This is an autonomous goal run with no interactive user available. Do NOT ask ' +
  'questions or request clarification. Make reasonable assumptions, decide, and ' +
  'proceed. If information is missing, pick a sensible default and state the ' +
  'assumption in your output.';

/** Injected into the planning session's system prompt. Constrains the planning
 *  turn to investigation + a written plan — no execution, no mutations. */
const GOAL_PLANNING_DIRECTIVE =
  'You are in the PLANNING phase of an autonomous goal run. Nothing has been ' +
  'executed yet. Investigate as much as you need using your read-only tools ' +
  '(reading files, searching, web lookups) — but do NOT make any changes: this ' +
  'phase is planning only. Produce a concise, actionable PLAN in markdown with ' +
  'numbered steps toward the goal, the key assumptions you are making, and the ' +
  'main risks. Output only the plan.';

/** Minimal in-memory SteerSink — an array-backed FIFO queue. */
class ArraySteerSink implements SteerSink {
  private queue: string[] = [];

  push(text: string): boolean {
    this.queue.push(text);
    return true;
  }

  drain(): string[] {
    return this.queue.splice(0, this.queue.length);
  }

  depth(): number {
    return this.queue.length;
  }
}

/** Lease cadence, mirroring job-runner's defaults: a live runner beats every
 *  30s, and recovery waits three missed beats before calling a goal orphaned. */
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_STALE_MS = 90_000;

/**
 * The store a runner executes against: the `GoalStore` contract plus the
 * ownership lease `recoverOrphans` depends on. `SQLiteGoalStore`
 * (extensions/goal-store) implements it; declared here, by its one consumer,
 * rather than widening the shared contract.
 */
export interface LeasedGoalStore extends GoalStore {
  // `owner` below is ONE RUN's lease (`<runnerId>:<runSeq>`, see `RunController`),
  // not the runner's: a run superseded by a resume on the same runner must fail
  // these checks exactly like one superseded by another process.
  /** Record `owner` as the run executing the goal, with a fresh heartbeat. */
  claimGoal(goalId: string, owner: string): void;
  /** Atomically resume a `failed` / `cancelled` / `interrupted` goal for the run
   *  `owner`: status `running`, resume count +1, lease taken. False when the goal
   *  was not resumable — e.g. another process resumed it first. */
  resumeGoal(goalId: string, owner: string): boolean;
  /** Refresh `owner`'s heartbeat. False — and nothing written — when the goal was
   *  cancelled (by anyone) or another run holds its lease: the run must stop. */
  heartbeatGoal(goalId: string, owner: string): boolean;
  /** Status write for the run `owner` is executing; refused (false) once the goal
   *  is cancelled or held by another run, so a stopped run never overwrites it. */
  updateRunStatus(
    goalId: string,
    owner: string,
    status: GoalStatus,
    extra?: Parameters<GoalStore['updateStatus']>[2],
  ): boolean;
  /** Interrupt every active goal whose lease is older than `staleMs`; returns their ids. */
  interruptStale(staleMs: number): string[];
}

export interface GoalRunnerConfig {
  store: LeasedGoalStore;
  /** This runner's id — the prefix of every run lease it takes. Defaults to a random UUID. */
  ownerId?: string;
  /** How often a live run's lease is refreshed. Default 30s. */
  heartbeatMs?: number;
  /** How old a lease must be before `recoverOrphans` treats its goal as orphaned. Default 90s. */
  staleMs?: number;
  maxTurnsSafetyValve?: number;
  hooks?: HookRegistry;
  /** Loop-bearing attempt runner. When absent the runner records the run_start
   *  event and returns (store-only construction). Wired in build-agent-loop to
   *  AgentLoop.run(). */
  runAttempt?: (
    sessionKey: string,
    firstMessage: string,
    opts: {
      abortSignal: AbortSignal;
      steerSink?: SteerSink;
      personalityId?: string;
      userId?: string;
      maxToolCallsPerTurn?: number;
      maxIdenticalToolCalls?: number;
      allowDangerousToolCalls?: boolean;
    },
  ) => AsyncGenerator<AgentEvent>;
  /** Read-only planning turn. When wired, every goal runs a planning phase
   *  BEFORE its first attempt: the plan is produced, persisted, and injected
   *  into execution — no plan, no execution. When ABSENT (store-only and most
   *  test construction) planning is SKIPPED and behavior is unchanged, so the
   *  existing goal-runner suite needs no rewrite. Production wiring always
   *  provides this (with a read-only toolset override), so production goals
   *  always plan. Same shape as `runAttempt` minus the execution-only knobs. */
  runPlan?: (
    sessionKey: string,
    firstMessage: string,
    opts: {
      abortSignal: AbortSignal;
      personalityId?: string;
      userId?: string;
    },
  ) => AsyncGenerator<AgentEvent>;
  /** Judge for acceptance checks that carry no `command`. Production wiring
   *  binds `createLLMCheckJudge` to the deployment's LLM. When ABSENT (tests,
   *  standalone) such a check falls back to a verbatim substring match of its
   *  description — which almost never passes — marked `method: 'substring'`. */
  judgeCheck?: CheckJudge;
  /** Injectable sleep for transient-error retry backoff. Defaults to a real
   *  setTimeout delay; tests inject a recorder to skip waiting. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * One run's AbortController, carrying the lease that run holds in the store.
 * A lease is per RUN (`<runnerId>:<seq>`), so after cancel → resume on the same
 * runner the cancelled run, still unwinding, fails every lease check the
 * resumed run passes. Pinned by __tests__/cancel-lease.test.ts.
 */
class RunController extends AbortController {
  constructor(readonly lease: string) {
    super();
  }
}

export class GoalRunner {
  private store: LeasedGoalStore;
  private runSeq = 0;
  private readonly ownerId: string;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  /** Refreshes the lease of every goal in `activeRuns`. Started by the first
   *  claim, unref'd, cleared when nothing is active and by `shutdown()`. */
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private maxTurnsSafetyValve: number;
  /** goalId → the goal's CURRENT run on this runner. */
  private activeRuns = new Map<string, RunController>();
  private activeRunState = new Map<string, { getPartial: () => string; queuedSteers: string[] }>();
  private activeSteerSinks = new Map<string, SteerSink>();
  /** Every fire-and-forget run (plan-then-run, resume) still unwinding — what
   *  `shutdown()` awaits. Each entry removes itself once it settles. */
  private readonly runs = new Set<Promise<void>>();
  /** The controller of every run in `runs` — including a superseded run no
   *  longer in `activeRuns` — so `shutdown()` can abort all it awaits. */
  private readonly liveRuns = new Set<RunController>();
  /** Set by `shutdown()`: no new start or resume, and an aborted run ends
   *  `interrupted` instead of being judged or failed. */
  private shuttingDown = false;
  private hooks: HookRegistry | undefined;
  private runAttempt: GoalRunnerConfig['runAttempt'];
  private runPlan: GoalRunnerConfig['runPlan'];
  private judgeCheck: CheckJudge | undefined;
  private sleep: (ms: number) => Promise<void>;

  constructor(config: GoalRunnerConfig) {
    this.store = config.store;
    this.ownerId = config.ownerId ?? randomUUID();
    this.heartbeatMs = config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.staleMs = config.staleMs ?? DEFAULT_STALE_MS;
    this.maxTurnsSafetyValve = config.maxTurnsSafetyValve ?? 100;
    this.hooks = config.hooks;
    this.runAttempt = config.runAttempt;
    this.runPlan = config.runPlan;
    this.judgeCheck = config.judgeCheck;
    this.sleep = config.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Whether `startGoal`/`resume` will actually execute attempts. False for
   * store-only construction (no `runAttempt`), where `startGoal` records
   * `run_start` and returns. A host that creates goals on a user's behalf
   * checks this BEFORE writing the row — apps/web-api `GoalsService.create`
   * refuses otherwise — so it never leaves a `running` goal nothing runs.
   * False again once `shutdown()` has been called: a stopping runner starts
   * nothing (pinned in __tests__/lease.test.ts).
   */
  canExecute(): boolean {
    return this.runAttempt !== undefined && !this.shuttingDown;
  }

  private newRun(): RunController {
    this.runSeq += 1;
    return new RunController(`${this.ownerId}:${this.runSeq}`);
  }

  /** Take the goal's lease for `run` and make sure the heartbeat is running. */
  private claim(goalId: string, run: RunController): void {
    this.store.claimGoal(goalId, run.lease);
    this.ensureHeartbeat();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.shuttingDown) return;
    this.heartbeatTimer = setInterval(() => this.beat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private beat(): void {
    if (this.activeRuns.size === 0) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      return;
    }
    for (const [goalId, controller] of [...this.activeRuns]) {
      try {
        // Cancelled by anyone, or resumed by another run: stop spending on it.
        // The run then unwinds through `endIfStopped` without a write.
        if (!this.store.heartbeatGoal(goalId, controller.lease)) controller.abort();
      } catch {
        // A missed beat only ages the lease; if beats keep failing, a peer's
        // recovery interrupts the goal after staleMs — the documented outcome
        // for a runner that cannot write. Throwing here would crash the process.
      }
    }
  }

  /** Status write for `run` (`LeasedGoalStore.updateRunStatus`): refused once
   *  the goal is cancelled or held by another run. Returns whether it applied;
   *  completion/failure hooks fire only when it did. Without a run (a direct
   *  `judgeAttempt` call) it writes as the goal's current run on this runner. */
  private setStatus(
    run: RunController | undefined,
    goalId: string,
    status: GoalStatus,
    extra?: Parameters<GoalStore['updateStatus']>[2],
  ): boolean {
    const lease = run?.lease ?? this.activeRuns.get(goalId)?.lease ?? this.ownerId;
    return this.store.updateRunStatus(goalId, lease, status, extra);
  }

  /** Forget `run`'s bookkeeping — only while it is still the goal's current
   *  run: a resume on this runner may already have registered a newer one. */
  private release(goalId: string, run: RunController): void {
    if (this.activeRuns.get(goalId) !== run) return;
    this.activeRuns.delete(goalId);
    this.activeRunState.delete(goalId);
  }

  /**
   * Phase/attempt boundary check — the same observation a heartbeat makes. When
   * the goal was cancelled (here or in another process) or another run took
   * its lease — including a resume on this same runner — abort the run and end
   * it quietly: no status write, no hooks, and the newer run's bookkeeping
   * left alone. Pinned by __tests__/cancel-lease.test.ts.
   */
  private endIfStopped(goalId: string, controller: RunController): boolean {
    let live: boolean;
    try {
      live = this.store.heartbeatGoal(goalId, controller.lease);
    } catch {
      // A beat the store refused (a peer's write lock) is not a stop signal:
      // ending the run here would kill a paid, uncancelled run silently, with
      // the goal left `running` and nothing to unwind it. Keep going — like
      // `beat()`, a missed beat only ages the lease, and if the store stays
      // unwritable the stale sweep interrupts the goal after `staleMs`. Pinned
      // by __tests__/lease.test.ts ("a heartbeat the store refuses").
      return false;
    }
    if (live) return false;
    controller.abort();
    if (this.activeRuns.get(goalId) === controller) this.activeSteerSinks.delete(goalId);
    this.release(goalId, controller);
    return true;
  }

  /**
   * Start a goal run. If a loop-bearing runAttempt was wired, emits run_start
   * and launches the plan-then-run pipeline fire-and-forget, returning
   * immediately. Without runAttempt this is store-only (records run_start and
   * returns), which keeps store-only construction type-checking.
   */
  async startGoal(goalId: string): Promise<void> {
    // A runner that is shutting down starts nothing; a row left `running` here
    // is marked `interrupted` by the next boot's `recoverOrphans`.
    if (this.shuttingDown) return;
    const goal = this.store.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    if (goal.status !== 'running') return;
    // Double-start guard: a run loop is already active for this goal — a second
    // loop would clobber the registered AbortController and race the first.
    if (this.activeRuns.has(goalId)) return;

    const controller = this.newRun();
    this.activeRuns.set(goalId, controller);

    // run_start is emitted ONCE here, at the top of the run (before any planning
    // or attempt), so the execution graph shows GOAL first. The store-only path
    // below preserves the same single emission; runAttemptLoop no longer emits
    // it for n===1, keeping resume (which re-enters runAttemptLoop directly) from
    // double-emitting on an already-started goal.
    this.store.appendEvent(goalId, 'run_start', {
      attemptN: 1,
      sessionKey: `goal:${goalId}:attempt-1`,
    });

    if (!this.runAttempt) {
      // Store-only construction: run_start recorded above, nothing to run —
      // and no lease, so recovery treats the row as unowned.
      return;
    }
    this.claim(goalId, controller);

    // Fire-and-forget: plan (when a planning callback is wired), then launch the
    // convergence/retry loop. Kept off startGoal's awaited path so goal creation
    // returns fast — planning runs in the background.
    this.track(this.planThenRun(goal, controller), controller);
  }

  /**
   * Stop this runner for good (F06 — the owning loop's `dispose()` calls it
   * BEFORE goals.db closes): refuse every further start and resume, abort
   * each in-flight run through its AbortController, and wait for every run to
   * unwind. An aborted run ends `interrupted` — the status `recoverOrphans`
   * gives a run the process lost, and one `resume` accepts — so the next boot
   * sees it the same way whether the stop was graceful or not. A goal that was
   * cancelled first keeps `cancelled`. Nothing writes to the store after this
   * resolves. Pinned by `__tests__/shutdown.test.ts`.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // No beats after this: the runs below end `interrupted` themselves.
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    // Every run it is about to await — a superseded one no longer in
    // `activeRuns` too, or the await below would never resolve.
    for (const controller of this.liveRuns) controller.abort();
    await Promise.all([...this.runs]);
  }

  /**
   * F06 — resolves once no goal run of this runner is still in flight (at once
   * when none is). Unlike `shutdown()` it aborts nothing: a host retiring a
   * loop it has REPLACED (the chat `/model` switch) waits on this so a goal
   * running there finishes on the loop it started on, then disposes the loop.
   * Pinned by `__tests__/when-idle.test.ts`.
   */
  async whenIdle(): Promise<void> {
    while (this.runs.size > 0) {
      await Promise.all([...this.runs]);
    }
  }

  /**
   * Follow a fire-and-forget run: `shutdown()` awaits it, and its rejection is
   * swallowed here because nobody is listening. A store write that throws from
   * inside a run therefore ends it quietly — the goal keeps whatever status it
   * had, its lease stops being beaten, and the stale sweep (`recoverOrphans`)
   * is the backstop that marks it `interrupted`. The boundary check does NOT
   * take that path: see `endIfStopped`.
   */
  private track(run: Promise<void>, controller: RunController): void {
    this.liveRuns.add(controller);
    const settled: Promise<void> = run
      .catch(() => {})
      .finally(() => {
        this.runs.delete(settled);
        this.liveRuns.delete(controller);
      });
    this.runs.add(settled);
  }

  /** True when `controller`'s run was aborted by `shutdown()`. */
  private stoppedByShutdown(controller: RunController): boolean {
    return this.shuttingDown && controller.signal.aborted;
  }

  /** End a run `shutdown()` aborted as `interrupted` — unless it already left
   *  the active states (a `cancel()` that raced the shutdown keeps its status). */
  private interruptForShutdown(
    goalId: string,
    controller: RunController,
    outputPartial: string,
  ): void {
    const status = this.store.get(goalId)?.status;
    if (
      status === 'planning' ||
      status === 'running' ||
      status === 'judging' ||
      status === 'retrying'
    ) {
      this.setStatus(controller, goalId, 'interrupted', {
        errorText: 'Interrupted: the runtime shut down',
        ...(outputPartial ? { outputPartial } : {}),
      });
    }
    this.release(goalId, controller);
  }

  /**
   * Ordering seam: PLAN (when wired) then ATTEMPT 1. When no planning callback
   * is wired, planning is skipped and the attempt loop runs directly — this is
   * why the existing goal-runner suite (which constructs without runPlan) is
   * unchanged. When planning fails, runPlanningPhase has already finalized the
   * goal (failed/interrupted) and returns false, so no attempt runs.
   */
  private async planThenRun(goal: Goal, controller: RunController): Promise<void> {
    if (this.runPlan) {
      const planned = await this.runPlanningPhase(goal, controller);
      if (!planned) return;
      // Reload so the plan just persisted flows into the attempt prompt.
      const withPlan = this.store.get(goal.id) ?? goal;
      await this.runAttemptLoop(withPlan, controller, 1, this.renderGoalPrompt(withPlan));
      return;
    }
    await this.runAttemptLoop(goal, controller, 1, this.renderGoalPrompt(goal));
  }

  /**
   * Run the mandatory planning phase: a read-only turn that investigates and
   * produces the plan. On success the plan is persisted, status returns to
   * 'running', and plan_ready is appended; returns true so the attempt loop
   * proceeds. On an error event, empty plan, or abort, the goal is finalized
   * (failed / interrupted / cancelled) and false is returned — guaranteeing
   * "no plan, no execution". Returns true immediately when no planning callback
   * is wired (planning skipped).
   */
  private async runPlanningPhase(goal: Goal, controller: RunController): Promise<boolean> {
    const runPlan = this.runPlan;
    if (!runPlan) return true;

    const sessionKey = `goal:${goal.id}:plan`;
    this.setStatus(controller, goal.id, 'planning');
    this.store.appendEvent(goal.id, 'plan_start', { sessionKey });

    // Inject the planning directive + goal spec into the plan session's system
    // prompt (mirrors the per-attempt injector). Cleaned up before returning.
    let cleanupInjector: (() => void) | undefined;
    if (this.hooks) {
      cleanupInjector = this.hooks.registerModifying('before_prompt_build', async (payload) => {
        if (payload.sessionId !== sessionKey) return null;
        return {
          prependSystem: `${this.renderGoalPrompt(goal)}\n\n${GOAL_PLANNING_DIRECTIVE}\n\n${GOAL_AUTONOMY_DIRECTIVE}`,
        };
      });
    }

    const finalizeFailed = (errorText: string): false => {
      if (this.setStatus(controller, goal.id, 'failed', { errorText })) {
        this.fireGoalFailed(goal, errorText, '');
      }
      cleanupInjector?.();
      this.release(goal.id, controller);
      return false;
    };

    let planText = '';
    let accumulated = '';
    let costUsd = 0;
    let planError: string | undefined;

    try {
      // Drained to the end, never `return` on `error` inside the loop: AgentLoop
      // yields `error` before its usage flush and trace close (and `done` before
      // its turn-end work), and closing the generator skips them (F07). The goal
      // is finalized below, once the iterator is exhausted. Pinned by
      // `__tests__/turn-tail.test.ts`.
      for await (const event of runPlan(sessionKey, this.renderPlanPrompt(goal), {
        abortSignal: controller.signal,
        ...(goal.personalityId ? { personalityId: goal.personalityId } : {}),
        ...(goal.userId ? { userId: goal.userId } : {}),
      })) {
        if (planError !== undefined) continue;
        switch (event.type) {
          case 'text_delta':
            accumulated += event.text;
            break;
          case 'usage':
            costUsd += event.estimatedCostUsd;
            this.store.appendEvent(goal.id, 'usage', {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              estimatedCostUsd: event.estimatedCostUsd,
            });
            if (goal.maxCostUsd != null && costUsd > goal.maxCostUsd) {
              controller.abort();
            }
            break;
          case 'error':
            this.store.appendEvent(goal.id, 'error', { error: event.error, code: event.code });
            planError = event.error;
            break;
          case 'done':
            // A `returnDirect` tool's answer arrives only as `done.text`, after
            // any preamble that streamed: the plan is the whole reply
            // (`answerSuffix`, @ethosagent/types).
            planText = accumulated + answerSuffix(accumulated, event.text);
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (this.endIfStopped(goal.id, controller)) return false;
      const msg = err instanceof Error ? err.message : String(err);
      this.store.appendEvent(goal.id, 'error', { error: msg, code: 'planning_failed' });
      return finalizeFailed(`Planning failed: ${msg}`);
    } finally {
      cleanupInjector?.();
    }

    // A shutdown abort surfaces as an `aborted` error event; it is an
    // interruption, not a planning failure.
    if (this.stoppedByShutdown(controller)) {
      this.interruptForShutdown(goal.id, controller, '');
      return false;
    }
    // Cancelled mid-plan (the abort also surfaces as an `aborted` error event).
    if (this.endIfStopped(goal.id, controller)) return false;
    if (planError !== undefined) return finalizeFailed(`Planning failed: ${planError}`);

    // Aborted mid-plan: cancel() already set 'cancelled'; a budget abort leaves
    // status at 'planning' — mark it interrupted. Either way, no attempt runs.
    if (controller.signal.aborted) {
      if (this.store.get(goal.id)?.status === 'planning') {
        this.setStatus(controller, goal.id, 'interrupted', { errorText: 'Planning interrupted' });
      }
      this.release(goal.id, controller);
      return false;
    }

    const plan = (planText || accumulated).trim();
    if (!plan) {
      return finalizeFailed('Planning produced no plan');
    }

    // Persist the plan and return to 'running'; the attempt loop takes over.
    this.setStatus(controller, goal.id, 'running', { planMd: plan });
    this.store.appendEvent(goal.id, 'plan_ready', { summary: plan.slice(0, 200) });
    return true;
  }

  /**
   * Render the goal spec into prompt text. Used as BOTH the first message and
   * the before_prompt_build prepend so the agent always sees the goal + criteria.
   * Once a plan exists it is appended so attempt 1 and every retry see it.
   */
  private renderGoalPrompt(goal: Goal): string {
    const spec = goal.acceptanceCriteria;
    let base: string;
    if (!spec) {
      base = `Goal: ${goal.goalText}`;
    } else {
      const lines: string[] = [`Goal: ${goal.goalText}`, '', 'Acceptance criteria:'];
      for (const check of spec.checks ?? []) {
        lines.push(`- ${check.description}`);
      }
      for (const item of spec.rubric ?? []) {
        lines.push(`- ${item.description} (weight ${item.weight})`);
      }
      lines.push(`Threshold: ${spec.threshold}`);
      base = lines.join('\n');
    }
    if (goal.planMd) {
      base += `\n\n## Plan\n${goal.planMd}`;
    }
    return base;
  }

  /**
   * Render the planning turn's first message: the goal spec plus a directive to
   * produce the plan. When the goal has no acceptanceCriteria, the model is also
   * asked to describe, in free-form markdown, how completion will be judged
   * (structured AcceptanceSpec auto-drafting is deferred to a follow-up).
   */
  private renderPlanPrompt(goal: Goal): string {
    const lines: string[] = [this.renderGoalPrompt(goal), '', GOAL_PLANNING_DIRECTIVE];
    if (!goal.acceptanceCriteria) {
      lines.push(
        '',
        'This goal has no explicit acceptance criteria. Include a "## Success ' +
          'criteria" section describing, in plain markdown, how you will judge that ' +
          'the goal is complete.',
      );
    }
    return lines.join('\n');
  }

  /**
   * Run attempt n to completion, then judge it. On a non-converged 'retrying'
   * verdict, recurse for attempt n+1 with the retry context. The AbortController
   * stays registered in activeRuns for the whole multi-attempt loop; the
   * per-attempt prompt injector is registered and cleaned up per attempt.
   */
  private async runAttemptLoop(
    goal: Goal,
    controller: RunController,
    n: number,
    firstMessage: string,
    strategy?: RetryStrategy,
  ): Promise<void> {
    const runAttempt = this.runAttempt;
    if (!runAttempt) return;
    // A retry reached after `shutdown()` aborted the run opens no new attempt.
    if (this.stoppedByShutdown(controller)) {
      this.interruptForShutdown(goal.id, controller, '');
      return;
    }
    // Boundary: a goal cancelled (or taken over) since the last phase opens no attempt.
    if (this.endIfStopped(goal.id, controller)) return;

    const sessionKey = `goal:${goal.id}:attempt-${n}`;

    // Create the attempt row ONCE per n. On resume the row for n already exists;
    // re-inserting would duplicate it, so guard on the existing row.
    const existing = this.store.getAttempts(goal.id).find((a) => a.n === n);
    if (!existing) {
      this.store.saveAttempt({
        goalId: goal.id,
        n,
        sessionKey,
        outputMd: null,
        artifacts: null,
        verdict: null,
        strategyUsed: 'first',
        costUsd: null,
        traceId: null,
        startedAt: Date.now(),
        completedAt: null,
      });
    }

    // run_start (n===1) is emitted once by startGoal before planning, so the
    // graph shows GOAL → PLAN → attempt 1 in order and resume (which re-enters
    // here directly) never re-emits it. Only retries (n>1) mark an attempt_start.
    if (n > 1) {
      this.store.appendEvent(goal.id, 'attempt_start', {
        attemptN: n,
        sessionKey,
        strategy: strategy ?? 'first',
      });
    }

    // Inject the goal spec into the system prompt for THIS attempt's session only.
    let cleanupInjector: (() => void) | undefined;
    if (this.hooks) {
      cleanupInjector = this.hooks.registerModifying('before_prompt_build', async (payload) => {
        if (payload.sessionId !== sessionKey) return null;
        return { prependSystem: `${this.renderGoalPrompt(goal)}\n\n${GOAL_AUTONOMY_DIRECTIVE}` };
      });
    }

    let output = '';
    let turns = 0;
    let tools = 0;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let pendingText = '';
    let accumulated = '';
    let budgetCapped = false;
    let completionSummary: string | undefined;
    let recoveryCount = 0;
    let transientRetries = 0;
    let transientRetryError: string | null = null;
    let lastToolError = '';

    // Track consecutive tool failures per tool (a success breaks the streak).
    // This runner-level streak catches failure loops the loop-level guards
    // miss; loop-level budget/watcher stops arrive as structured `halt` events.
    // Either way the run must not be judged as clean output.
    const consecutiveFailures = new Map<string, number>();
    let stopCause: StopCause | null = null;

    const flushText = (): void => {
      if (pendingText) {
        this.store.appendEvent(goal.id, 'turn_text', { text: pendingText });
        pendingText = '';
      }
    };

    // Create the per-attempt steer sink and register run-state. queuedSteers is a
    // SINGLE array reused across attempts for this goal so between-attempt steers
    // survive into the next attempt. getPartial reads the live accumulator.
    const steerSink = new ArraySteerSink();
    this.activeSteerSinks.set(goal.id, steerSink);
    const queuedSteers: string[] = this.activeRunState.get(goal.id)?.queuedSteers ?? [];
    this.activeRunState.set(goal.id, { getPartial: () => accumulated || output, queuedSteers });

    // Drain any steers queued between attempts into this attempt's first message.
    let effectiveFirstMessage = firstMessage;
    if (queuedSteers.length) {
      effectiveFirstMessage = `${queuedSteers.join('\n')}\n${firstMessage}`;
      queuedSteers.length = 0;
    }

    let currentMessage = effectiveFirstMessage;

    try {
      while (true) {
        // A non-transient `error` from this run. Like a transient one, it ends
        // the run but NOT the iterator: AgentLoop yields `error` before its
        // usage flush and trace close (and `done` before its turn-end work), and
        // leaving the `for await` early closes the generator and skips them
        // (F07). Everything after the error is drained, not read; the goal is
        // failed — or the attempt retried — once the iterator is exhausted,
        // which also keeps a retry on the SAME session key from starting while
        // the failed run is still finishing. Pinned by `__tests__/turn-tail.test.ts`.
        let fatalError: string | undefined;
        // What THIS attempt streamed. `accumulated` spans the whole run (it is
        // the run's partial across retries), and the answer rule compares
        // against one turn's own stream.
        let attemptStreamed = '';
        for await (const event of runAttempt(sessionKey, currentMessage, {
          abortSignal: controller.signal,
          steerSink,
          ...(goal.personalityId ? { personalityId: goal.personalityId } : {}),
          ...(goal.userId ? { userId: goal.userId } : {}),
          ...(goal.maxToolCallsPerTurn != null
            ? { maxToolCallsPerTurn: goal.maxToolCallsPerTurn }
            : {}),
          ...(goal.maxIdenticalToolCalls != null
            ? { maxIdenticalToolCalls: goal.maxIdenticalToolCalls }
            : {}),
          ...(goal.allowDangerousToolCalls ? { allowDangerousToolCalls: true } : {}),
        })) {
          if (transientRetryError || fatalError !== undefined) continue;
          // Coalesce text deltas into turn-grained checkpoints — never per-delta.
          if (event.type !== 'text_delta') flushText();

          switch (event.type) {
            case 'text_delta':
              pendingText += event.text;
              accumulated += event.text;
              attemptStreamed += event.text;
              break;
            case 'thinking_delta':
              break;
            case 'tool_start':
              tools++;
              this.store.appendEvent(goal.id, 'tool_start', {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
              });
              if (event.toolName === 'goal_complete') {
                const a = event.args as { summary?: unknown };
                if (typeof a?.summary === 'string') completionSummary = a.summary;
              }
              break;
            case 'tool_end':
              this.store.appendEvent(goal.id, 'tool_end', {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                ok: event.ok,
                durationMs: event.durationMs,
              });
              if (event.ok === false) {
                if (event.error) lastToolError = event.error;
                const count = (consecutiveFailures.get(event.toolName) ?? 0) + 1;
                consecutiveFailures.set(event.toolName, count);
                if (!stopCause && count >= COMPOUNDING_FAILURE_THRESHOLD) {
                  stopCause = {
                    kind: 'failure-streak',
                    tool: event.toolName,
                    count,
                    reason: `${event.toolName} failed ${count} times in a row`,
                  };
                }
              } else {
                consecutiveFailures.delete(event.toolName);
              }
              break;
            case 'tool_progress':
              // Audience gate — only 'user' events surface; 'internal' is dropped.
              if (event.audience === 'user') {
                this.store.appendEvent(goal.id, 'turn_text', { text: event.message });
              }
              break;
            case 'halt':
              // Structured mid-run stop from the loop (tool budget or watcher
              // pause). The loop still emits a normal `done` afterwards, so
              // record the cause and let the recovery block below handle it.
              if (!stopCause) {
                stopCause = {
                  kind: event.kind,
                  tool: event.toolName ?? event.rule,
                  count: event.count ?? 0,
                  reason: event.message,
                };
              }
              break;
            case 'usage':
              costUsd += event.estimatedCostUsd;
              inputTokens += event.inputTokens;
              outputTokens += event.outputTokens;
              this.store.appendEvent(goal.id, 'usage', {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                estimatedCostUsd: event.estimatedCostUsd,
              });
              if (goal.maxCostUsd != null && costUsd > goal.maxCostUsd) {
                budgetCapped = true;
                controller.abort();
              }
              break;
            case 'error':
              this.store.appendEvent(goal.id, 'error', { error: event.error, code: event.code });
              if (
                transientRetries < TRANSIENT_RETRY_DELAYS_MS.length &&
                isTransientError(event.error, event.code)
              ) {
                // Transient (rate limit / overload / timeout / network) — retry
                // the SAME attempt with backoff instead of failing the goal.
                transientRetryError = event.error;
                break;
              }
              fatalError = event.error;
              break;
            case 'done':
              // The whole reply — a `returnDirect` answer arrives only as
              // `done.text`, after any preamble THIS attempt streamed;
              // `answerSuffix` is what is still owed.
              output = attemptStreamed + answerSuffix(attemptStreamed, event.text);
              turns = event.turnCount;
              break;
            default:
              // Forward-compat: ignore unknown event types.
              break;
          }
        }

        // Before the fatal-error branch: a shutdown abort surfaces as an
        // `aborted` error event, and it is an interruption, not a failure.
        if (this.stoppedByShutdown(controller)) {
          flushText();
          this.interruptForShutdown(goal.id, controller, accumulated || output);
          return;
        }
        // Likewise a cancel (here or in another process): its abort is not a failure.
        if (this.endIfStopped(goal.id, controller)) {
          flushText();
          return;
        }

        if (fatalError !== undefined) {
          const written = this.setStatus(controller, goal.id, 'failed', {
            errorText: fatalError,
            outputPartial: accumulated || output,
          });
          if (written) this.fireGoalFailed(goal, fatalError, accumulated || output);
          cleanupInjector?.();
          this.release(goal.id, controller);
          return;
        }

        // After each run finishes: flush trailing text from this continuation.
        flushText();

        // Budget cap or cancel during this run → break out; the existing budget /
        // interrupt handling below the loop takes over.
        if (budgetCapped || controller.signal.aborted) {
          break;
        }

        // Transient LLM error → retry the SAME attempt in place with backoff.
        if (transientRetryError) {
          transientRetries++;
          const delayMs = TRANSIENT_RETRY_DELAYS_MS[transientRetries - 1] ?? 0;
          // Journey marker so the graph shows the retry (reuse turn_text).
          this.store.appendEvent(goal.id, 'turn_text', {
            text: `↻ Transient error — retrying (${transientRetries}/${TRANSIENT_RETRY_DELAYS_MS.length}) after ${delayMs / 1000}s: ${transientRetryError}`,
          });
          currentMessage =
            `The previous request failed transiently (${transientRetryError}). ` +
            `Continue the goal from where you left off.`;
          transientRetryError = null;
          // Cut short by an abort, so a shutdown does not wait out the backoff;
          // the re-run then sees the aborted signal and ends at once.
          await Promise.race([this.sleep(delayMs), abortedPromise(controller.signal)]);
          continue; // re-run the SAME session with the continuation message
        }

        // Mid-run stop (halt event or failure streak) → recover via reflection.
        // Budget halts ALWAYS recover — dangerous mode only disables the safety
        // watcher, not the loop's per-turn tool budgets. Watcher halts and
        // failure streaks skip recovery in dangerous mode (the watcher is
        // disabled there; keep the guard consistent for streaks).
        if (stopCause && (stopCause.kind === 'budget' || !goal.allowDangerousToolCalls)) {
          const { kind, tool, count, reason } = stopCause;
          const max = goal.maxRecoveryAttempts ?? 2;
          if (recoveryCount < max) {
            recoveryCount++;
            // Journey marker so the graph shows the recovery (reuse turn_text).
            this.store.appendEvent(goal.id, 'turn_text', {
              text: `↻ Recovering: ${
                kind === 'budget'
                  ? `hit a tool-call budget (${reason})`
                  : `detected a loop on \`${tool}\``
              }, reflecting and trying a different approach (recovery ${recoveryCount}/${max})`,
            });
            const loopDesc =
              kind === 'failure-streak'
                ? `you called \`${tool}\` ${count} times and it kept failing with: ${lastToolError || 'repeated failures'}`
                : reason;
            const reflection =
              kind === 'budget'
                ? `⚠ You hit a tool-call budget mid-run: ${reason}. The turn was stopped ` +
                  `before you finished. Work more efficiently: batch related work into fewer ` +
                  `calls, vary your tool calls instead of repeating them, and avoid re-doing ` +
                  `work you already completed. Continue toward the goal from where you left off.`
                : `⚠ You are stuck in a loop: ${loopDesc}. STOP repeating that exact ` +
                  `call. Step back and reason explicitly: what is actually going wrong, and why? Then ` +
                  `take a genuinely DIFFERENT approach — a different tool, different parameters, or a ` +
                  `revised plan. If a sub-goal is impossible, work around it and continue toward the ` +
                  `overall goal. Do not give up.`;
            // Reset per-tool streak tracking + the stop cause so the next stretch
            // starts fresh; a recovery continuation that stops AGAIN re-sets it.
            // Each loop.run() continuation also resets the loop's per-turn budgets.
            consecutiveFailures.clear();
            stopCause = null;
            currentMessage = reflection;
            continue; // re-run the SAME session with the reflection message
          }
          // Recovery exhausted → terminal failure (owner decision: fail, don't ask).
          const errorText =
            kind === 'budget'
              ? `Stuck: couldn't recover after ${recoveryCount} recovery attempts — kept hitting tool-call budgets (${reason})`
              : `Stuck: couldn't recover after ${recoveryCount} recovery attempts — ${tool} kept failing`;
          const partial = accumulated || output;
          if (
            this.setStatus(controller, goal.id, 'failed', { errorText, outputPartial: partial })
          ) {
            this.fireGoalFailed(goal, errorText, partial);
          }
          cleanupInjector?.();
          this.release(goal.id, controller);
          return;
        }

        // Clean done (no unrecovered stop) → leave the recovery loop and proceed
        // to the normal judge/complete path.
        break;
      }

      if (budgetCapped) {
        this.store.appendEvent(goal.id, 'error', {
          error: 'Budget ceiling exceeded',
          code: 'budget_exceeded',
        });
        this.setStatus(controller, goal.id, 'interrupted', {
          outputPartial: accumulated || output,
          errorText: `Budget limit reached ($${goal.maxCostUsd?.toFixed?.(2) ?? goal.maxCostUsd})`,
        });
        cleanupInjector?.();
        this.release(goal.id, controller);
        return;
      }
    } catch (err) {
      // Generator threw (not an error event) — treat as failure (terminal).
      const msg = err instanceof Error ? err.message : String(err);
      flushText();
      if (this.endIfStopped(goal.id, controller)) return;
      this.store.appendEvent(goal.id, 'error', { error: msg, code: 'execution_failed' });
      const written = this.setStatus(controller, goal.id, 'failed', {
        errorText: msg,
        outputPartial: accumulated || output,
      });
      if (written) this.fireGoalFailed(goal, msg, accumulated || output);
      cleanupInjector?.();
      this.release(goal.id, controller);
      return;
    } finally {
      cleanupInjector?.();
      // The steer sink lives only for this attempt; run-state (queuedSteers)
      // survives across retries and is cleared at terminal points below.
      // Only this attempt's sink: a superseded run must not drop the newer run's.
      if (this.activeSteerSinks.get(goal.id) === steerSink) this.activeSteerSinks.delete(goal.id);
    }

    if (turns >= this.maxTurnsSafetyValve) {
      controller.abort();
      this.setStatus(controller, goal.id, 'interrupted', {
        outputPartial: output || accumulated,
        errorText: `Turn limit reached (${this.maxTurnsSafetyValve} turns)`,
      });
      this.release(goal.id, controller);
      return;
    }

    // Persist this attempt's output/cost onto the attempt row.
    this.store.updateAttempt(goal.id, n, {
      costUsd,
      outputMd: output,
      completedAt: Date.now(),
    });

    // Persist run-level metrics onto the goal. judgeAttempt sets 'judging' again
    // (or completed/exhausted/retrying after); writing 'judging' here is consistent.
    this.setStatus(controller, goal.id, 'judging', {
      turnCount: turns,
      toolCount: tools,
      tokenCount: inputTokens + outputTokens,
      costUsd,
    });

    if (completionSummary !== undefined) {
      const gate = await this.fireBeforeGoalComplete(goal, completionSummary, output);
      if (gate.rejected) {
        const reason = gate.reason ?? 'completion rejected';
        this.store.appendEvent(goal.id, 'complete_rejected', { reason });
        if (n >= goal.maxAttempts) {
          if (this.setStatus(controller, goal.id, 'exhausted', { outputPartial: output })) {
            this.fireGoalExhausted(goal, output, null);
          }
          this.release(goal.id, controller);
          return;
        }
        this.setStatus(controller, goal.id, 'retrying');
        const updatedAfterReject = this.store.get(goal.id);
        if (!updatedAfterReject) {
          this.release(goal.id, controller);
          return;
        }
        const retryCtx = this.getRetryContext(goal.id) ?? this.renderGoalPrompt(updatedAfterReject);
        await this.runAttemptLoop(updatedAfterReject, controller, n + 1, retryCtx);
        return;
      }
    }

    const converged = await this.judgeAttempt(goal.id, n, output, completionSummary, controller);
    if (converged) {
      this.release(goal.id, controller);
      return;
    }

    const updated = this.store.get(goal.id);
    if (!updated) {
      this.release(goal.id, controller);
      return;
    }

    if (updated.status === 'retrying') {
      const attempts = this.store.getAttempts(goal.id);
      const lastVerdict = attempts[attempts.length - 1]?.verdict ?? null;
      const nextStrategy = lastVerdict ? classifyFailure(attempts, lastVerdict) : undefined;
      if (nextStrategy === 'clarify') {
        const parked = this.setStatus(controller, goal.id, 'needs_clarification');
        const gaps = lastVerdict?.perCriterion
          .filter((c) => c.gap)
          .map((c) => c.gap)
          .join('; ');
        if (parked) {
          this.fireGoalNeedsClarification(goal.id, gaps?.length ? gaps : 'clarification needed');
        }
        this.release(goal.id, controller);
        return;
      }
      const ctx = this.getRetryContext(goal.id);
      if (!ctx) {
        this.release(goal.id, controller);
        return;
      }
      await this.runAttemptLoop(updated, controller, n + 1, ctx, nextStrategy);
      return;
    }

    // exhausted / needs_clarification / any other terminal status.
    this.release(goal.id, controller);
  }

  /**
   * Submit a steer message to a running goal. Also accepted while the goal is
   * judging or retrying — the run loop is still alive between attempts, so the
   * steer queues via activeRunState and lands in the next attempt's first message.
   */
  steer(goalId: string, message: string): boolean {
    const status = this.store.get(goalId)?.status;
    if (status !== 'running' && status !== 'judging' && status !== 'retrying') return false;

    const formatted = `[USER STEER] ${message}`;
    const sink = this.activeSteerSinks.get(goalId);
    if (sink) {
      // Live attempt: hand the steer to the loop's iteration seam.
      sink.push(formatted);
    } else {
      // Between attempts: queue it for the next attempt's first message.
      const state = this.activeRunState.get(goalId);
      if (state) state.queuedSteers.push(formatted);
    }

    this.store.appendEvent(goalId, 'steer', {
      message,
      timestamp: Date.now(),
    });
    return true;
  }

  /**
   * Cancel a goal that is planning, running, judging or retrying — whichever
   * runner executes it, so it returns true for a goal live on another runner
   * too. The `cancelled` row is the signal: this runner aborts its own run at
   * once; the owner of a run elsewhere aborts on its next heartbeat or phase
   * boundary (`endIfStopped`), and `updateRunStatus` keeps it from writing over
   * the cancel. Pinned by __tests__/cancel-lease.test.ts.
   */
  cancel(goalId: string): boolean {
    const goal = this.store.get(goalId);
    if (!goal) return false;
    if (
      goal.status !== 'planning' &&
      goal.status !== 'running' &&
      goal.status !== 'judging' &&
      goal.status !== 'retrying'
    ) {
      return false;
    }

    const state = this.activeRunState.get(goalId);
    const outputPartial = state?.getPartial() ?? '';

    const controller = this.activeRuns.get(goalId);
    if (controller) controller.abort();
    this.activeRuns.delete(goalId);
    this.activeRunState.delete(goalId);
    this.activeSteerSinks.delete(goalId);

    // Only persist a non-empty partial so cancelling early doesn't overwrite with ''.
    // Unconditional on purpose: anyone may cancel, whoever holds the lease.
    this.store.updateStatus(goalId, 'cancelled', outputPartial ? { outputPartial } : undefined);
    return true;
  }

  /**
   * Resume a failed/cancelled/interrupted goal. The claim is one conditional
   * UPDATE (`LeasedGoalStore.resumeGoal`): resumable status → `running`, resume
   * count +1 and a NEW run lease, atomically — so of two processes resuming the
   * same goal exactly one wins, and a run still unwinding from before (even on
   * this runner) holds a superseded lease and stands down. Pinned by
   * __tests__/lease.test.ts and __tests__/cancel-lease.test.ts.
   */
  async resume(goalId: string): Promise<boolean> {
    if (this.shuttingDown) return false;
    // Read only for the resume note below; the decision is the atomic claim.
    const before = this.store.get(goalId);
    const controller = this.newRun();
    if (!this.store.resumeGoal(goalId, controller.lease)) return false;

    const refreshed = this.store.get(goalId);
    if (!refreshed) return false;

    // Store-only construction: no loop-bearing runner. Fall back to startGoal.
    if (!this.runAttempt) {
      await this.startGoal(goalId);
      return true;
    }

    // Never ran (no attempt rows) — a fresh attempt 1 is the right resume.
    const attempts = this.store.getAttempts(goalId);
    if (attempts.length === 0) {
      await this.startGoal(goalId);
      return true;
    }

    // Re-enter the loop at the SAME latest attempt n with its existing session
    // key (runAttemptLoop derives the key from n). The saveAttempt guard keeps
    // this idempotent — no new attempt row, no incremented n.
    const latest = attempts[attempts.length - 1];
    if (!latest) return false;
    const n = latest.n;
    this.activeRuns.set(goalId, controller);
    this.ensureHeartbeat();
    const resumeNote = `The goal run was interrupted: ${refreshed.errorText ?? before?.status ?? 'interrupted'}. Review prior progress and continue.`;
    this.track(this.runAttemptLoop(refreshed, controller, n, resumeNote), controller);
    return true;
  }

  /**
   * Judge an attempt's output against the acceptance criteria.
   * Returns whether the goal converged.
   */
  async judgeAttempt(
    goalId: string,
    attemptN: number,
    output: string,
    summary?: string,
    run?: RunController,
  ): Promise<boolean> {
    const goal = this.store.get(goalId);
    if (!goal) return false;

    const spec = goal.acceptanceCriteria;
    if (!spec) {
      if (this.setStatus(run, goalId, 'completed', { outputMd: output, completedAt: Date.now() })) {
        this.store.appendEvent(goalId, 'done', { attemptN });
        this.fireGoalCompleted(goal, output, summary);
      }
      return true;
    }

    this.setStatus(run, goalId, 'judging');
    const verdict = await judge(
      { output, spec, goalText: goal.goalText },
      this.judgeCheck ? { judgeCheck: this.judgeCheck } : undefined,
    );

    this.store.updateAttempt(goalId, attemptN, {
      verdict,
      outputMd: output,
      completedAt: Date.now(),
    });

    const attempts = this.store.getAttempts(goalId);

    if (isConverged(verdict, spec.threshold)) {
      if (this.setStatus(run, goalId, 'completed', { outputMd: output, completedAt: Date.now() })) {
        this.store.appendEvent(goalId, 'done', {
          score: verdict.score,
          attemptN,
        });
        this.fireGoalCompleted(goal, output, summary);
      }
      return true;
    }

    if (attemptN >= goal.maxAttempts) {
      if (this.setStatus(run, goalId, 'exhausted', { outputPartial: output })) {
        this.fireGoalExhausted(goal, output, verdict);
      }
      return false;
    }

    if (attempts.length >= 2) {
      const prevScores = attempts.slice(-2).map((a) => a.verdict?.score ?? 0);
      if (prevScores.every((s) => s >= verdict.score)) {
        if (this.setStatus(run, goalId, 'exhausted', { outputPartial: output })) {
          this.fireGoalExhausted(goal, output, verdict);
        }
        return false;
      }
    }

    this.store.appendEvent(goalId, 'complete_rejected', {
      score: verdict.score,
      gaps: verdict.perCriterion.filter((c) => c.gap).map((c) => c.gap),
    });
    this.setStatus(run, goalId, 'retrying');

    return false;
  }

  /**
   * Recover orphaned goals on boot: mark `interrupted` every active goal whose
   * lease went quiet for `staleMs` (`LeasedGoalStore.interruptStale`). Goals a
   * live runner — this one or another process's — is heartbeating are left
   * alone. Pinned by __tests__/lease.test.ts.
   */
  recoverOrphans(): void {
    this.store.interruptStale(this.staleMs);
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

  // -------------------------------------------------------------------------
  // Notification hooks (fire-and-forget)
  // -------------------------------------------------------------------------

  private fireGoalCompleted(
    goal: {
      id: string;
      title: string;
      origin: GoalOrigin;
      personalityId: string;
      costUsd: number | null;
      startedAt: number;
    },
    output: string,
    summary?: string,
  ): void {
    if (!this.hooks) return;
    const payload: GoalCompletedPayload = {
      goalId: goal.id,
      title: goal.title,
      summary: summary ?? '',
      outputMd: output,
      origin: goal.origin,
      personalityId: goal.personalityId,
      costUsd: goal.costUsd,
      durationMs: Date.now() - goal.startedAt,
    };
    void this.hooks.fireVoid('goal_completed', payload);
  }

  private fireGoalExhausted(
    goal: { id: string; title: string; origin: GoalOrigin; personalityId: string },
    output: string,
    verdict: Verdict | null,
  ): void {
    if (!this.hooks) return;
    const payload: GoalExhaustedPayload = {
      goalId: goal.id,
      title: goal.title,
      bestAttemptOutput: output,
      verdict,
      origin: goal.origin,
      personalityId: goal.personalityId,
    };
    void this.hooks.fireVoid('goal_exhausted', payload);
  }

  private fireGoalFailed(
    goal: { id: string; title: string; origin: GoalOrigin; personalityId: string },
    errorText: string,
    outputPartial: string,
  ): void {
    if (!this.hooks) return;
    const payload: GoalFailedPayload = {
      goalId: goal.id,
      title: goal.title,
      errorText,
      outputPartial,
      origin: goal.origin,
      personalityId: goal.personalityId,
    };
    void this.hooks.fireVoid('goal_failed', payload);
  }

  private async fireBeforeGoalComplete(
    goal: Goal,
    summary: string,
    output: string,
  ): Promise<{ rejected: boolean; reason?: string }> {
    if (!this.hooks) return { rejected: false };
    const verdict = await this.hooks.fireClaiming('before_goal_complete', {
      goalId: goal.id,
      summary,
      outputMd: output,
      acceptanceCriteria: goal.acceptanceCriteria,
    });
    if (verdict.handled) return { rejected: true, reason: verdict.reason };
    return { rejected: false };
  }

  private fireGoalNeedsClarification(goalId: string, reason: string): void {
    if (!this.hooks) return;
    void this.hooks.fireVoid('goal_needs_clarification', { goalId, reason });
  }
}

// ---------------------------------------------------------------------------
// Gateway subscriber — wires goal hooks to channel notifications
// ---------------------------------------------------------------------------

export function registerGoalNotifications(
  hooks: HookRegistry,
  send: (platform: string, chatId: string, text: string) => Promise<void>,
): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    hooks.registerVoid('goal_completed', async (payload) => {
      const origin = parseChannelOrigin(payload.origin);
      if (!origin) return;
      await send(
        origin.platform,
        origin.chatId,
        `Goal completed: ${payload.title}\n${payload.summary || '(no summary)'}`,
      );
    }),
  );

  cleanups.push(
    hooks.registerVoid('goal_failed', async (payload) => {
      const origin = parseChannelOrigin(payload.origin);
      if (!origin) return;
      await send(
        origin.platform,
        origin.chatId,
        `Goal failed: ${payload.title}\n${payload.errorText ?? '(unknown error)'}`,
      );
    }),
  );

  cleanups.push(
    hooks.registerVoid('goal_exhausted', async (payload) => {
      const origin = parseChannelOrigin(payload.origin);
      if (!origin) return;
      const score = payload.verdict ? ` (score: ${payload.verdict.score.toFixed(2)})` : '';
      await send(
        origin.platform,
        origin.chatId,
        `Goal exhausted: ${payload.title}${score}\nBest attempt delivered but did not meet acceptance criteria.`,
      );
    }),
  );

  return () => {
    for (const fn of cleanups) fn();
  };
}

/** Parse a channel-style GoalOrigin ('platform:chatId') into parts, or null for non-channel origins. */
function parseChannelOrigin(origin: GoalOrigin): { platform: string; chatId: string } | null {
  if (origin === 'web' || origin === 'cli') return null;
  const idx = origin.indexOf(':');
  if (idx < 1) return null;
  const platform = origin.slice(0, idx);
  const chatId = origin.slice(idx + 1);
  if (!chatId) return null;
  return { platform, chatId };
}
