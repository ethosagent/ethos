import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Result shorthands
// ---------------------------------------------------------------------------

/** Shorthand for a successful tool result. */
export function ok(value: string): ToolResult {
  return { ok: true, value };
}

type ToolErrorCode = 'input_invalid' | 'not_available' | 'execution_failed' | 'STALE_WRITE';

/** Shorthand for a failed tool result. */
export function err(error: string, code: ToolErrorCode = 'execution_failed'): ToolResult {
  return { ok: false, error, code };
}

// ---------------------------------------------------------------------------
// Tool definition builder
// ---------------------------------------------------------------------------

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  capabilities?: import('@ethosagent/types').ToolCapabilities;
  isAvailable?: () => boolean;
  requiresApproval?: boolean;
  returnDirect?: boolean;
  outputSchema?: Record<string, unknown>;
  cache?: boolean | import('@ethosagent/types').CacheOptions;
  preferredModel?: string;
  strict?: boolean;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Type-safe tool factory. Identical to writing a `Tool` object directly,
 * but provides better inference when `TArgs` is specified.
 *
 * @example
 * const myTool = defineTool<{ query: string }>({
 *   name: 'my_search',
 *   description: 'Search for something',
 *   schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
 *   async execute({ query }, ctx) {
 *     return ok(`Results for: ${query}`);
 *   },
 * });
 */
export function defineTool<TArgs = unknown>(def: ToolDefinition<TArgs>): Tool<TArgs> {
  return { capabilities: {}, ...def } as Tool<TArgs>;
}

/** Wrap a tool definition to require user approval before execution. */
export function needsApproval<TArgs>(def: ToolDefinition<TArgs>): ToolDefinition<TArgs> {
  return { ...def, requiresApproval: true };
}

/** Wrap a tool definition to enable result caching. */
export function withCache<TArgs>(
  def: ToolDefinition<TArgs>,
  opts?: import('@ethosagent/types').CacheOptions,
): ToolDefinition<TArgs> {
  return { ...def, cache: opts ?? true };
}

/** Wrap a tool definition so its result is returned directly to the user. */
export function withReturnDirect<TArgs>(def: ToolDefinition<TArgs>): ToolDefinition<TArgs> {
  return { ...def, returnDirect: true };
}
