// Raw `node:fs` is deliberate here and is the documented exception, not an
// oversight: this is the filesystem boundary itself. `Storage` follows
// symlinks and exposes no `lstat`, so the symbolic-containment check below
// cannot be expressed through it — the same rationale that already licenses
// raw `node:fs` in `apps/web-api/src/services/documents.service.ts` and
// `extensions/gateway/src/media.ts`. Do not "fix" this back to Storage.
// Sync (`lstatSync`, not `fs/promises`) because `checkReach` is synchronous
// and called from both sync and async paths; making it async would ripple
// through the whole `ScopedFs` contract for no security gain.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';
import {
  type DefinitionWriteFloor,
  foldForDeny,
  isUnmappablePathAlias,
  type PrivatePathDeny,
  type ScopedFs,
  type ScopedFsEntry,
  type Storage,
} from '@ethosagent/types';

/** Bound on symlink hops followed while validating a single path. */
const MAX_SYMLINK_HOPS = 32;

/** Why a `denyWhen` refusal happened, as the `PATH_NOT_REACHABLE` message says it. */
const SHARED_DENY_WHY =
  'private memory and Ethos state are not reachable from a shared conversation';

/**
 * Scoped filesystem capability. Enforces three layers on every call:
 *
 *  1. **Non-overridable deny floor** — `alwaysDenyPaths` (injected at
 *     construction) lists `.ssh`, `.aws/credentials`, `/etc/passwd`,
 *     `/root`, etc. A path that touches any of these denies even when
 *     the capability and personality both grant the parent (mirror of
 *     `safety-network`'s cloud-metadata block).
 *
 *  1b. **Write-only deny list** — `writeDenyPaths` (injected at
 *     construction, fifth argument) refuses WRITES to the personality's own
 *     definition files (`personalityWriteDeny` in `../fs-reach.ts`) even
 *     when the write reach covers them. Reads are unaffected. Mirror of
 *     `ScopedStorageScope.writeDeny` in
 *     `packages/storage-fs/src/scoped-storage.ts` — the two MUST change
 *     together. The seventh argument, `definitionWriteFloor`, widens it to
 *     EVERY personality's definition entries under every Ethos state dir,
 *     including a personality directory created mid-turn (plan
 *     personality-memory-boundary G2-pre B). It is injected rather than
 *     computed here because the predicate over `ethosStateDirs()` lives in
 *     `@ethosagent/storage-fs` (`personalityDefinitionFloor`), which core may
 *     not import at runtime; `resolveCapabilities` passes it on every
 *     construction (`CapabilityBackends.definitionWriteFloor`). `ScopedStorage`
 *     applies the same predicate on its own.
 *
 *  1c. **Deny-when predicate** — `denyWhen` (sixth argument, set only on a
 *     shared turn by `resolveCapabilities`) refuses reads AND writes of
 *     everything under the state dir but the turn's own `files/`, `ui/`,
 *     `SOUL.md` (read) and the skills (read), and of private memory anywhere
 *     (`sharedTurnPathDeny` in `@ethosagent/types`; told whether the access
 *     is a read or a write), judged on the lexical path and on every
 *     symlink-resolved hop. Mirror of
 *     `ScopedStorageScope.denyWhen` in `packages/storage-fs/src/scoped-storage.ts`
 *     — the two MUST change together. `ScopedFs` has no remove/rename, so
 *     only the `'access'` question is ever asked here.
 *
 *  2. **Declared reach allowlist** — the intersection of the tool's
 *     `capabilities.fs_reach` with the personality's `fs_reach`,
 *     resolved at registration time. Paths outside the allow set are
 *     rejected with `PATH_NOT_REACHABLE`.
 *
 *
 * Deny comparisons (layers 1 and 1b's path list) are case- and
 * normalization-folded (`foldForDeny`, @ethosagent/types) — on a
 * case-insensitive file system `Toolset.yaml` IS `toolset.yaml`. The allow
 * match stays exact, so folding never widens reach. Mirror of
 * `matchesDenyPrefix` in `packages/storage-fs/src/scoped-storage.ts`.
 *
 *  3. **Symbolic containment** — layers 1 and 2 are lexical, and
 *     `normalize(resolve())` is a string operation while a symlink is a
 *     filesystem fact. A link planted inside an allowed prefix pointing
 *     outside it passes both. Layer 3 walks the path segment by segment
 *     below the matched prefix and follows any link it finds, re-judging
 *     layers 1 and 2 against where the link actually lands.
 *
 *  4. **Real target** (`checkRealTarget`) — layers 1, 1b and 1c again,
 *     against the realpath of the path's longest existing ancestor
 *     ({@link realPathOfLongestExistingAncestor}), so a link ABOVE the matched
 *     prefix (a symlinked state dir or cwd) cannot carry a write onto a denied
 *     file under its real name. Unresolvable → refused (verification round A2).
 *
 * This closes **misdirection**, not **TOCTOU**: an attacker who can swap a
 * path between this walk and the subsequent open still wins, and closing
 * that needs container-level remediation.
 *
 * The floor cannot be disabled by configuration. Tests that need to
 * exercise a forbidden path override `$HOME` before constructing the
 * wrapper.
 */
