import type { ToolResultReducer, ToolResultReducerRegistry } from '@ethosagent/types';

export class DefaultToolResultReducerRegistry implements ToolResultReducerRegistry {
  private readonly byName = new Map<string, ToolResultReducer>();

  register(reducer: ToolResultReducer): () => void {
    if (this.byName.has(reducer.toolName)) {
      throw new Error(`Reducer already registered for tool '${reducer.toolName}'`);
    }
    this.byName.set(reducer.toolName, reducer);
    return () => {
      this.byName.delete(reducer.toolName);
    };
  }

  get(toolName: string): ToolResultReducer | undefined {
    return this.byName.get(toolName);
  }
}
