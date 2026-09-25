import type { PersonalityConfig, ToolRegistry } from '@ethosagent/types';

/**
 * Whether a call to `toolName` passes `personality`'s base allowlist — its
 * `toolset`, `mcp_servers` and `plugins`, the lists `stages/turn-setup.ts`
 * builds a turn's `allowedTools` / `filterOpts` from, checked with the same
 * `toDefinitions` rule `DefaultToolRegistry.executeParallel` refuses a call
 * outside of. `false` therefore means the call cannot run. `true` is not a
 * promise: a turn can narrow further (`toolsetOverride`, `toolsetNarrow`,
 * small-window toolsets, per-tool MCP policy, exclusions), and every one of
 * those only narrows.
 *
 * Exposed as `AgentLoop.isToolPermitted` for approval surfaces, so a human is
 * not asked about a call that will be refused anyway (`notPermittedRefusal`,
 * apps/ethos/src/approval-coordinator.ts). Pinned by
 * `__tests__/tool-permitted.test.ts`.
 */
export function isToolPermitted(
  tools: Pick<ToolRegistry, 'toDefinitions'>,
  personality: PersonalityConfig,
  toolName: string,
): boolean {
  return tools
    .toDefinitions(personality.toolset, {
      allowedMcpServers: personality.mcp_servers ?? [],
      allowedPlugins: personality.plugins ?? [],
    })
    .some((d) => d.name === toolName);
}
