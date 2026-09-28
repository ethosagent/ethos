// Raw `node:fs` is deliberate here and is the documented exception, not an
// oversight: this is the filesystem boundary itself. `Storage` follows
// symlinks and exposes no `lstat`, so the symbolic-containment check below
// cannot be expressed through it — the same rationale that already licenses
// raw `node:fs` in `apps/web-api/src/services/documents.service.ts` and
// `extensions/gateway/src/media.ts`. Do not "fix" this back to Storage.
// Sync (`lstatSync`, not `fs/promises`) because `checkReach` is synchronous
// and called from both sync and async paths; making it async would ripple
// through the whole `ScopedFs` contract for no security gain.
import { lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import type { ScopedFs, ScopedFsEntry, Storage } from '@ethosagent/types';

/** Bound on symlink hops followed while validating a single path. */
const MAX_SYMLINK_HOPS = 32;

/**
 * Whether this platform's default filesystems compare names case-insensitively
 * — APFS on macOS and NTFS on Windows, where `TOOLSET.yaml` opens the existing
 * `toolset.yaml`. Linux is treated as case-sensitive, so its behaviour is
 * unchanged; a case-sensitive APFS volume only over-denies, never under.
 */
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * The key every DENY-side comparison uses (UBP-008). On a case-insensitive
 * filesystem two spellings that differ only in case name one file, so a deny
 * entry must match every spelling. A full case fold (not `toLowerCase` alone)
 * so characters that case-FOLD onto ASCII — U+017F long s, U+212A Kelvin sign
 * — land on the same key, and NFC so composed and decomposed spellings agree.
 * The fold is lower-upper-lower (V-ES-1): U+1E9E CAPITAL SHARP S uppercases
 * to itself and lowercases to `ß`, so upper-then-lower left `.ẞh` as `.ßh`
 * while APFS opens it as `.ssh`; lowercasing first reaches `ß`, whose
 * uppercase is `SS`. On macOS the key also drops a leading
 * `/System/Volumes/Data` ({@link DATA_VOLUME_FIRMLINK}, V-ES-3), so the
 * firmlink spelling of a denied path or of the state dir is the same key.
 * Folding more than the filesystem does only over-denies.
 *
 * Only deny-direction checks fold: the always-deny floor, the write-deny list
 * and the state-dir exclusion. Allow prefixes stay exact, so a case variant of
 * an allowed path is refused rather than widened.
 *
 * Mirror of `foldDenyKey` in `packages/storage-fs/src/sensitive-paths.ts` —
 * core cannot import storage-fs at runtime; the two change together. Pinned
 * by `packages/core/src/__tests__/scoped-fs-casefold-statedir.test.ts`.
 */
export function foldDenyKey(
  path: string,
  insensitive: boolean = CASE_INSENSITIVE_FS,
  dataVolumeAlias: boolean = DATA_VOLUME_FIRMLINK,
): string {
  const folded = insensitive
    ? path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')
    : path;
  return dataVolumeAlias ? stripDataVolume(folded) : folded;
}

/**
 * Whether `/System/Volumes/Data/<p>` names the same file as `/<p>` — macOS
 * 10.15+, where the writable data volume is mounted there and firmlinked into
 * the root (V-ES-3). A firmlink is not a symlink (`lstat` reports a plain
 * directory), so the symbolic-containment walk never sees it.
 */
export const DATA_VOLUME_FIRMLINK = process.platform === 'darwin';

const DATA_VOLUME = '/system/volumes/data';

/**
 * Drops every leading `/System/Volumes/Data` (compared case-insensitively, as
 * APFS does). Mapping a data-volume entry that is NOT firmlinked onto the root
 * only over-denies, which is the safe direction for a deny key.
 */
function stripDataVolume(key: string): string {
  let out = key;
  for (;;) {
    const head = out.slice(0, DATA_VOLUME.length).toLowerCase();
    if (head !== DATA_VOLUME) return out;
    const rest = out.slice(DATA_VOLUME.length);
    if (rest === '' || rest === '/') return '/';
    if (!rest.startsWith('/')) return out;
    out = rest;
  }
}

/**
 * Every directory Ethos keeps its state in: `~/.ethos` plus `ETHOS_STATE_DIR`
 * when set, read per call. Copy of `ethosStateDirs` in
 * `packages/storage-fs/src/sensitive-paths.ts` (core cannot import it).
 */
function ethosStateDirs(): string[] {
  const dirs = [join(homedir(), '.ethos')];
  const override = process.env.ETHOS_STATE_DIR;
  if (override && resolve(override) !== dirs[0]) dirs.push(resolve(override));
  return dirs;
}

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
 *     together.
 *
 *  2. **Declared reach allowlist** — the intersection of the tool's
 *     `capabilities.fs_reach` with the personality's `fs_reach`,
 *     resolved at registration time. Paths outside the allow set are
 *     rejected with `PATH_NOT_REACHABLE`.
 *
 *  3. **Symbolic containment** — layers 1 and 2 are lexical, and
 *     `normalize(resolve())` is a string operation while a symlink is a
 *     filesystem fact. A link planted inside an allowed prefix pointing
 *     outside it passes both. Layer 3 walks the path segment by segment
 *     below the matched prefix and follows any link it finds, re-judging
 *     layers 1 and 2 against where the link actually lands.
 *
 * This closes **misdirection**, not **TOCTOU**: an attacker who can swap a
 * path between this walk and the subsequent open still wins, and closing
 * that needs container-level remediation.
 *
 *  2b. **State-dir exclusion** (UBP-047) — an allow prefix that is a STRICT
 *     ancestor of an Ethos state dir (the cwd grant when the process runs
 *     from `~` or `/`) does not reach INTO that state dir: a path there must
 *     be granted by a prefix at or below the state dir (`ownDir`, `skills/`,
 *     or an explicit `${ETHOS_HOME}/`). Otherwise the cwd would hand every
 *     personality the others' `MEMORY.md`/`USER.md` and every unlisted store.
 *     Mirror of the same rule in `ScopedStorage` — the two change together.
 *
 * Deny-side comparisons (1, 1b, 2b) fold case on case-insensitive
 * filesystems ({@link foldDenyKey}, UBP-008).
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
  ) {
    this.denyPaths = alwaysDenyPaths.map((p) => foldDenyKey(normalize(resolve(p))));
    this.writeDenyPaths = writeDenyPaths.map((p) => foldDenyKey(normalize(resolve(p))));
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
      if (next === null) return;
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
      current = next;
      prefix = nextPrefix;
    }
    throw new Error(
      `PATH_NOT_REACHABLE: ${kind} of "${path}" follows too many symbolic links to resolve`,
    );
  }

  private hitsWriteDeny(canonical: string, kind: string): boolean {
    return kind === 'write' && matchesAny(foldDenyKey(canonical), this.writeDenyPaths);
  }

  private hitsDenyFloor(canonical: string): boolean {
    const key = foldDenyKey(canonical);
    return this.denyPaths.some(
      (deny) => key === deny || key.startsWith(deny.endsWith('/') ? deny : `${deny}/`),
    );
  }
}

