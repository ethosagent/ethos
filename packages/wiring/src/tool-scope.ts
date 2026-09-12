/**
 * Turning an ALLOWLIST of tool names into the denylist the registry's surface
 * gate actually enforces.
 *
 * `RunOptions.toolsetNarrow` intersects the personality toolset, and the
 * toolset gates BUILT-IN tools only: `DefaultToolRegistry.toDefinitions` and
 * `executeParallel` (`packages/core/src/tool-registry.ts`) let `mcp__*` tools,
 * plugin-registered tools and `alwaysInclude` tools past the name allowlist by
 * design. `ToolFilterOpts.excludeTools` is the one gate that reaches all three
 * (`passesFilter`, same file, plus `executeParallel`'s pre-dispatch check), so
 * a caller that means "exactly these names and nothing else" has to name the
 * complement.
 *
 * Pure: no registry, no I/O. The caller decides what "registered" means and
 * recomputes per turn, so a tool registered after boot (a late MCP server) is
 * covered by the next turn's exclusion.
 */

/**
 * The names in `registered` that are NOT in `allowed` — the `toolsetExclude`
 * that makes `allowed` exact.
 *
 * Deduplicated and sorted, so the result is stable regardless of registration
 * order. Names in `allowed` that are not registered are ignored: this computes
 * an exclusion, not a grant.
 */
export function complementExclude(
  registered: Iterable<string>,
  allowed: Iterable<string>,
): string[] {
  const keep = new Set(allowed);
  const exclude = new Set<string>();
  for (const name of registered) {
    if (!keep.has(name)) exclude.add(name);
  }
  return [...exclude].sort();
}
