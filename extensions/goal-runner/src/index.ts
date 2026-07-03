import type {
  AgentEvent,
  Goal,
  GoalCompletedPayload,
  GoalExhaustedPayload,
  GoalFailedPayload,
  GoalOrigin,
  GoalStore,
  HookRegistry,
  SteerSink,
  Verdict,
} from '@ethosagent/types';
import { isConverged, judge } from './judge';
import { buildRetryContext, classifyFailure, type RetryStrategy } from './retry-context';

export { isConverged, judge } from './judge';
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

export interface GoalRunnerConfig {
  store: GoalStore;
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
  /** Injectable sleep for transient-error retry backoff. Defaults to a real
   *  setTimeout delay; tests inject a recorder to skip waiting. */
  sleepFn?: (ms: number) => Promise<void>;
}

export class GoalRunner {
  private store: GoalStore;
  private maxTurnsSafetyValve: number;
  private activeRuns = new Map<string, AbortController>();
  private activeRunState = new Map<string, { getPartial: () => string; queuedSteers: string[] }>();
  private activeSteerSinks = new Map<string, SteerSink>();
  private hooks: HookRegistry | undefined;
  private runAttempt: GoalRunnerConfig['runAttempt'];
  private sleep: (ms: number) => Promise<void>;

  constructor(config: GoalRunnerConfig) {
    this.store = config.store;
    this.maxTurnsSafetyValve = config.maxTurnsSafetyValve ?? 100;
    this.hooks = config.hooks;
    this.runAttempt = config.runAttempt;
    this.sleep = config.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Start a goal run. If a loop-bearing runAttempt was wired, launches the
   * convergence/retry loop fire-and-forget and returns immediately. Without
   * runAttempt this is store-only (records run_start and returns), which keeps
   * store-only construction type-checking.
   */
  async startGoal(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    if (goal.status !== 'running') return;
    // Double-start guard: a run loop is already active for this goal — a second
    // loop would clobber the registered AbortController and race the first.
    if (this.activeRuns.has(goalId)) return;

    const controller = new AbortController();
    this.activeRuns.set(goalId, controller);

    if (!this.runAttempt) {
      // Store-only construction: record the run_start event and return.
      this.store.appendEvent(goalId, 'run_start', {
        attemptN: 1,
        sessionKey: `goal:${goalId}:attempt-1`,
      });
      return;
    }

    // Fire-and-forget: launch the convergence/retry loop without awaiting.
    void this.runAttemptLoop(goal, controller, 1, this.renderGoalPrompt(goal)).catch(() => {});
  }

  /**
   * Render the goal spec into prompt text. Used as BOTH the first message and
   * the before_prompt_build prepend so the agent always sees the goal + criteria.
   */
  private renderGoalPrompt(goal: Goal): string {
    const spec = goal.acceptanceCriteria;
    if (!spec) return `Goal: ${goal.goalText}`;

    const lines: string[] = [`Goal: ${goal.goalText}`, '', 'Acceptance criteria:'];
    for (const check of spec.checks ?? []) {
      lines.push(`- ${check.description}`);
    }
    for (const item of spec.rubric ?? []) {
      lines.push(`- ${item.description} (weight ${item.weight})`);
    }
    lines.push(`Threshold: ${spec.threshold}`);
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
    controller: AbortController,
    n: number,
    firstMessage: string,
    strategy?: RetryStrategy,
  ): Promise<void> {
    const runAttempt = this.runAttempt;
    if (!runAttempt) return;

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

    if (n === 1) {
      this.store.appendEvent(goal.id, 'run_start', { attemptN: 1, sessionKey });
    } else {
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
          // Coalesce text deltas into turn-grained checkpoints — never per-delta.
          if (event.type !== 'text_delta') flushText();

          switch (event.type) {
            case 'text_delta':
              pendingText += event.text;
              accumulated += event.text;
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
              this.store.updateStatus(goal.id, 'failed', {
                errorText: event.error,
                outputPartial: accumulated || output,
              });
              this.fireGoalFailed(goal, event.error, accumulated || output);
              cleanupInjector?.();
              this.activeRuns.delete(goal.id);
              this.activeRunState.delete(goal.id);
              return;
            case 'done':
              output = event.text;
              turns = event.turnCount;
              break;
            default:
              // Forward-compat: ignore unknown event types.
              break;
          }

          // A transient error ends this run — stop consuming and re-enter the
          // while-loop with a continuation message after the backoff.
          if (transientRetryError) break;
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
          await this.sleep(delayMs);
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
          this.store.updateStatus(goal.id, 'failed', { errorText, outputPartial: partial });
          this.fireGoalFailed(goal, errorText, partial);
          cleanupInjector?.();
          this.activeRuns.delete(goal.id);
          this.activeRunState.delete(goal.id);
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
        this.store.updateStatus(goal.id, 'interrupted', {
          outputPartial: accumulated || output,
          errorText: `Budget limit reached ($${goal.maxCostUsd?.toFixed?.(2) ?? goal.maxCostUsd})`,
        });
        cleanupInjector?.();
        this.activeRuns.delete(goal.id);
        this.activeRunState.delete(goal.id);
        return;
      }
    } catch (err) {
      // Generator threw (not an error event) — treat as failure (terminal).
      const msg = err instanceof Error ? err.message : String(err);
      flushText();
      this.store.appendEvent(goal.id, 'error', { error: msg, code: 'execution_failed' });
      this.store.updateStatus(goal.id, 'failed', {
        errorText: msg,
        outputPartial: accumulated || output,
      });
      this.fireGoalFailed(goal, msg, accumulated || output);
      cleanupInjector?.();
      this.activeRuns.delete(goal.id);
      this.activeRunState.delete(goal.id);
      return;
    } finally {
      cleanupInjector?.();
      // The steer sink lives only for this attempt; run-state (queuedSteers)
      // survives across retries and is cleared at terminal points below.
      this.activeSteerSinks.delete(goal.id);
    }

    if (turns >= this.maxTurnsSafetyValve) {
      controller.abort();
      this.store.updateStatus(goal.id, 'interrupted', {
        outputPartial: output || accumulated,
        errorText: `Turn limit reached (${this.maxTurnsSafetyValve} turns)`,
      });
      this.activeRuns.delete(goal.id);
      this.activeRunState.delete(goal.id);
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
    this.store.updateStatus(goal.id, 'judging', {
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
          this.store.updateStatus(goal.id, 'exhausted', { outputPartial: output });
          this.fireGoalExhausted(goal, output, null);
          this.activeRuns.delete(goal.id);
          this.activeRunState.delete(goal.id);
          return;
        }
        this.store.updateStatus(goal.id, 'retrying');
        const updatedAfterReject = this.store.get(goal.id);
        if (!updatedAfterReject) {
          this.activeRuns.delete(goal.id);
          this.activeRunState.delete(goal.id);
          return;
        }
        const retryCtx = this.getRetryContext(goal.id) ?? this.renderGoalPrompt(updatedAfterReject);
        await this.runAttemptLoop(updatedAfterReject, controller, n + 1, retryCtx);
        return;
      }
    }

    const converged = await this.judgeAttempt(goal.id, n, output, completionSummary);
    if (converged) {
      this.activeRuns.delete(goal.id);
      this.activeRunState.delete(goal.id);
      return;
    }

    const updated = this.store.get(goal.id);
    if (!updated) {
      this.activeRuns.delete(goal.id);
      this.activeRunState.delete(goal.id);
      return;
    }

    if (updated.status === 'retrying') {
      const attempts = this.store.getAttempts(goal.id);
      const lastVerdict = attempts[attempts.length - 1]?.verdict ?? null;
      const nextStrategy = lastVerdict ? classifyFailure(attempts, lastVerdict) : undefined;
      if (nextStrategy === 'clarify') {
        this.store.updateStatus(goal.id, 'needs_clarification');
        const gaps = lastVerdict?.perCriterion
          .filter((c) => c.gap)
          .map((c) => c.gap)
          .join('; ');
        this.fireGoalNeedsClarification(goal.id, gaps?.length ? gaps : 'clarification needed');
        this.activeRuns.delete(goal.id);
        this.activeRunState.delete(goal.id);
        return;
      }
      const ctx = this.getRetryContext(goal.id);
      if (!ctx) {
        this.activeRuns.delete(goal.id);
        this.activeRunState.delete(goal.id);
        return;
      }
      await this.runAttemptLoop(updated, controller, n + 1, ctx, nextStrategy);
      return;
    }

    // exhausted / needs_clarification / any other terminal status.
    this.activeRuns.delete(goal.id);
    this.activeRunState.delete(goal.id);
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
   * Cancel a running goal.
   */
  cancel(goalId: string): boolean {
    const goal = this.store.get(goalId);
    if (!goal) return false;
    if (goal.status !== 'running' && goal.status !== 'judging' && goal.status !== 'retrying') {
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
    this.store.updateStatus(goalId, 'cancelled', outputPartial ? { outputPartial } : undefined);
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
    const controller = new AbortController();
    this.activeRuns.set(goalId, controller);
    const resumeNote = `The goal run was interrupted: ${refreshed.errorText ?? goal.status}. Review prior progress and continue.`;
    void this.runAttemptLoop(refreshed, controller, n, resumeNote).catch(() => {});
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
  ): Promise<boolean> {
    const goal = this.store.get(goalId);
    if (!goal) return false;

    const spec = goal.acceptanceCriteria;
    if (!spec) {
      this.store.updateStatus(goalId, 'completed', {
        outputMd: output,
        completedAt: Date.now(),
      });
      this.store.appendEvent(goalId, 'done', { attemptN });
      this.fireGoalCompleted(goal, output, summary);
      return true;
    }

    this.store.updateStatus(goalId, 'judging');
    const verdict = await judge({ output, spec });

    this.store.updateAttempt(goalId, attemptN, {
      verdict,
      outputMd: output,
      completedAt: Date.now(),
    });

    const attempts = this.store.getAttempts(goalId);

    if (isConverged(verdict, spec.threshold)) {
      this.store.updateStatus(goalId, 'completed', {
        outputMd: output,
        completedAt: Date.now(),
      });
      this.store.appendEvent(goalId, 'done', {
        score: verdict.score,
        attemptN,
      });
      this.fireGoalCompleted(goal, output, summary);
      return true;
    }

    if (attemptN >= goal.maxAttempts) {
      this.store.updateStatus(goalId, 'exhausted', {
        outputPartial: output,
      });
      this.fireGoalExhausted(goal, output, verdict);
      return false;
    }

    if (attempts.length >= 2) {
      const prevScores = attempts.slice(-2).map((a) => a.verdict?.score ?? 0);
      if (prevScores.every((s) => s >= verdict.score)) {
        this.store.updateStatus(goalId, 'exhausted', {
          outputPartial: output,
        });
        this.fireGoalExhausted(goal, output, verdict);
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
