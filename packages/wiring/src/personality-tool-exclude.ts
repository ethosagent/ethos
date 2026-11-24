import { decisionToolEnabled, type ResolvedDecisionsConfig } from '@ethosagent/config';
import { PROPOSE_SELF_AMENDMENT_TOOL } from '@ethosagent/tools-personality-design';
import type { PersonalityConfig } from '@ethosagent/types';

/**
 * The loop's per-personality tool exclusion (`AgentLoopConfig.personalityToolExclude`).
 * Depends only on the personality, so tool definitions stay byte-stable per
 * personality. Always defined (plan personality-memory-boundary G2): it is the
 * union of
 *   - plan decision-tool D6/D13 — `decide` is visible only to a personality
 *     that picked the operator's decision model (`decisionToolEnabled`,
 *     @ethosagent/config); with no `decisions.*` there is no `decide` to hide;
 *   - `propose_self_amendment` is visible only to a personality whose toolset
 *     lists it. A personality with an undeclared toolset sees every other
 *     registered tool, so without this its tool list — and its cached prompt
 *     prefix — would change the day the tool was registered. The execute-time
 *     gate is the same list (`executeParallel`'s `excludeTools`). Pinned by
 *     packages/wiring/src/__tests__/amendment-exclude.test.ts;
 *   - plan laptop-tool-node D18 — with `nodes.enabled`, the `node_*` tools are visible only to a
 *     personality whose toolset lists them (`opts.nodeTools`). Pinned by
 *     packages/wiring/src/__tests__/compose-tools-node.test.ts.
 */
export function buildPersonalityToolExclude(
  decisions: Pick<ResolvedDecisionsConfig, 'provider'> | undefined,
  opts?: { nodeTools?: readonly string[] },
): (person: PersonalityConfig) => string[] {
  return (person) => [
    ...(decisions && !decisionToolEnabled(person.decisions, decisions) ? ['decide'] : []),
    ...(person.toolset?.includes(PROPOSE_SELF_AMENDMENT_TOOL) ? [] : [PROPOSE_SELF_AMENDMENT_TOOL]),
    ...(opts?.nodeTools ?? []).filter((n) => !person.toolset?.includes(n)),
  ];
}
