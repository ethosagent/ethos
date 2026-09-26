// The approval gate for CLI commands that run agent turns with nobody at a
// prompt: `ethos -z`, `ethos batch`, `ethos eval`, the judge loop (`buildJudgeRunner`: `ethos personality judge` and the nightly
// scoring pass), `ethos bench`, the `ethos mcp serve` operator console and
// `ethos acp`. Nobody can answer a prompt there, so a flagged call is refused
// (`wireTerminalApprovalGate` with `coordinator: null`,
// apps/ethos/src/terminal-approval.ts) instead of running unasked. Same danger
// check and `approvalMode: off` meaning as `ethos chat`: these are
// operator-invoked, so `off` alone lets a flagged call run.
//
// `ethos cron run` / `ethos cron daemon` are the exception (`gateCronLoop`
// below): a cron job runs unattended, like the gateway's cron/dream loop, so it
// takes the gateway's rule — `off` auto-approves only with the operator's
// `allowUnattendedDangerousTools: true`.

import type { EthosConfig } from '@ethosagent/config';
import { type CreateAgentLoopResult, createLazyProvider } from '@ethosagent/wiring';
import { wireTerminalApprovalGate } from '../terminal-approval';
import { wireUnattendedApprovalGate } from '../unattended-approval-gate';
import { createLLM } from '../wiring';

/** The slice of a built loop the gate needs — `createAgentLoop`'s and
 *  `resolveActiveLoop`'s results both carry it. */
export type GatableLoop = Pick<
  CreateAgentLoopResult,
  'loop' | 'personalities' | 'executionPostureFor' | 'approverDecision'
>;

/**
 * Gate `runtime.loop` so every flagged call is refused, with `why` naming the
 * reason nobody can be asked. Register right after the loop is built, before
 * its first turn. Returns the undo.
 */
export function gateNonInteractiveLoop(
  runtime: GatableLoop,
  config: EthosConfig,
  why: string,
): () => void {
  return wireTerminalApprovalGate(runtime.loop.hooks, {
    personalities: runtime.personalities,
    getProvider: createLazyProvider(() => createLLM(config)),
    model: config.model,
    ...(runtime.approverDecision ? { decision: runtime.approverDecision } : {}),
    executionPostureFor: runtime.executionPostureFor,
    coordinator: null,
    nonInteractive: why,
  });
}

/**
 * Gate a CLI cron loop (`ethos cron run` / `ethos cron daemon`) exactly as the
 * gateway gates its cron/dream loop: `wireUnattendedApprovalGate`
 * (apps/ethos/src/unattended-approval-gate.ts) with the same operator key,
 * `allowUnattendedDangerousTools`. A flagged call is refused, and
 * `approvalMode: off` auto-approves only with that key set. Every turn on this
 * loop is a cron job, so none is a remote-sender turn. Pinned by
 * `__tests__/cron-approval-parity.test.ts`. Returns the undo.
 */
export function gateCronLoop(runtime: GatableLoop, config: EthosConfig): () => void {
  return wireUnattendedApprovalGate(runtime.loop.hooks, {
    personalities: runtime.personalities,
    getProvider: createLazyProvider(() => createLLM(config)),
    model: config.model,
    allowUnattendedDangerousTools: config.allowUnattendedDangerousTools === true,
    isRemoteSenderTurn: () => false,
    ...(runtime.approverDecision ? { decision: runtime.approverDecision } : {}),
    executionPostureFor: runtime.executionPostureFor,
  });
}
