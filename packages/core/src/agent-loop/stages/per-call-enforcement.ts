import type {
  BeforeToolCallResult,
  HookRegistry,
  InjectionDefenseKit,
  PersonalityConfig,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { activeRunTaint, type RunTaintLink, withRunTaint } from '../../scoped/run-taint';
import { type IdenticalStreak, updateIdenticalStreak } from '../budgets';
import { canonicalizeArgs, denyRuleReason, matchDenyRule } from '../deny-rules';
import type { HaltDecision, WatcherTap } from '../turn-context';

// ---------------------------------------------------------------------------
// Per-call enforcement — the segment of the tool pipeline that must run for
// EVERY tool call regardless of who issued it (the LLM via the tool-processing
// stage; a script via the ScriptToolBridge). Extracted so both callers share
// one `before_tool_call` fire site, one watcher-halt consult, and one set of
// turn budget counters. `enforceBeforeToolCall` has a third caller outside
// `AgentLoop.run()`: the realtime voice host's direct tool dispatch
// (`createRealtimeToolHost`, extensions/tools-voice/src/realtime-host.ts),
// pinned by that package's `__tests__/realtime-host.test.ts` ("core
// enforcement"). It takes the deny-rule and hook gate only — no watcher tap or
// turn budget exists there.
// ---------------------------------------------------------------------------

export interface BeforeToolCallDeps {
  hooks: HookRegistry;
  observability?: AgentLoopObservability;
}

export interface BeforeToolCallInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  allowedPlugins: string[];
  traceId: string | undefined;
  /** Set when the turn arrived as speech — forwarded verbatim onto the hook
   *  payload so the danger predicate can apply the spoken-confirmation gate. */
  voiceOrigin?: VoiceTurnOrigin;
  /** The turn's personality — forwarded onto the hook payload so a gate on a
   *  loop shared across personalities can authorise the actual caller. */
  personalityId?: string;
  /** The turn personality's `safety.denyRules`. A match refuses the call
   *  before any `before_tool_call` hook runs (see `enforceBeforeToolCall`). */
  denyRules?: ReadonlyArray<string>;
  /** Binds this call's approver decision sink (plan decision-provider-personality
   *  §15.3) in `ApproverDecisionSinks` for the span of the hook fire, and returns
   *  its release. NOT on the hook payload — a plugin handler must not be able to
   *  emit a decision row (../approver-decision-sinks.ts). Absent unless the
   *  personality declares decision sites and an approver channel was injected. */
  bindApproverSink?: () => () => void;
}

export type BeforeToolCallDecision =
  | { allowed: true; effectiveArgs: unknown }
  | { allowed: false; reason: string };

/**
 * Fire the `before_tool_call` modifying hook for one tool call. A hook error
 * blocks the call (the caller decides how to surface the rejection); a hook
 * `args` override becomes the effective args for execution.
 *
 * Personality deny rules are the hard floor and are checked HERE, not in a
 * hook: a deny-rule match refuses the call before `fireModifying` is called,
 * so no approval hook posts a card and no allowlist is consulted. A hook could
 * not do this — `fireModifying` runs every handler even after one sets
 * `error`, and swallows a throwing handler. When a hook rewrites the args the
 * rules are checked again on the rewritten args. Pinned by
 * `../__tests__/deny-rule-gate.test.ts`.
 *
 * A rewrite is also re-judged by the hooks themselves. The approval predicate
 * and the terminal guard are `before_tool_call` handlers, and `fireModifying`
 * hands every handler the ORIGINAL payload, so in one pass they judge args a
 * sibling's override then replaces. When the merged `args` differ from the
 * input (canonically), the hook is fired once more on the rewritten args, with
 * `rewrittenFrom` set to the originals. That fire is JUDGE-ONLY: an `error`
 * refuses the call, any `args` it returns are discarded, and what runs is
 * exactly the args it judged — so a handler that rewrites again (a prefixer
 * that always prepends) neither stacks nor refuses. The cost: an approval hook
 * that asked on the first fire asks again on the second, the second prompt
 * being the one that governs what runs (see `BeforeToolCallPayload.rewrittenFrom`).
 * Pinned by the 'guards re-judge hook-rewritten args (S10)' cases in the same test file.
 */
