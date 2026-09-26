import type { TokenUsage, ToolResult } from '@ethosagent/types';
import type { TurnUsageAccumulator } from './stages/turn-finalizer';

/**
 * The `usage` a tool_result row carries for a tool-reported `cost_usd` (image
 * generation, a vision call) — spread into its `appendMessage` — or `{}` when
 * the tool reported none.
 *
 * Stored spend is SUM(messages.estimated_cost_usd) — `usageAggregate` in
 * extensions/session-sqlite, behind `ethos usage`, the per-bot daily cap and
 * web Usage — so the cost has to land on a message row. Zero tokens: the tool
 * consumed none of the model's. The same figure joins the turn's rollup
 * accumulator so the session total stays equal to that sum
 * (`flushTurnUsage`, stages/turn-finalizer.ts). Pinned by
 * packages/core/src/__tests__/tool-cost-persistence.test.ts.
 */
export function toolCostFields(
  result: ToolResult,
  turnUsage: TurnUsageAccumulator | undefined,
): { usage?: TokenUsage } {
  if (!result.ok || !result.cost_usd || result.cost_usd <= 0) return {};
  if (turnUsage) turnUsage.estimatedCostUsd += result.cost_usd;
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: result.cost_usd,
  };
  return { usage };
}
