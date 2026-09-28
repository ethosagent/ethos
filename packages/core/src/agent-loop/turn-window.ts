import type { LLMProvider } from '@ethosagent/types';

/**
 * The window a turn routed to `modelOverride` is gated against, when it is
 * SMALLER than the provider's reported window (`llm.maxContextTokens` is the
 * configured model's). `contextWindowFor` is `LoopDeps.compaction.contextWindowFor`
 * (wiring: the model catalog). Only ever lowers the gate: a larger or unknown
 * override window → `undefined`, and the provider's window applies. Without
 * it an Opus-configured provider (1M) routing a turn to Haiku 4.5 (200K)
 * would let history grow to the 1M gate and overflow Haiku. Stored on
 * `TurnSetup.gateWindowTokens` and read by every pressure gate of the turn
 * (`evaluateGate`'s `windowTokens`, ./compaction); pinned by
 * `__tests__/override-context-window.test.ts`.
 */
export function turnGateWindow(
  llm: Pick<LLMProvider, 'maxContextTokens'>,
  contextWindowFor: ((model: string) => number | undefined) | undefined,
  modelOverride: string | undefined,
): number | undefined {
  if (modelOverride === undefined || !contextWindowFor) return undefined;
  const override = contextWindowFor(modelOverride);
  if (override === undefined || override <= 0) return undefined;
  return override < (llm.maxContextTokens || 200_000) ? override : undefined;
}