export async function enforceBeforeToolCall(
  deps: BeforeToolCallDeps,
  input: BeforeToolCallInput,
): Promise<BeforeToolCallDecision> {
  const denied = checkDenyRules(deps, input, input.args);
  if (denied) return denied;

  // Core's private copy; handlers only ever see frozen copies (`fireBeforeToolCall`).
  const proposed = isolateArgs(input.args);
  if (!proposed.ok) return refuse(deps, input, UNCLONEABLE_ARGS_REASON);

  const first = await fireBeforeToolCall(deps, input, proposed.value);
  if (!first.allowed) return first;

  const effectiveArgs = first.effectiveArgs;
  if (canonicalizeArgs(effectiveArgs) === canonicalizeArgs(proposed.value)) {
    return { allowed: true, effectiveArgs };
  }

  const deniedAfterRewrite = checkDenyRules(deps, input, effectiveArgs);
  if (deniedAfterRewrite) return deniedAfterRewrite;

  // Judge-only: the verdict counts, a rewrite returned here is discarded, and
  // the args that run are exactly the `effectiveArgs` this fire judged.
  const second = await fireBeforeToolCall(deps, input, effectiveArgs, proposed.value);
  if (!second.allowed) return second;

  return { allowed: true, effectiveArgs };
}

const UNCLONEABLE_ARGS_REASON =
  'tool call refused: its arguments could not be copied for the before_tool_call guards';

/**
 * One `before_tool_call` fire on `args`, with the approver sink bound for its
 * span. `rewrittenFrom` is set on the re-judge fire only.
 *
 * Isolation: `args` is core's private copy and is never handed to a handler.
 * Handlers receive a deep-frozen clone inside a frozen payload, so a handler
 * that edits `payload.args` in place (instead of returning `args`) can neither
 * change what later handlers judge nor what executes — in strict-mode code the
 * write throws, which `fireModifying` swallows, dropping that handler's result.
 * A returned `args` is cloned the moment the fire ends, so a handler that keeps
 * a reference to the object it returned cannot edit it after the guards judged
 * it. Args that cannot be cloned are refused, never passed through. Pinned by
 * cases (l) and (m) in `../__tests__/deny-rule-gate.test.ts`.
 */
async function fireBeforeToolCall(
  deps: BeforeToolCallDeps,
  input: BeforeToolCallInput,
  args: unknown,
  rewrittenFrom?: unknown,
): Promise<BeforeToolCallDecision> {
  const view = isolateArgs(args, true);
  const originalView = rewrittenFrom === undefined ? undefined : isolateArgs(rewrittenFrom, true);
  if (!view.ok || originalView?.ok === false) {
    return refuse(deps, input, UNCLONEABLE_ARGS_REASON);
  }

  const releaseApproverSink = input.bindApproverSink?.();
  let beforeResult: BeforeToolCallResult;
  try {
    beforeResult = await deps.hooks.fireModifying(
      'before_tool_call',
      Object.freeze({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: view.value,
        ...(input.voiceOrigin ? { voiceOrigin: input.voiceOrigin } : {}),
        ...(input.personalityId !== undefined ? { personalityId: input.personalityId } : {}),
        ...(originalView?.ok ? { rewrittenFrom: originalView.value } : {}),
      }),
      input.allowedPlugins,
    );
  } finally {
    releaseApproverSink?.();
  }

  if (beforeResult.error) {
    return refuse(deps, input, beforeResult.error);
  }

  if (beforeResult.args === undefined) return { allowed: true, effectiveArgs: args };
  const rewritten = isolateArgs(beforeResult.args);
  if (!rewritten.ok) return refuse(deps, input, UNCLONEABLE_ARGS_REASON);
  return { allowed: true, effectiveArgs: rewritten.value };
}

