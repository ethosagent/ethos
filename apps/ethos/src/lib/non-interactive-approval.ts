// The approval gate for CLI commands that run agent turns with nobody at a
// prompt: `ethos -z`, `ethos batch`, `ethos eval`, `ethos cron run`/`daemon`,
// the judge loop (`buildJudgeRunner`: `ethos personality judge` and the nightly
// scoring pass), `ethos bench`, the `ethos mcp serve` operator console and
// `ethos acp`. Nobody can answer a prompt there, so a flagged call is refused
// (`wireTerminalApprovalGate` with `coordinator: null`,
// apps/ethos/src/terminal-approval.ts) instead of running unasked. Same danger
// check and `approvalMode: off` meaning as `ethos chat`.

import type { EthosConfig } from '@ethosagent/config';
import { type CreateAgentLoopResult, createLazyProvider } from '@ethosagent/wiring';
import { wireTerminalApprovalGate } from '../terminal-approval';
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
