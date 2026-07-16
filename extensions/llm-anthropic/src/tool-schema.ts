// Phase 5 — tool-schema reduction + per-tool byte attribution.
//
// Tool definitions are the single largest FIXED cost of every turn: the full
// JSON schema of each tool ships on every request. This module provides two
// things:
//   1. `attributeToolSchemaBytes` — measurement. Splits the "tools" slice
//      (the JSON the provider serializes) into per-tool byte counts, so the
//      context anatomy can name which tools dominate the fixed cost.
//   2. `reduceToolSchemas` — safe, lossless-by-default reductions applied at
//      the serialization boundary: strip `$defs`/`definitions` that no `$ref`
//      points at, and normalize redundant whitespace in descriptions. An
//      optional hard cap on description length is available for lean budgets.
//
// Both operate on the on-the-wire shape (`{ name, description, input_schema }`),
// so the measurement reflects exactly what `reduceToolSchemas` produced.

import type { ToolDefinitionLite } from '@ethosagent/types';

const DEFS_KEYS = ['$defs', 'definitions'] as const;

/**
 * Attribute the serialized tool-schema byte cost to individual tools. Each tool
 * is serialized in the exact shape the provider sends on the wire; `total` is
 * the sum of the per-tool byte counts. The context-anatomy "tools" slice is the
 * sum of these, so per-tool bytes always sum to the slice (the Phase 5
 * invariant).
 */
export function attributeToolSchemaBytes(tools: ToolDefinitionLite[]): {
  perTool: Record<string, number>;
  total: number;
} {
  const perTool: Record<string, number> = {};
  let total = 0;
  for (const t of tools) {
    const bytes = JSON.stringify({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }).length;
    perTool[t.name] = bytes;
    total += bytes;
  }
  return { perTool, total };
}

/** Recursively collect every `$ref` string target reachable from a node. */
function collectRefTargets(node: unknown, targets: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefTargets(item, targets);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') targets.add(v);
      else collectRefTargets(v, targets);
    }
  }
}

/**
 * Remove `$defs`/`definitions` entries that no `$ref` in the schema points at.
 * Purely structural: an unreferenced definition contributes nothing to what the
 * schema accepts, so dropping it never changes tool-calling behavior. Returns
 * the input unchanged (same reference) when nothing was removed, so a schema
 * with no dead defs stays byte-identical.
 */
function stripUnusedDefs(schema: Record<string, unknown>): Record<string, unknown> {
  let out = schema;
  for (const defsKey of DEFS_KEYS) {
    const defs = out[defsKey];
    if (!defs || typeof defs !== 'object' || Array.isArray(defs)) continue;
    const targets = new Set<string>();
    collectRefTargets(out, targets);
    const kept: Record<string, unknown> = {};
    let removed = false;
    for (const [name, value] of Object.entries(defs as Record<string, unknown>)) {
      if (targets.has(`#/${defsKey}/${name}`)) kept[name] = value;
      else removed = true;
    }
    if (!removed) continue;
    const clone: Record<string, unknown> = { ...out };
    if (Object.keys(kept).length > 0) clone[defsKey] = kept;
    else delete clone[defsKey];
    out = clone;
  }
  return out;
}

/**
 * Normalize a tool description: strip trailing per-line whitespace, collapse
 * runs of 3+ blank lines to one, and trim the ends. Removes only redundant
 * whitespace — never words — so the model still sees the full instruction. An
 * optional `maxChars` hard cap truncates genuinely oversized descriptions for
 * lean budgets (off by default to preserve correctness).
 */
function normalizeDescription(desc: string, maxChars?: number): string {
  let out = desc
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (maxChars !== undefined && maxChars > 0 && out.length > maxChars) {
    out = `${out.slice(0, maxChars).trimEnd()}…`;
  }
  return out;
}

export interface ReduceToolSchemasOptions {
  /** Hard cap on each tool DESCRIPTION in characters. Omitted → descriptions are
   *  only whitespace-normalized, never truncated (correctness-safe default). */
  maxDescriptionChars?: number;
}

/**
 * Apply the safe tool-schema reductions at the serialization boundary. Always
 * strips unused `$defs`/`definitions` and normalizes description whitespace;
 * truncates descriptions only when `maxDescriptionChars` is set. Returns a new
 * array; individual `parameters` objects are shared when nothing changed.
 */
export function reduceToolSchemas(
  tools: ToolDefinitionLite[],
  opts: ReduceToolSchemasOptions = {},
): ToolDefinitionLite[] {
  return tools.map((t) => {
    const parameters =
      t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters)
        ? stripUnusedDefs(t.parameters as Record<string, unknown>)
        : t.parameters;
    return {
      name: t.name,
      description: normalizeDescription(t.description ?? '', opts.maxDescriptionChars),
      parameters,
    };
  });
}
