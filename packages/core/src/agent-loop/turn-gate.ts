// The pressure-gate inputs of a finished turn, shared by the two stages that
// run after `done`: the turn-end trigger (`maybeConsolidateAtTurnEnd`,
// ./turn-end) and the context engine's `pressureRatio` (`runTurnComplete`,
// ./turn-complete). One builder, so the ratio an engine sees and the gate that
// compacts use the same measured counts and the same whole-request units.
// Pinned by `__tests__/turn-complete.test.ts` and
// `__tests__/turn-end-gate-units.test.ts`.

import type { StoredMessage } from '@ethosagent/types';
import type { evaluateGate } from './compaction';
import { turnToolDefinitions } from './stages/stream-step';
import type { LoopDeps } from './turn-context';
import type { TurnEndCtx } from './turn-end';

/** Derive the previous turn's real input + static (system+tools) tokens from the
 *  freshest assistant message usage — the actuals-first gate signal (Phase 0). */
function deriveActuals(raw: StoredMessage[]): {
  lastActualInputTokens?: number;
  staticTokens?: number;
} {
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i];
    if (m?.role === 'assistant' && m.usage?.inputTokens) {
      const rt = m.usage.requestTokens;
      return {
        lastActualInputTokens: m.usage.inputTokens,
        ...(rt ? { staticTokens: rt.system + rt.tools } : {}),
      };
    }
  }
  return {};
}

/** `evaluateGate` deps for a finished turn, from its stored history `raw`. */
export function turnGateDeps(
  deps: Pick<LoopDeps, 'llm' | 'compaction' | 'tools'>,
  ctx: Pick<TurnEndCtx, 'maxCompletionTokens' | 'toolScope'>,
  raw: StoredMessage[],
): Parameters<typeof evaluateGate>[0] {
  const { lastActualInputTokens, staticTokens } = deriveActuals(raw);
  return {
    llm: deps.llm,
    ...(ctx.maxCompletionTokens !== undefined
      ? { reservedOutputTokens: ctx.maxCompletionTokens }
      : {}),
    ...(deps.compaction?.charsPerToken !== undefined
      ? { charsPerToken: deps.compaction.charsPerToken }
      : {}),
    ...(deps.compaction?.gateDelta !== undefined ? { gateDelta: deps.compaction.gateDelta } : {}),
    ...(deps.compaction?.maxSingleToolResultTokens !== undefined
      ? { maxSingleToolResultTokens: deps.compaction.maxSingleToolResultTokens }
      : {}),
    ...(lastActualInputTokens !== undefined ? { lastActualInputTokens } : {}),
    ...(staticTokens !== undefined ? { staticTokens } : {}),
    // Same system prompt + tool schemas as the pre-LLM gate (`maybeCompact`).
    toolSchemas: JSON.stringify(turnToolDefinitions(deps.tools, ctx.toolScope)),
  };
}
