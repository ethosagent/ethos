import type { ToolReducerContext, ToolResult, ToolResultReducer } from '@ethosagent/types';

const MAX_LINES = 200;

function hasExplicitRange(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const a = args as Record<string, unknown>;
  return a.lineStart !== undefined || a.lineEnd !== undefined;
}

export const readFileReducer: ToolResultReducer = {
  toolName: 'read_file',
  reduce(result: ToolResult, ctx: ToolReducerContext): ToolResult {
    if (!result.ok) return result;
    if (hasExplicitRange(ctx.args)) return result;
    const lines = result.value.split('\n');
    if (lines.length <= MAX_LINES) return result;
    const kept = lines.slice(0, MAX_LINES).join('\n');
    const hint = `File is ${lines.length} lines. Showing lines 1-${MAX_LINES}. Call read_file with lineStart/lineEnd for more.`;
    return { ok: true, value: `${hint}\n${kept}` };
  },
};
