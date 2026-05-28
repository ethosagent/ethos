// ---------------------------------------------------------------------------
// JSON Schema rewrite: `definitions` → `$defs`, `#/definitions/` → `#/$defs/`
//
// Many MCP servers emit JSON Schema with the older `definitions` keyword.
// Anthropic's tool-use API and modern JSON Schema (2020-12) expect `$defs`.
// This helper rewrites in-place after a deep clone.
// ---------------------------------------------------------------------------
function rewriteNode(node) {
  if (!node || typeof node !== 'object') return;
  const obj = node;
  // Rename definitions → $defs
  if ('definitions' in obj && !('$defs' in obj)) {
    obj.$defs = obj.definitions;
    delete obj.definitions;
  }
  // Rewrite $ref paths
  if (typeof obj.$ref === 'string') {
    obj.$ref = obj.$ref.replace('#/definitions/', '#/$defs/');
  }
  // Recurse
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) rewriteNode(item);
    } else {
      rewriteNode(value);
    }
  }
}
export function rewriteDefinitionsToRefs(schema) {
  const result = JSON.parse(JSON.stringify(schema));
  rewriteNode(result);
  return result;
}
