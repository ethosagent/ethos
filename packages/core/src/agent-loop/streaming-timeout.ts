/**
 * Default streaming stall watchdog: 20 minutes.
 *
 * An IDLE window, not a turn budget. `stages/stream-step.ts` rearms it on every
 * chunk (`watchdogMs`), so it bounds SILENCE from the provider and a long
 * progressing stream never trips it. 20 minutes because a reasoning model can
 * think for a long time before its first token, and because the two deadlines
 * around it were raised to match: `DEFAULT_LLM_REQUEST_TIMEOUT_MS`
 * (`@ethosagent/types`) and `AgentBridge`'s `DEFAULT_TURN_TIMEOUT_MS`
 * (`@ethosagent/agent-bridge`).
 *
 * Resolution order, read in `stages/stream-step.ts`:
 * `personality.streamingTimeoutMs` → the loop's `options.streamingTimeoutMs` →
 * this constant. Pinned by the 'streaming watchdog default' case in
 * `packages/core/src/__tests__/agent-loop.test.ts`.
 *
 * It lives in its own module rather than in `agent-loop.ts` because that file
 * is held under a line-count guardrail
 * (`__tests__/guardrails.test.ts`, 'agent-loop.ts is under the orchestrator
 * size limit') that only tolerates irreducible pass-through lines.
 */
export const DEFAULT_STREAMING_TIMEOUT_MS = 1_200_000;