/** Record a `tool_blocked` safety block and refuse the call with `reason`. */
function refuse(
  deps: BeforeToolCallDeps,
  input: BeforeToolCallInput,
  reason: string,
): BeforeToolCallDecision {
  deps.observability?.recordSafetyBlock({
    traceId: input.traceId,
    code: 'tool_blocked',
    cause: reason,
  });
  return { allowed: false, reason };
}

/**
 * A structured clone of `value`, deep-frozen when `freeze` is set. Tool args
 * are JSON from the model, so the clone always succeeds in practice; a value
 * that cannot be cloned (a function, a class instance with private state) is
 * reported as `ok: false` for the caller to refuse.
 */
function isolateArgs(value: unknown, freeze = false): { ok: true; value: unknown } | { ok: false } {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    return { ok: false };
  }
  if (freeze) deepFreeze(copy);
  return { ok: true, value: copy };
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function checkDenyRules(
  deps: BeforeToolCallDeps,
  input: BeforeToolCallInput,
  args: unknown,
): BeforeToolCallDecision | null {
  const rule = matchDenyRule(input.denyRules, input.toolName, args);
  if (rule === null) return null;
  const reason = denyRuleReason(rule);
  deps.observability?.recordSafetyBlock({
    traceId: input.traceId,
    code: 'deny_rule',
    cause: reason,
  });
  return { allowed: false, reason };
}

/**
 * Consult the watcher tap for a non-allow decision. Returns the halt (so a
 * caller that must abort — e.g. a script execution — can inspect the action)
 * plus the standard rejection reason for calls that will not execute.
 */
export function consultWatcherHalt(
  getHalt: WatcherTap['getHalt'],
): { halted: false } | { halted: true; halt: HaltDecision; rejectionReason: string } {
  const halt = getHalt();
  if (!halt) return { halted: false };
  return {
    halted: true,
    halt,
    rejectionReason: `Watcher halted before execution: ${halt.reason}`,
  };
}

/**
 * Turn-scoped budget counters read by `checkTurnBudgets`. Held as one mutable
 * object so every caller that records a tool call increments the SAME
 * counters — the turn budget arithmetic does not distinguish who asked.
 */
export interface TurnBudgetCounters {
  totalToolCalls: number;
  toolNameCounts: Map<string, number>;
  identicalStreak: IdenticalStreak | null;
  /**
   * Soft-warn rules already nudged about this turn. Turn-scoped like the
   * counters it sits with, which is what makes the nudge fire once per turn
   * instead of on every iteration past the threshold.
   */
  warned: Set<string>;
}

/** Fresh counters for one user turn. */
export function createTurnBudgetCounters(): TurnBudgetCounters {
  return {
    totalToolCalls: 0,
    toolNameCounts: new Map(),
    identicalStreak: null,
    warned: new Set(),
  };
}

/** Fold one tool call into the turn's budget counters. */
export function recordToolCallForBudgets(
  counters: TurnBudgetCounters,
  toolName: string,
  args: unknown,
): void {
  counters.totalToolCalls++;
  counters.toolNameCounts.set(toolName, (counters.toolNameCounts.get(toolName) ?? 0) + 1);
  counters.identicalStreak = updateIdenticalStreak(counters.identicalStreak, toolName, args);
}

// ---------------------------------------------------------------------------
// Ch.3d post-untrusted-read downgrade — the rule, kept here beside the other
// per-call gates; `processTools` (./tool-processing.ts) is the one caller.
// ---------------------------------------------------------------------------

/**
 * Downgraded tools whose output a FUTURE system prompt carries: memory, team
 * memory and proposed skills. For these the step window is not enough
 * (V-ES-9): the untrusted text stays in context after the window lifts, so a
 * page saying "remember: …" reached MEMORY.md two steps later in the same
 * run. Once this run has seen any `outputIsUntrusted` result they stay
 * refused until the run ends — the next user message starts a fresh run
 * (`dgRemainingRef` in ../../agent-loop.ts). Applies only to tools that are
 * ALSO in the personality's downgrade list, so an operator who removes one
 * from `postReadDowngrade.tools` removes it here too. Pinned by
 * `../../__tests__/downgrade-memory-writes.test.ts`.
 */
