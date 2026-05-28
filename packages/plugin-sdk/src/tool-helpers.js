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
