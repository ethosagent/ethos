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
// And it drops a leading `/.nofollow` (verification round G3): on macOS
// `/.nofollow/<abs>` names `<abs>` with symlinks in it not followed, so
// `/.nofollow/Users/u/.ethos/config.yaml` IS the config file. Two other macOS
// roots cannot be mapped back to a path at all — `/.vol/<dev>/<inode>/…` and
// `/.resolve/<dev>/<inode>/…` name a file by device and inode number — so
// {@link isUnmappablePathAlias} says so, and both boundaries and the docker
// mounts refuse every such path, for every operation.
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

/** macOS's no-follow path prefix, folded (see the header). */
const FOLDED_NOFOLLOW_ROOT = '/.nofollow';

/**
 * First path segments (folded) that name a file some other way than by its
 * path — macOS's `/.vol` and `/.resolve` (device + inode) — or, left over
 * after {@link foldForDeny} dropped one, a second `/.nofollow`.
 */
const UNMAPPABLE_ALIAS_ROOTS: readonly string[] = ['.vol', '.resolve', '.nofollow'];

/**
 * `value` folded for a deny comparison: NFC-normalized, then lower-, upper-
 * and lower-cased, then NFC again. The round trip catches characters whose
 * lower-case form is not the plain letter a case-insensitive file system
 * folds them to (`ſ` → `s`, the Kelvin sign → `k`); lowering FIRST also
 * reaches U+1E9E CAPITAL SHARP S, which upper-cases to itself and lower-cases
 * to `ß`, whose upper case is `SS` — so `.ẞh` folds to `.ssh` as APFS opens
 * it (V-ES-1, the same order as `foldDenyKey` in
 * packages/core/src/scoped/scoped-fs.ts). Over-folding can only make a deny
 * refuse more.
 * A leading `/.nofollow` (in any case) is dropped once, and an absolute path
 * under `/System/Volumes/Data` is then rewritten to the path the firmlink
 * makes it equal to, and either root itself to `/`.
 */
export function foldForDeny(value: string): string {
  let folded = value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
  if (folded === FOLDED_NOFOLLOW_ROOT) return '/';
  if (folded.startsWith(`${FOLDED_NOFOLLOW_ROOT}/`)) {
    folded = folded.slice(FOLDED_NOFOLLOW_ROOT.length);
  }
  if (folded === FOLDED_FIRMLINK_ROOT) return '/';
  if (folded.startsWith(`${FOLDED_FIRMLINK_ROOT}/`)) {
    return folded.slice(FOLDED_FIRMLINK_ROOT.length);
  }
  return folded;
}

/**
 * True when absolute `path` names a file by something other than its path, so
 * no deny can judge it lexically: its first segment after {@link foldForDeny}
 * is `.vol`, `.resolve` or `.nofollow` (verification round G3), or it is
 * still under `/System/Volumes/Data` (a stacked firmlink). Refused for
 * every operation by `ScopedStorage` and `ScopedFsImpl` (their deny-prefix
 * matches, on the lexical path, every symlink hop and the real target) and by
 * `DockerExecutionBackend.mountsFor`. Pinned by
 * `packages/types/src/__tests__/deny-fold.test.ts` and the alias cases in
 * both boundaries' tests.
 */
export function isUnmappablePathAlias(path: string): boolean {
  const folded = foldForDeny(path);
  // A firmlink root left over after one was dropped (`/System/Volumes/Data`
  // stacked on itself) — `foldDenyKey` (packages/core/src/scoped/scoped-fs.ts) strips
  // stacked aliases in a loop; refusing the leftover is the stricter answer.
  if (folded === FOLDED_FIRMLINK_ROOT || folded.startsWith(`${FOLDED_FIRMLINK_ROOT}/`)) {
    return true;
  }
  const first = folded.split('/').find((s) => s.length > 0);
  return first !== undefined && UNMAPPABLE_ALIAS_ROOTS.includes(first);
}
