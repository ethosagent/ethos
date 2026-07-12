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
 * consume this one source of truth.
 */
export function defaultAlwaysDeny(): string[] {
  return sensitiveDenyPaths();
}
