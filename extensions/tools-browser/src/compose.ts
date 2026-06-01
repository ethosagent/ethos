import type { Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createBrowserTools } from './index';

export interface BrowserToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps?: { visionApiKey?: string; visionProvider?: string; visionModel?: string },
): BrowserToolsCompose {
  return { tools: createBrowserTools(deps) };
}
