import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';

/**
 * L4. Register on the run's own DefaultHookRegistry as a `before_tool_call`
 * modifying handler. It fires through `enforceBeforeToolCall`
 * (packages/core/src/agent-loop/stages/per-call-enforcement.ts), the one choke
 * point for model calls and script calls alike, so a name outside `allowed` is
 * refused before execution and the loop still persists an error `tool_result`.
 */
export function createInitiativeToolGate(
  allowed: ReadonlySet<string>,
): (p: BeforeToolCallPayload) => Promise<BeforeToolCallResult> {
  return async (p) =>
    allowed.has(p.toolName)
      ? {}
      : {
          error: `Tool ${p.toolName} is not permitted in an initiative run (read-only exploration).`,
        };
}