export class ScopedFsImpl implements ScopedFs {
  private readonly denyPaths: string[];
  private readonly writeDenyPaths: string[];

  constructor(
    private readonly storage: Storage,
    private readonly readPaths: Set<string>,
    private readonly writePaths: Set<string>,
    alwaysDenyPaths: string[] = [],
    writeDenyPaths: string[] = [],
    private readonly denyWhen?: PrivatePathDeny,
    private readonly definitionWriteFloor?: DefinitionWriteFloor,
  ) {
    this.denyPaths = alwaysDenyPaths.map((p) => normalize(resolve(p)));
    this.writeDenyPaths = writeDenyPaths.map((p) => normalize(resolve(p)));
  }

  async read(path: string): Promise<string> {
    this.checkReach(path, this.readPaths, 'read');
    const content = await this.storage.read(path);
    if (content === null) throw new Error(`File not found: ${path}`);
    return content;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    this.checkReach(path, this.readPaths, 'read');
    const bytes = await this.storage.readBytes(path);
    if (bytes === null) throw new Error(`File not found: ${path}`);
    return bytes;
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    this.checkReach(path, this.writePaths, 'write');
    await this.storage.write(path, content);
  }

  async exists(path: string): Promise<boolean> {
    this.checkReach(path, this.readPaths, 'read');
    return this.storage.exists(path);
  }

  async list(path: string): Promise<string[]> {
    this.checkReach(path, this.readPaths, 'read');
    return this.storage.list(path);
  }

  async mtime(path: string): Promise<number | null> {
    this.checkReach(path, this.readPaths, 'read');
    return this.storage.mtime(path);
  }

  async mkdir(dir: string): Promise<void> {
    this.checkReach(dir, this.writePaths, 'write');
    await this.storage.mkdir(dir);
  }

  async listEntries(dir: string): Promise<ScopedFsEntry[]> {
    this.checkReach(dir, this.readPaths, 'read');
    return this.storage.listEntries(dir);
  }

