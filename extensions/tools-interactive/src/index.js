// @ethosagent/tools-interactive — tools that need a bidirectional channel
// between the agent and the user's surface. Currently: `clarify`.
import { createClarifyTool } from './clarify-tool';

export { createClarifyTool } from './clarify-tool';
/** Build the interactive toolset, wired to the process's ClarifyBridge. */
export function createInteractiveTools(bridge) {
  return [createClarifyTool(bridge)];
}
