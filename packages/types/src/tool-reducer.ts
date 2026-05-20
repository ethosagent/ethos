import type { ToolResult } from './tool';

export interface ToolReducerContext {
  args: unknown;
  turnCount: number;
}

export interface ToolResultReducer {
  /** Name of the tool this reducer applies to. Exact match — no regex. */
  readonly toolName: string;
  /**
   * Reduce a tool result to signal-only form.
   * Deterministic: same input MUST produce same output. No LLM calls.
   * MUST NOT throw — return the original result on any internal error.
   */
  reduce(result: ToolResult, ctx: ToolReducerContext): ToolResult;
}

export interface ToolResultReducerRegistry {
  register(reducer: ToolResultReducer): () => void;
  get(toolName: string): ToolResultReducer | undefined;
}
