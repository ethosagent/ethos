import type { BeforeToolCallResult, HookRegistry, VoiceTurnOrigin } from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
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
 * input (canonically), the hook is fired once more on the rewritten args; that
 * pass may block, and if it rewrites to anything else again the call is
 * refused rather than running args no guard saw. Pinned by the 'guards re-judge
 * hook-rewritten args (S10)' cases in the same test file.
 */
export async function enforceBeforeToolCall(
  deps: BeforeToolCallDeps,
  input: BeforeToolCallInput,
): Promise<BeforeToolCallDecision> {
  const denied = checkDenyRules(deps, input, input.args);
  if (denied) return denied;

  const first = await fireBeforeToolCall(deps, input, input.args);
  if (!first.allowed) return first;

  const effectiveArgs = first.effectiveArgs;
  if (canonicalizeArgs(effectiveArgs) === canonicalizeArgs(input.args)) {
    return { allowed: true, effectiveArgs };
  }

  const deniedAfterRewrite = checkDenyRules(deps, input, effectiveArgs);
  if (deniedAfterRewrite) return deniedAfterRewrite;

  const second = await fireBeforeToolCall(deps, input, effectiveArgs);
  if (!second.allowed) return second;
  if (canonicalizeArgs(second.effectiveArgs) !== canonicalizeArgs(effectiveArgs)) {
    const reason =
      'tool call refused: a before_tool_call hook rewrote the arguments again after they were re-checked';
    deps.observability?.recordSafetyBlock({
      traceId: input.traceId,
      code: 'tool_blocked',
      cause: reason,
    });
    return { allowed: false, reason };
  }

  return { allowed: true, effectiveArgs };
}

/** One `before_tool_call` fire on `args`, with the approver sink bound for its span. */
async function fireBeforeToolCall(
  deps: BeforeToolCallDeps,
  input: BeforeToolCallInput,
  args: unknown,
): Promise<BeforeToolCallDecision> {
  const releaseApproverSink = input.bindApproverSink?.();
  let beforeResult: BeforeToolCallResult;
  try {
    beforeResult = await deps.hooks.fireModifying(
      'before_tool_call',
      {
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args,
        ...(input.voiceOrigin ? { voiceOrigin: input.voiceOrigin } : {}),
        ...(input.personalityId !== undefined ? { personalityId: input.personalityId } : {}),
      },
      input.allowedPlugins,
    );
  } finally {
    releaseApproverSink?.();
  }

  if (beforeResult.error) {
    deps.observability?.recordSafetyBlock({
      traceId: input.traceId,
      code: 'tool_blocked',
      cause: beforeResult.error,
    });
    return { allowed: false, reason: beforeResult.error };
  }

  return { allowed: true, effectiveArgs: beforeResult.args ?? args };
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