  private checkReach(path: string, allowed: Set<string>, kind: string): void {
    const canonical = normalize(resolve(path));

    // NB: the literal `PATH_NOT_REACHABLE:` prefix below is the contract
    // tools-file's `isReachError` consumer matches against. Do not change
    // the prefix without also updating consumers.
    //
    // Deny floor fires first — non-overridable, runs even when an
    // operator misconfigures fs_reach to include everything.
    if (this.hitsDenyFloor(canonical)) {
      throw new Error(`PATH_NOT_REACHABLE: ${kind} of "${path}" hits the always-deny floor`);
    }
    if (this.hitsWriteDeny(canonical, kind)) {
      throw new Error(
        `PATH_NOT_REACHABLE: ${kind} of "${path}" refused — personality definition is operator-owned`,
      );
    }
    if (this.hitsDenyWhen(canonical, kind)) {
      throw new Error(`PATH_NOT_REACHABLE: ${kind} of "${path}" refused — ${SHARED_DENY_WHY}`);
    }

    let prefix = matchAllowedPrefix(canonical, allowed);
    if (prefix === null) {
      throw new Error(`PATH_NOT_REACHABLE: ${kind} not permitted for ${path}`);
    }

    // Symbolic containment. Lexical containment above is judged FIRST and
    // with no filesystem access at all: a path outside the reach is refused
    // on its string form and never reaches an `lstat`, so the boundary
    // leaks no existence information about paths it does not govern. Only a
    // path already inside the reach gets asked whether it *really* is.
    //
    // Each hop rewrites the path through one link and re-walks from the
    // (possibly different) allowed prefix that now contains it, so a link
    // whose own target sits behind another link is resolved too.
    let current = canonical;
    for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
      const next = followFirstSymlink(prefix, current);
      if (next === null) {
        this.checkRealTarget(canonical, path, kind);
        return;
      }
      const nextPrefix = matchAllowedPrefix(next, allowed);
      if (nextPrefix === null || this.hitsDenyFloor(next)) {
        throw new Error(
          `PATH_NOT_REACHABLE: ${kind} of "${path}" resolves outside the allowlist through a symbolic link`,
        );
      }
      // Re-judged on every hop, exactly as the floor is.
      if (this.hitsWriteDeny(next, kind)) {
        throw new Error(
          `PATH_NOT_REACHABLE: ${kind} of "${path}" refused — personality definition is operator-owned`,
        );
      }
      // …and so is `denyWhen`: a link that lands on a private memory file is
      // refused on where it lands, whatever it is called.
      if (this.hitsDenyWhen(next, kind)) {
        throw new Error(`PATH_NOT_REACHABLE: ${kind} of "${path}" refused — ${SHARED_DENY_WHY}`);
      }
      current = next;
      prefix = nextPrefix;
    }
    throw new Error(
      `PATH_NOT_REACHABLE: ${kind} of "${path}" follows too many symbolic links to resolve`,
    );
  }

  /**
   * Layer 4 — the deny layers on where the path really lands, run once the
   * symlink walk has nothing more to follow. Mirror of
   * `ScopedStorage.checkRealTarget` (packages/storage-fs/src/scoped-storage.ts).
   */
  private checkRealTarget(canonical: string, path: string, kind: string): void {
    const real = realPathOfLongestExistingAncestor(canonical);
    if (real === null) {
      throw new Error(`PATH_NOT_REACHABLE: ${kind} of "${path}" cannot be resolved to a real path`);
    }
    if (real === canonical) return;
    if (this.hitsDenyFloor(real)) {
      throw new Error(`PATH_NOT_REACHABLE: ${kind} of "${path}" hits the always-deny floor`);
    }
    if (this.hitsWriteDeny(real, kind)) {
      throw new Error(
        `PATH_NOT_REACHABLE: ${kind} of "${path}" refused — personality definition is operator-owned`,
      );
    }
    if (this.hitsDenyWhen(real, kind)) {
      throw new Error(`PATH_NOT_REACHABLE: ${kind} of "${path}" refused — ${SHARED_DENY_WHY}`);
    }
  }

  /** A `kind` other than `'read'` is judged as a write (fail closed). */
  private hitsDenyWhen(canonical: string, kind: string): boolean {
    return this.denyWhen?.(canonical, 'access', kind === 'read' ? 'read' : 'write') ?? false;
  }

  private hitsWriteDeny(canonical: string, kind: string): boolean {
    return (
      kind === 'write' &&
      (matchesAny(canonical, this.writeDenyPaths) ||
        (this.definitionWriteFloor?.(canonical, 'access') ?? false))
    );
  }

  private hitsDenyFloor(canonical: string): boolean {
    return matchesAny(canonical, this.denyPaths);
  }
}

/**
 * True when `canonical` equals, or lies under, one of the canonical DENY
 * `paths`, compared case- and normalization-folded (`foldForDeny`), or names
 * a file no deny can judge (`isUnmappablePathAlias`; verification round G3).
 * Deny-only. Mirror of `matchesDenyPrefix` in `ScopedStorage`
 * (packages/storage-fs/src/scoped-storage.ts).
 */
function matchesAny(canonical: string, paths: readonly string[]): boolean {
  if (isUnmappablePathAlias(canonical)) return true;
  const c = foldForDeny(canonical);
  return paths.some((raw) => {
    const p = foldForDeny(raw);
    return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
  });
}

/** Bound on the combined parent steps and symlink hops of one resolution. */
const MAX_RESOLVE_STEPS = 256;

/**
 * The realpath of `path`'s longest existing ancestor with the missing tail
 * re-appended — where a write to `path` would actually land. A dangling
 * symlink on the way is followed to its target. Null when the path cannot be
 * resolved (an error other than ENOENT/ENOTDIR, or too many steps); callers
 * deciding a deny refuse on null.
 *
 * Deliberate DUPLICATE of `realPathOfLongestExistingAncestor` in
 * `packages/storage-fs/src/sensitive-paths.ts` (core may not import
 * storage-fs at runtime, ARCHITECTURE.md §II) — the two MUST change together.
 */