export const RUN_SCOPED_DOWNGRADE_TOOLS: ReadonlySet<string> = new Set([
  'memory_write',
  'team_memory_write',
  'skill_propose',
]);

/**
 * Tools that schedule a LATER run whose prompt this run writes (V2-SEC-2): a
 * cron job, a goal, a kanban ticket, a background sub-agent. That text is
 * authored under the taint, and the run it seeds starts fresh — so, like the
 * memory writers, they stay refused for the rest of the run once an untrusted
 * result was seen. Refused rather than marked tainted-origin because the runs
 * they seed are started by schedulers this loop does not own (the cron
 * scheduler, the kanban dispatcher, `BackgroundExecutor`); a mark nothing reads
 * would be a guarantee with no enforcer. Not part of the operator's
 * `postReadDowngrade.tools` list (that list is also the step window, and a
 * foreground `delegate_task` or `cron list` has no reason to pause), so
 * `postReadDowngrade.enabled: false` is their off switch. The predicate
 * answers for the call's args; absent args (an in-script call through
 * `ScriptToolBridge`, which passes none) refuse — fail closed. Pinned by
 * `../../__tests__/downgrade-derived-runs.test.ts`.
 */
const CRON_NON_AUTHORING = ['list', 'get', 'read_run', 'pause', 'resume', 'run', 'remove'];
type SchedulerRule = (args: Record<string, unknown>) => boolean;
const RUN_SCOPED_SCHEDULERS: ReadonlyMap<string, SchedulerRule> = new Map<string, SchedulerRule>([
  // Only `create`/`update` author a prompt; the other actions name an existing job.
  ['cron', (a) => !CRON_NON_AUTHORING.includes(String(a.action))],
  ['goal_create', () => true],
  ['kanban_create', () => true],
  ['kanban_create_goal', () => true],
  ['kanban_create_swarm', () => true],
  ['kanban_decompose', () => true],
  ['delegate_task', (a) => a.background === true],
]);

/** One run's downgrade state: the step window, and whether any untrusted result was seen. */
export interface DowngradeState {
  value: number;
  untrustedSeen?: boolean;
  /** Called once, when `untrustedSeen` first turns true — taints the run this one derives from. */
  onTaint?: () => void;
}

/** True when the downgrade refuses `toolName` (called with `args`) right now. */
export function isDowngraded(
  state: DowngradeState,
  enabled: boolean,
  tools: ReadonlySet<string>,
  toolName: string,
  args?: unknown,
): boolean {
  if (!enabled) return false;
  const scheduler = RUN_SCOPED_SCHEDULERS.get(toolName);
  if (state.untrustedSeen === true && scheduler) {
    const record = typeof args === 'object' && args !== null ? args : undefined;
    if (!record || scheduler(record as Record<string, unknown>)) return true;
  }
  if (!tools.has(toolName)) return false;
  if (state.value > 0) return true;
  return state.untrustedSeen === true && RUN_SCOPED_DOWNGRADE_TOOLS.has(toolName);
}

function taint(state: DowngradeState): void {
  if (state.untrustedSeen === true) return;
  state.untrustedSeen = true;
  state.onTaint?.();
}

/**
 * An untrusted result seen INSIDE an iteration — an in-script call through the
 * `ScriptToolBridge` (./script-tool-bridge.ts), or a derived run's taint
 * reported back (`resolveRunDowngrade`) — arms the window and the run-scoped
 * taint at once, so a later call in the same iteration is refused too. The
 * iteration-end `advanceDowngrade` then runs as usual.
 */
export function armDowngrade(state: DowngradeState, enabled: boolean, turns: number): void {
  if (!enabled) return;
  state.value = Math.max(state.value, turns);
  taint(state);
}

