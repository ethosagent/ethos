// @ethosagent/tools-interactive — tools that need a bidirectional channel
// between the agent and the user's surface. Currently: `clarify`.

import type { ClarifyBridge } from '@ethosagent/core';
import type { Tool } from '@ethosagent/types';
import { createClarifyTool } from './clarify-tool';

export { createClarifyTool } from './clarify-tool';

/** Build the interactive toolset, wired to the process's ClarifyBridge. */
export function createInteractiveTools(bridge: ClarifyBridge): Tool[] {
  return [createClarifyTool(bridge) as Tool];
}
