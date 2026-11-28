import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';
import { toolCallUsd } from './tool-prices';

/**
 * L4. Register on the run's own DefaultHookRegistry as a `before_tool_call`
 * modifying handler. It fires through `enforceBeforeToolCall`
 * (packages/core/src/agent-loop/stages/per-call-enforcement.ts), the one choke
 * point for model calls and script calls alike, so a name outside `allowed` is
 * refused before execution and the loop still persists an error `tool_result`.
 */
export function createInitiativeToolGate(
  allowed: ReadonlySet<string>,
  /**
   * Charges a paid tool's estimated price (tool-prices.ts) to the window guard before the call
   * runs; returns the cap that refused it, or null. Absent = no metering (tests of the allowlist).
   */
  charge?: (toolName: string, usd: number) => 'day' | 'window' | 'exploration' | null,
): (p: BeforeToolCallPayload) => Promise<BeforeToolCallResult> {
  return async (p) => {
    if (!allowed.has(p.toolName)) {
      return {
        error: `Tool ${p.toolName} is not permitted in an initiative run (read-only exploration).`,
      };
    }
    const usd = toolCallUsd(p.toolName);
    if (usd > 0 && charge) {
      const refused = charge(p.toolName, usd);
      if (refused) {
        return {
          error: `Tool ${p.toolName} was not run: its estimated $${usd.toFixed(3)} would cross the ${refused} budget cap, so this window is ending.`,
        };
      }
    }
    return {};
  };
}