/**
 * End of one iteration: decrement the prior window, then arm a fresh one (and
 * the run-scoped taint) if this iteration read untrusted content. The
 * decrement-then-set order means an untrusted read in iteration N protects
 * iterations N+1 .. N+turns.
 */
export function advanceDowngrade(
  state: DowngradeState,
  enabled: boolean,
  turns: number,
  untrustedRead: boolean,
): void {
  if (state.value > 0) state.value--;
  if (enabled && untrustedRead) {
    state.value = turns;
    taint(state);
  }
}

type DowngradeConfig = NonNullable<
  NonNullable<NonNullable<PersonalityConfig['safety']>['injectionDefense']>['postReadDowngrade']
>;

/**
 * One run's downgrade settings and state, fresh per `AgentLoop.run()` (a new
 * user message lifts the refusals). A run started INSIDE a tool call of
 * another run — a sub-agent — is DERIVED from it (V2-SEC-2): when that run is
 * already tainted this one starts armed (window and taint), and when this one
 * reads untrusted content it taints that run too, whose context receives this
 * run's answer. The link comes from `activeRunTaint` (../../scoped/run-taint.ts),
 * so it follows every nested `run()` without the tool forwarding anything.
 * Pinned by `../../__tests__/downgrade-derived-runs.test.ts`.
 *
 * A run DETACHED from its origin — a background job's child, the gateway's
 * parent-review turn of that job — has no open link, so `origin` carries it
 * explicitly: `untrustedOrigin` starts the run armed (`RunOptions.untrustedOrigin`,
 * set by `Gateway` for a job whose `BackgroundJob.tainted` is recorded) and
 * `onUntrustedRead` reports this run's own taint (`RunOptions.onUntrustedRead`,
 * wired by `EthosJobRunner` to `JobRunnerContext.markTainted`). Pinned by
 * extensions/job-runner/src/__tests__/untrusted-taint.test.ts.
 */
export function resolveRunDowngrade(
  config: DowngradeConfig | undefined,
  injection: Pick<InjectionDefenseKit, 'resolveDowngradedTools'>,
  origin: { untrustedOrigin?: boolean; onUntrustedRead?: () => void } = {},
): { dgEnabled: boolean; dgTurns: number; dgTools: Set<string>; dgRemainingRef: DowngradeState } {
  const dgEnabled = config?.enabled !== false;
  const dgTurns = config?.turns ?? 2;
  const dgRemainingRef: DowngradeState = { value: 0 };
  const parent = activeRunTaint();
  // Armed BEFORE `onTaint` is set: starting tainted is not news to the parent.
  if (parent?.state.untrustedSeen === true || origin.untrustedOrigin === true) {
    armDowngrade(dgRemainingRef, dgEnabled, dgTurns);
  }
  const notify = origin.onUntrustedRead;
  if (dgRemainingRef.untrustedSeen === true) notify?.();
  if (parent || notify) {
    dgRemainingRef.onTaint = () => {
      if (parent?.open) parent.mark();
      notify?.();
    };
  }
  return {
    dgEnabled,
    dgTurns,
    dgTools: injection.resolveDowngradedTools(config?.tools),
    dgRemainingRef,
  };
}

/**
 * Run one tool batch with this run's taint visible to everything the batch
 * starts (`withRunTaint`, ../../scoped/run-taint.ts): a sub-agent run reads it
 * in `resolveRunDowngrade`, `ScopedFsImpl.checkReach` reads it for writes into
 * the Ethos state dir. The link closes when the batch settles.
 */
export function runToolsInTaintScope<T>(
  dg: { dgRemaining: DowngradeState; dgEnabled: boolean; dgTurns: number },
  batch: () => Promise<T>,
): Promise<T> {
  const link: RunTaintLink = {
    state: dg.dgRemaining,
    open: true,
    mark: () => armDowngrade(dg.dgRemaining, dg.dgEnabled, dg.dgTurns),
  };
  return withRunTaint(link, batch).finally(() => {
    link.open = false;
  });
}