/** True when `canonical` equals, or lies under, one of the canonical `paths`. */
function matchesAny(canonical: string, paths: readonly string[]): boolean {
  return paths.some((p) => canonical === p || canonical.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/**
 * The canonical form of the first allowed prefix containing `canonical`, or
 * null when no prefix does. Purely lexical — no filesystem access. A prefix
 * that would reach into an Ethos state dir only as its ancestor is skipped
 * (layer 2b, {@link shadowsStateDir}).
 */
function matchAllowedPrefix(canonical: string, allowed: Iterable<string>): string | null {
  const stateDirKeys = ethosStateDirs().map((d) => foldDenyKey(normalize(resolve(d))));
  const pathKey = foldDenyKey(canonical);
  for (const prefix of allowed) {
    const canonicalPrefix = normalize(resolve(prefix));
    if (
      canonical === canonicalPrefix ||
      canonical.startsWith(canonicalPrefix.endsWith('/') ? canonicalPrefix : `${canonicalPrefix}/`)
    ) {
      if (shadowsStateDir(foldDenyKey(canonicalPrefix), pathKey, stateDirKeys)) continue;
      return canonicalPrefix;
    }
  }
  return null;
}

/** True when `path` equals `root` or lies below it (both already canonical). */
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * Layer 2b (UBP-047): true when `prefixKey` covers `pathKey` only because it is
 * a strict ancestor of a state dir that holds the path. All three are
 * {@link foldDenyKey} keys — this is a deny-direction test.
 */
function shadowsStateDir(prefixKey: string, pathKey: string, stateDirKeys: string[]): boolean {
  return stateDirKeys.some(
    (dir) => within(dir, pathKey) && within(prefixKey, dir) && prefixKey !== dir,
  );
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
