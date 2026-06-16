import type { ExecutionBackend, PersonalityConfig, Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createCodeTools } from './index';

export interface CodeToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: { backend?: ExecutionBackend; personality?: PersonalityConfig },
): CodeToolsCompose {
  return { tools: createCodeTools({ backend: deps.backend, personality: deps.personality }) };
}
