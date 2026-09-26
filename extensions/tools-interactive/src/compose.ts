import type { ClarifyBridge } from '@ethosagent/core';
import type { Tool, WiringContext } from '@ethosagent/types';
import { createInteractiveTools } from './index';

export interface InteractiveToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: { clarifyBridge: ClarifyBridge },
): InteractiveToolsCompose {
  return { tools: createInteractiveTools(deps.clarifyBridge) };
}
