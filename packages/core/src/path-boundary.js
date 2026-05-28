// Path-boundary enforcement: containment check for resolved paths.
//
// After constructing a path via path.join(base, userInput, ...), call
// assertWithinBase() to verify the resolved result has not escaped the
// intended base directory. This is the defense-in-depth layer behind
// assertSafeId() — it catches edge cases the regex might miss (symlinks,
// encoding tricks, future regex relaxations).
import { resolve, sep } from 'node:path';
/**
 * Verify that `target` resolves to a path within (or equal to) `base`.
 * Both paths are resolved to absolute before comparison.
 *
 * @throws BoundaryEscapeError if the resolved target escapes the base
 */
export function assertWithinBase(base, target) {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  if (resolvedTarget === resolvedBase) return;
  if (!resolvedTarget.startsWith(resolvedBase + sep)) {
    throw new BoundaryEscapeError(resolvedBase, resolvedTarget);
  }
}
export class BoundaryEscapeError extends Error {
  code = 'path-boundary-escape';
  base;
  resolved;
  constructor(base, resolved) {
    super(`Path "${resolved}" escapes boundary "${base}"`);
    this.name = 'BoundaryEscapeError';
    this.base = base;
    this.resolved = resolved;
  }
}
