// Serve-role construction seams, loop half: the types the serve builders share
// and the danger predicate behind the web approval modal, which `ethos serve`
// shares between its normal branch and the loop onboarding boots in-process.
// No module state.
//
// `serve.ts` re-exports `buildServeDangerPredicate`, so its export surface is
// unchanged (apps/ethos/src/__tests__/serve-export-surface.test.ts).

import type { EthosConfig } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import type { createPersonalityRegistry } from '@ethosagent/personalities';
import {
  APPROVAL_SURFACE_ALWAYS_ASK,
  createApprovalDangerPredicate,
  createLazyProvider,
  type SmartApproverDecisionSite,
} from '@ethosagent/wiring';
import { type createAgentLoop, createLLM } from '../wiring';

export type ServePersonalityRegistry = Awaited<ReturnType<typeof createPersonalityRegistry>>;

export type ServeLoopOptions = NonNullable<Parameters<typeof createAgentLoop>[1]>;

/** Every `ethos serve` loop runs the web profile: no terminal guard — the web
 *  approval hook is the gate for dangerous calls. */
export const SERVE_LOOP_PROFILE = 'web' as const;

/**
 * The danger check behind the web approval modal, shared by the normal web API
 * and the loop onboarding binds after boot. Same `checkCommand` rules the CLI
 * guard uses, surfaced through the modal instead of a hard block; threaded
 * with the turn's personality (learned from the loop's `session_start`) so
 * `approvalMode` is enforced, plus a lazy provider handle for
 * `approvalMode: 'smart'` — nothing is constructed unless a flagged call
 * actually reaches the reviewer. `decision` is the smart reviewer's decision
 * site from the same build as `loop` (`CreateAgentLoopResult.approverDecision`,
 * plan decision-provider-jev §8.2); absent, the reviewer is the LLM path only.
 */
export function buildServeDangerPredicate(
  loop: AgentLoop,
  personalities: ServePersonalityRegistry,
  config: EthosConfig,
  executionPostureFor: import('@ethosagent/wiring').CreateAgentLoopResult['executionPostureFor'],
  usageMeter: Pick<import('@ethosagent/wiring').UsageMeter, 'meter'>,
  decision?: SmartApproverDecisionSite,
): ReturnType<typeof createApprovalDangerPredicate> {
  return createApprovalDangerPredicate({
    hooks: [loop.hooks],
    personalities,
    getProvider: createLazyProvider(() => createLLM(config)),
    model: config.model,
    alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
    ...(decision ? { decision } : {}),
    executionPostureFor,
    usageMeter,
  });
}
