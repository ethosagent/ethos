import type { Tool, WiringContext } from '@ethosagent/types';
import { createTodoTools, InMemoryTodoStore } from './index';

export interface TodoToolsCompose {
  tools: Tool[];
  store: InMemoryTodoStore;
}

export function compose(_ctx: WiringContext): TodoToolsCompose {
  const store = new InMemoryTodoStore();
  return { tools: createTodoTools(store), store };
}
