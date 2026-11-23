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

/** What `serveLoopFields` takes; `serveLoopOptions` (serve.ts) adds the mesh name. */
export interface ServeLoopFieldsInput {
  cronScheduler?: ServeLoopOptions['cronScheduler'] | null;
  watcherManager?: ServeLoopOptions['watcherManager'];
  outbox?: ServeLoopOptions['outbox'];
  /**
   * The loop's job affinity (durable-background-jobs D6). Default `'serve'`. A `--team`
   * member passes its own: members share a dataDir, and a flat `serve` label would let
   * one member adopt another's job and run it on the wrong loop.
   */
  jobAffinity?: string;
}

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

/**
 * The `createAgentLoop` options of an `ethos serve` loop, shared by the normal
 * branch and the loop onboarding boots in-process so the two cannot drift.
 * Cron, watchers and the approval outbox exist only when serve starts with a
 * config, so onboarding passes none of them. Pinned by
 * commands/__tests__/serve-onboarding-bind.test.ts.
 *
 * `outbox` travels with `watcherManager` because the watcher tools are what
 * give a serve loop a path to a channel (see `createOutboxProposalSide`). The
 * two loops without them — onboarding and `--team` coordinator — cannot reach a
 * channel at all: `send_message` answers "Gateway not active", because nothing
 * in this process calls `setMessagingSend`.
 */
export function serveLoopFields(
  opts: ServeLoopFieldsInput & { meshRegistryPath: string },
): ServeLoopOptions {
  return {
    profile: SERVE_LOOP_PROFILE,
    meshRegistryPath: opts.meshRegistryPath,
    jobAffinity: opts.jobAffinity ?? 'serve',
    ...(opts.cronScheduler ? { cronScheduler: opts.cronScheduler } : {}),
    ...(opts.watcherManager ? { watcherManager: opts.watcherManager } : {}),
    ...(opts.outbox ? { outbox: opts.outbox } : {}),
  };
}
