import type { AgentLoop } from '@ethosagent/core';
import type { Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createDelegationTools } from './index';

export interface DelegationToolsCompose {
  tools: Tool[];
}

/**
 * NOTE: Must be called AFTER AgentLoop is constructed. The delegation tools
 * close over the loop instance to spawn child agents; calling this before the
 * loop exists will result in a null/undefined loop reference at tool execution
 * time.
 */
export function compose(
  _ctx: WiringContext,
  deps: { loop: AgentLoop; meshRegistryPath?: string },
): DelegationToolsCompose {
  return { tools: createDelegationTools(deps.loop, deps.meshRegistryPath) };
}
