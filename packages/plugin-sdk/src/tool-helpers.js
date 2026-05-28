// ---------------------------------------------------------------------------
// Result shorthands
// ---------------------------------------------------------------------------
/** Shorthand for a successful tool result. */
export function ok(value) {
  return { ok: true, value };
}
/** Shorthand for a failed tool result. */
export function err(error, code = 'execution_failed') {
  return { ok: false, error, code };
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
export function defineTool(def) {
  return { capabilities: {}, ...def };
}
/** Wrap a tool definition to require user approval before execution. */
export function needsApproval(def) {
  return { ...def, requiresApproval: true };
}
/** Wrap a tool definition to enable result caching. */
export function withCache(def, opts) {
  return { ...def, cache: opts ?? true };
}
/** Wrap a tool definition so its result is returned directly to the user. */
export function withReturnDirect(def) {
  return { ...def, returnDirect: true };
}
