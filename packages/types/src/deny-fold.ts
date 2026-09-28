// Case- and normalization-folding for filesystem DENY comparisons (plan
// personality-memory-boundary, verification round A1).
//
// macOS (APFS, HFS+) and Windows file systems are case-insensitive and
// normalization-insensitive by default: `personalities/a/Toolset.yaml` and
// `personalities/a/toolset.yaml` name the SAME file there, while a string
// comparison says they differ. A deny that compares exactly is therefore
// bypassed by a case variant. Every deny and floor predicate folds both
// sides before comparing, on every platform — a case-sensitive host merely
// refuses a few extra look-alike names, which is the fail-closed direction.
//
// It also drops a leading `/System/Volumes/Data` (verification round E3).
// On macOS that directory is a FIRMLINK to the same volume `/Users`, `/opt`
// and `/private` live on: `/System/Volumes/Data/Users/u/.ethos/...` IS
// `/Users/u/.ethos/...`, and `realpath` does not rewrite it, so no realpath
// check catches it either. Stripped on every platform for the same reason
// the case fold is: on a host where it is a real, distinct directory, the
// deny merely refuses a few extra paths.
//
// Used ONLY for deny decisions: `isPrivateMemoryPath` (./memory-paths.ts),
// `isPersonalityDefinitionPath` (./personality-definition.ts), the always-deny
// and write-deny prefix matches in `ScopedStorage`
// (packages/storage-fs/src/scoped-storage.ts) and `ScopedFsImpl`
// (packages/core/src/scoped/scoped-fs.ts), and the docker floor
// (`DockerExecutionBackend.mountsFor`). NEVER to widen an allow: an allowlist
// prefix is still matched exactly, so a folded match can only refuse more.
// Pinned by packages/types/src/__tests__/deny-fold.test.ts and the case-variant
// cases in each boundary's tests.

/** macOS's data-volume firmlink root, folded (see the header). */
const FOLDED_FIRMLINK_ROOT = '/system/volumes/data';

/**
 * `value` folded for a deny comparison: NFC-normalized, then upper- and
 * lower-cased. The round trip catches characters whose lower-case form is not
 * the plain letter a case-insensitive file system folds them to (`ſ` → `s`,
 * the Kelvin sign → `k`); over-folding can only make a deny refuse more.
 * An absolute path under `/System/Volumes/Data` (in any case) is then
 * rewritten to the path the firmlink makes it equal to, and the root itself
 * to `/`.
 */
export function foldForDeny(value: string): string {
  const folded = value.normalize('NFC').toUpperCase().toLowerCase();
  if (folded === FOLDED_FIRMLINK_ROOT) return '/';
  if (folded.startsWith(`${FOLDED_FIRMLINK_ROOT}/`)) {
    return folded.slice(FOLDED_FIRMLINK_ROOT.length);
  }
  return folded;
}
