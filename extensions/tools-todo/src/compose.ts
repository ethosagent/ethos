import type { Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createTodoTools, InMemoryTodoStore } from './index';

export interface TodoToolsCompose {
  tools: Tool[];
  store: InMemoryTodoStore;
}

export function compose(_ctx: WiringContext): TodoToolsCompose {
  const store = new InMemoryTodoStore();
  return { tools: createTodoTools(store), store };
}
