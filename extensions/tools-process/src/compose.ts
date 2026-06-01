import type { Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createProcessTools } from './index';

export interface ProcessToolsCompose {
  tools: Tool[];
}

export function compose(ctx: WiringContext): ProcessToolsCompose {
  return { tools: createProcessTools(ctx.dataDir) };
}
