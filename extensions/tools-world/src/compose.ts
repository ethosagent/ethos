import type { Tool, WiringContext } from '@ethosagent/types';
import type { WorldToolPort } from '@ethosagent/world-service';
import { fail, type ToolDef } from './common';
import { createReadTools, createWorldTools } from './index';

export interface WorldToolsCompose {
  tools: Tool[];
}

/** The registry holds `Tool<unknown>`; the world tools take an object, so refuse anything else. */
function adapt(tool: ToolDef): Tool {
  return {
    ...tool,
    execute: async (args, ctx) =>
      typeof args === 'object' && args !== null && !Array.isArray(args)
        ? tool.execute({ ...args }, ctx)
        : fail('input_invalid', 'arguments must be an object'),
  };
}

/**
 * The ten `world_*` tools over one port. The only input is a `WorldToolPort`, so wiring cannot
 * hand the tools a provider (R13 at the seam: packages/wiring/src/__tests__/worlds-wiring.test.ts
 * 'tool registry receives a port, never a provider').
 */
export function compose(_ctx: WiringContext, deps: { port: WorldToolPort }): WorldToolsCompose {
  return { tools: createWorldTools(deps.port).map(adapt) };
}

/**
 * Only the three read tools (`world_query`, `world_neighbours`, `world_history`) over one port.
 * The initiative run registry uses this so a run never holds a world write tool; the write and
 * bulk tools are not constructed at all (pinned by
 * packages/wiring/src/__tests__/initiative-world-reads.test.ts).
 */
export function composeReadTools(deps: { port: WorldToolPort }): Tool[] {
  return createReadTools(deps.port).map(adapt);
}
