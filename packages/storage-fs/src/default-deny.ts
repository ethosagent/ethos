import { sensitiveDenyPaths } from './sensitive-paths';

/**
 * Non-overridable filesystem deny floor for `ScopedStorage`. Returns the
 * canonical sensitive-path manifest (`sensitiveDenyPaths`); a personality
 * (or a tool capability) that explicitly allows `~/` still cannot reach
 * these prefixes.
 *
 * Kept as a named export — rather than inlining `sensitiveDenyPaths` at the
 * ScopedStorage wiring sites — so the always-deny wiring reads intent-first.
 * Both the `ScopedStorage` decorator and the capability-resolved `ScopedFs`
 * consume this one source of truth. `extraStateDirs` adds state dirs the
 * environment does not name — wiring passes its `dataDir` (`ethosStateDirs`).
 */
export function defaultAlwaysDeny(extraStateDirs: readonly string[] = []): string[] {
  return sensitiveDenyPaths(extraStateDirs);
}
