import type { MemoryProvider, SessionStore, Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createMemoryTools, createTeamMemoryTools } from './index';

export interface MemoryToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: { memory: MemoryProvider; session: SessionStore; teamMemory?: MemoryProvider },
): MemoryToolsCompose {
  const tools: Tool[] = [...createMemoryTools(deps.memory, deps.session)];
  if (deps.teamMemory) tools.push(...createTeamMemoryTools(deps.teamMemory));
  return { tools };
}