export function realPathOfLongestExistingAncestor(path: string): string | null {
  let cursor = resolve(path);
  const tail: string[] = [];
  for (let step = 0; step < MAX_RESOLVE_STEPS; step++) {
    try {
      const real = realpathSync(cursor);
      return tail.length === 0 ? real : join(real, ...[...tail].reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    let isLink: boolean;
    try {
      isLink = lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOTDIR') return null;
      isLink = false;
    }
    if (isLink) {
      cursor = resolve(dirname(cursor), readlinkSync(cursor));
      continue;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    tail.push(basename(cursor));
    cursor = parent;
  }
  return null;
}

/**
 * `dirs` followed by the realpath of each one not already listed — the
 * state-dir forms a deny must know (verification round A2). Mirror of
 * `withRealPaths` in `packages/storage-fs/src/sensitive-paths.ts`.
 */
export function withRealPaths(dirs: readonly string[]): string[] {
  const out = [...dirs];
  for (const dir of dirs) {
    const real = realPathOfLongestExistingAncestor(dir);
    if (real !== null && !out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * The canonical form of the first allowed prefix containing `canonical`, or
 * null when no prefix does. Purely lexical — no filesystem access.
 */
function matchAllowedPrefix(canonical: string, allowed: Iterable<string>): string | null {
  for (const prefix of allowed) {
    const canonicalPrefix = normalize(resolve(prefix));
    if (
      canonical === canonicalPrefix ||
      canonical.startsWith(canonicalPrefix.endsWith('/') ? canonicalPrefix : `${canonicalPrefix}/`)
    ) {
      return canonicalPrefix;
    }
  }
  return null;
}

// Layer 3 of `checkReach` above is a deliberate DUPLICATE of `ScopedStorage.check`
// in `packages/storage-fs/src/scoped-storage.ts` — the same symbolic-containment
// rule enforced at the other personality filesystem boundary. It is not shared
// code because `@ethosagent/core` may not import `@ethosagent/storage-fs` at
// runtime (storage-fs is the security kernel; core is not, and core depends on it
// only as a devDependency — ARCHITECTURE.md §II). A THIRD copy —
// `containedPath`/`followFirstSymlink` in `packages/wiring/src/backup/restore.ts` —
// guards the backup restore's destination paths under the Ethos data directory,
// duplicated for the same reason: `packages/wiring` is a different layer. A
// FOURTH lives in `reachable` in `apps/web-api/src/services/documents.service.ts`,
// guarding the operator-supplied Documents root.
// **All four must change together:** a fix applied to one boundary and not the
// others leaves the escape open on whichever path the caller happens to take.
// The reciprocal notes live in `scoped-storage.ts`'s class doc and in
// `restore.ts`'s `followFirstSymlink` doc.
//
// The fourth copy walks with async `lstat` from `node:fs/promises`, so an
// `lstatSync` grep does not find it. Its errno rule is the same as the other
// three: ENOENT alone ends the walk (here `lstatSync(..., { throwIfNoEntry:
// false })` returning `undefined`), and every other error — EACCES, ENOTDIR,
// the rest — refuses. Pinned for that copy by
// `apps/web-api/src/__tests__/services/documents.service.fail-closed.test.ts`.
// It differs in one deliberate way: it refuses ANY symlink rather than
// following it and re-judging the target.

/**
 * Walk `target` one segment at a time below `prefixRoot`, `lstat`ing each.
 * Returns the path rewritten through the FIRST symbolic link found (that
 * link's target plus the remaining segments), or null when the walk crosses
 * no link.
 *
 * Per-segment, not leaf-only: a symlinked PARENT escapes the reach behind a
 * perfectly ordinary leaf. A missing segment is not a link — `lstat` finding
 * nothing is the normal case for a write to a file that does not exist yet,
 * and nothing can live below a segment that is absent, so the walk stops.
 * Only the portion BELOW the allowed prefix is walked: segments above it are
 * the operator's own layout (`/var` → `/private/var` on macOS), not an escape.
 *
 * Mirror of `followFirstSymlink` in `packages/storage-fs/src/scoped-storage.ts`.
 */
function followFirstSymlink(prefixRoot: string, target: string): string | null {
  const rel = relative(prefixRoot, target);
  if (rel === '') return null;

  const segments = rel.split(sep);
  let cursor = prefixRoot;
  for (let i = 0; i < segments.length; i++) {
    cursor = join(cursor, segments[i] ?? '');
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    if (!stat.isSymbolicLink()) continue;
    const linkTarget = normalize(resolve(dirname(cursor), readlinkSync(cursor)));
    return normalize(join(linkTarget, ...segments.slice(i + 1)));
  }
  return null;
}
