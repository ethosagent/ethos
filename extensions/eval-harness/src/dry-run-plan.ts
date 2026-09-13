// The dry-run tool plan, and the scorer that grades against it (plan
// `trust-before-reach.md` X-D12: created by L-T4's replay runner, reused by
// Part 5's P-T9 scenario runner).
//
// ONE plan source: the loop's own `dry_run_summary.plan`
// (`packages/core/src/agent-loop/stages/turn-finalizer.ts` `finalizeTurn`), not
// `tool_start` events. The loop builds that plan from the calls
// `DefaultToolRegistry.executeParallel` synthesized a result for instead of
// executing, so it is the record of what the turn WOULD have run. Two
// consumers re-deriving it from `tool_start` would disagree the first time an
// event is emitted for a call that never reaches the registry (an in-script
// inner call, a hook-rejected call).

import type { AgentEvent, DryRunToolPlan } from '@ethosagent/types';
import type { Scorer } from './scorers';

/**
 * The planned tool calls of a dry-run turn, in order.
 *
 * Empty when the turn planned no calls — `finalizeTurn` emits
 * `dry_run_summary` only when the plan is non-empty — or when the turn was not
 * a dry run at all.
 *
 * Limitation: the plan holds at most `RunOptions.dryRunMaxToolCalls` entries;
 * calls past the cap are only COUNTED (`dry_run_summary.capped`). A tool that
 * appears solely among the capped calls is not in the plan.
 */
export function collectDryRunPlan(events: Iterable<AgentEvent>): DryRunToolPlan[] {
  const plan: DryRunToolPlan[] = [];
  for (const event of events) {
    if (event.type === 'dry_run_summary') plan.push(...event.plan);
  }
  return plan;
}

/** `called` passes when the named tool is in the plan; `not_called` when it is absent. */
export type ToolCallExpectation = 'called' | 'not_called';

/**
 * Grade a tool-choice assertion against a dry-run plan. `expected.expected` is
 * the tool name, matched exactly; the response text is ignored.
 *
 * Inherits `collectDryRunPlan`'s limitation: under `not_called`, a tool that was
 * only among the capped calls passes.
 */
export function toolCalledScorer(
  plan: readonly DryRunToolPlan[],
  expectation: ToolCallExpectation = 'called',
): Scorer {
  const planned = new Set(plan.map((call) => call.toolName));
  return async (_response, expected) => {
    const called = planned.has(expected.expected.trim());
    return called === (expectation === 'called') ? 1 : 0;
  };
}
