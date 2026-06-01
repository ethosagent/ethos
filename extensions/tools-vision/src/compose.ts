import type { LLMProvider, Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createVisionTools } from './index';

export interface VisionToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: {
    resolveProvider: (model: string) => LLMProvider | null;
    defaultModel: string;
    auxiliaryVisionModel?: string;
  },
): VisionToolsCompose {
  return { tools: createVisionTools(deps) };
}
