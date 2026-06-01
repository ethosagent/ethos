import type { ClarifyBridge } from '@ethosagent/core';
import type { Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
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
