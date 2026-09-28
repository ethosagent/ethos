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
import { homedir } from 'node:os';
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
import { runIsTainted } from './run-taint';

/** Bound on symlink hops followed while validating a single path. */
const MAX_SYMLINK_HOPS = 32;

/** Why a `denyWhen` refusal happened, as the `PATH_NOT_REACHABLE` message says it. */
const SHARED_DENY_WHY =
  'private memory and Ethos state are not reachable from a shared conversation';

/**
 * Whether this platform's default filesystems compare names case-insensitively
 * — APFS on macOS and NTFS on Windows, where `TOOLSET.yaml` opens the existing
 * `toolset.yaml`. Linux is treated as case-sensitive, so its behaviour is
 * unchanged; a case-sensitive APFS volume only over-denies, never under.
 */
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * A platform-conditional deny key (UBP-008). On a case-insensitive
 * filesystem two spellings that differ only in case name one file, so a deny
 * entry must match every spelling. A full case fold (not `toLowerCase` alone)
 * so characters that case-FOLD onto ASCII — U+017F long s, U+212A Kelvin sign
 * — land on the same key, and NFC so composed and decomposed spellings agree.
 * The fold is lower-upper-lower (V-ES-1): U+1E9E CAPITAL SHARP S uppercases
 * to itself and lowercases to `ß`, so upper-then-lower left `.ẞh` as `.ßh`
 * while APFS opens it as `.ssh`; lowercasing first reaches `ß`, whose
 * uppercase is `SS`. On macOS the key also drops leading
 * `/System/Volumes/Data`, `/.nofollow` and `/.resolve/<n>` components
 * ({@link VOLUME_ALIAS_PREFIX}, V-ES-3, V2-SEC-1), so an alias spelling of a
 * denied path or of the state dir is the same key. Every deny refuses a
 * `/.vol` or `/.resolve` path outright, whatever this key says
 * (`isUnmappablePathAlias`, @ethosagent/types).
 * Folding more than the filesystem does only over-denies.
 *
 * Its one consumer in core is the default-reach cwd drop (`within` in
 * ../fs-reach.ts). The boundary checks in this file — the deny lists, the
 * state-dir exclusion (layer 2b) and the tainted state-dir write (1d) — use
 * `foldForDeny` instead, which folds case on every platform (post-merge round
 * I3). Allow prefixes stay exact, so a case variant of an allowed path is
 * refused rather than widened.
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
  return dataVolumeAlias ? stripVolumeAliases(folded) : folded;
}

/**
 * Whether `/System/Volumes/Data/<p>` names the same file as `/<p>` — macOS
 * 10.15+, where the writable data volume is mounted there and firmlinked into
 * the root (V-ES-3). A firmlink is not a symlink (`lstat` reports a plain
 * directory), so the symbolic-containment walk never sees it.
 */
export const DATA_VOLUME_FIRMLINK = process.platform === 'darwin';

/**
 * The leading components macOS resolves to the path that follows them, so
 * `<alias>/<p>` opens `/<p>` (compared case-insensitively — over-matching a
 * deny key only over-denies):
 * - `/System/Volumes/Data` — the data-volume firmlink (V-ES-3).
 * - `/.nofollow` — the VFS "no symlinks in this lookup" prefix (V2-SEC-1).
 * - `/.resolve/<n>` — the VFS lookup with `RESOLVE_*` flags `<n>` (V2-SEC-1).
 * Each was checked against a live macOS 26 volume (`/.nofollow/Users/…` and
 * `/.resolve/0/…`, `/.resolve/1/…`, `/.resolve/99/…` all open the plain path);
 * they may stack, so {@link stripVolumeAliases} loops.
 */
const VOLUME_ALIAS_PREFIX = /^(?:\/system\/volumes\/data|\/\.nofollow|\/\.resolve\/\d+)(?=\/|$)/i;

/**
 * Drops every leading {@link VOLUME_ALIAS_PREFIX} component. Mapping an entry
 * that is NOT an alias onto the root only over-denies, which is the safe
 * direction for a deny key.
 */
function stripVolumeAliases(key: string): string {
  let out = key;
  for (;;) {
    const match = VOLUME_ALIAS_PREFIX.exec(out);
    if (match === null) return out;
    const rest = out.slice(match[0].length);
    if (rest === '' || rest === '/') return '/';
    out = rest;
  }
}

/**
 * Every directory Ethos keeps its state in: `~/.ethos`, `ETHOS_STATE_DIR` when
 * set (both read per call), and `extra` — the state dirs wiring knows that the
 * environment does not (its `dataDir`, injected as `ScopedFsImpl`'s eighth
 * argument from `CapabilityBackends.stateDirs`; post-merge round I1). Each in
 * its lexical form and its realpath ({@link withRealPaths}, verification round
 * A2) so a symlinked state dir is excluded (layer 2b) and taint-guarded under
 * its real name too. Mirror of `ethosStateDirs` in
 * `packages/storage-fs/src/sensitive-paths.ts` (core cannot import it).
 */
function ethosStateDirs(extra: readonly string[] = []): string[] {
  const dirs = [join(homedir(), '.ethos')];
  const override = process.env.ETHOS_STATE_DIR;
  for (const dir of override ? [override, ...extra] : extra) {
    const abs = resolve(dir);
    if (!dirs.includes(abs)) dirs.push(abs);
  }
  return withRealPaths(dirs);
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
 *  2b. **State-dir exclusion** (UBP-047) — an allow prefix that is a STRICT
 *     ancestor of an Ethos state dir (the cwd grant when the process runs
 *     from `~` or `/`) does not reach INTO that state dir: a path there must
 *     be granted by a prefix at or below the state dir (`ownDir`, `skills/`,
 *     or an explicit `${ETHOS_HOME}/`). Otherwise the cwd would hand every
 *     personality the others' `MEMORY.md`/`USER.md` and every unlisted store.
 *     Layer 4 applies it again on the real target, comparing each prefix by
 *     its realpath ({@link reachesStateDirThroughLink}), so a granted prefix
 *     that is a symlink to an ancestor of a state dir does not reach into it
 *     either (post-merge round I2). Mirror of the same rule in
 *     `ScopedStorage` — the two change together.
 *
 *  1d. **Tainted state-dir write** (V2-SEC-2 b) — once the run has read
 *     untrusted content, a write into an Ethos state dir outside a
 *     personality's `files/` is refused ({@link writesEthosState}), on the
 *     lexical path and on the real target (layer 4).
 *
 * The state dirs 2b and 1d judge are `~/.ethos`, `ETHOS_STATE_DIR` and the
 * injected `stateDirs` (wiring's `dataDir`), with their realpaths
 * ({@link ethosStateDirs}; post-merge round I1). Every deny-direction
 * comparison here — layers 1, 1b, 2b and 1d — uses `foldForDeny` keys, which
 * fold case on every platform (post-merge round I3). Folding only ever
 * refuses more.
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
    private readonly extraStateDirs: readonly string[] = [],
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
    const stateDirs = ethosStateDirs(this.extraStateDirs);

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
    if (this.hitsTaintedStateWrite(canonical, kind, stateDirs)) {
      throw new Error(
        `PATH_NOT_REACHABLE: write of "${path}" refused — this run read untrusted content, and the Ethos state dir holds what later prompts read`,
      );
    }

    let prefix = matchAllowedPrefix(canonical, allowed, stateDirs);
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
        this.checkRealTarget(canonical, path, kind, allowed, stateDirs);
        return;
      }
      const nextPrefix = matchAllowedPrefix(next, allowed, stateDirs);
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
   * symlink walk has nothing more to follow, and the state-dir exclusion on
   * the real target ({@link reachesStateDirThroughLink}). Mirror of
   * `ScopedStorage.checkRealTarget` (packages/storage-fs/src/scoped-storage.ts).
   */
  private checkRealTarget(
    canonical: string,
    path: string,
    kind: string,
    allowed: Set<string>,
    stateDirs: readonly string[],
  ): void {
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
    if (this.hitsTaintedStateWrite(real, kind, stateDirs)) {
      throw new Error(
        `PATH_NOT_REACHABLE: write of "${path}" refused — this run read untrusted content, and the Ethos state dir holds what later prompts read`,
      );
    }
    if (reachesStateDirThroughLink(real, allowed, stateDirs)) {
      throw new Error(
        `PATH_NOT_REACHABLE: ${kind} of "${path}" resolves into an Ethos state dir no grant at or below it covers`,
      );
    }
  }

  /** Layer 1d — a write into the state dir after the run read untrusted content. */
  private hitsTaintedStateWrite(
    canonical: string,
    kind: string,
    stateDirs: readonly string[],
  ): boolean {
    return kind === 'write' && runIsTainted() && writesEthosState(canonical, stateDirs);
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
 * V2-SEC-2 (b): true when a write to `canonical` lands in an Ethos state dir
 * outside a personality's asset folder (`personalities/<id>/files/`,
 * `personalityAssetDir` in ../fs-reach.ts). Everything else there is text a
 * LATER prompt carries — `MEMORY.md`/`USER.md` (deliberately not write-denied:
 * the memory provider writes them), team memory, skills, a new personality's
 * `SOUL.md`, cron's `jobs.json` — so once the run has read untrusted content
 * (`runIsTainted`, ./run-taint.ts) `checkReach` refuses it for the rest of the
 * run, the same promise the memory writers keep. `stateDirs` is
 * {@link ethosStateDirs} with the injected dirs (post-merge round I1);
 * compared as `foldForDeny` keys (I3). Pinned by
 * `../__tests__/downgrade-derived-runs.test.ts` and, for a wiring-only data
 * dir, `packages/wiring/src/__tests__/custom-datadir-floor.test.ts`.
 */
function writesEthosState(canonical: string, stateDirs: readonly string[]): boolean {
  const key = foldForDeny(canonical);
  return stateDirs.some((dir) => {
    const root = foldForDeny(normalize(resolve(dir)));
    if (!within(root, key)) return false;
    const [top, , sub] = key.slice(root.length + 1).split('/');
    return !(top === 'personalities' && sub === 'files');
  });
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
 * null when no prefix does. Purely lexical — no filesystem access. A prefix
 * that would reach into an Ethos state dir only as its ancestor is skipped
 * (layer 2b, {@link shadowsStateDir}) — `stateDirs` is {@link ethosStateDirs}
 * with the injected dirs.
 */
function matchAllowedPrefix(
  canonical: string,
  allowed: Iterable<string>,
  stateDirs: readonly string[],
): string | null {
  const stateDirKeys = stateDirs.map((d) => foldForDeny(normalize(resolve(d))));
  const pathKey = foldForDeny(canonical);
  for (const prefix of allowed) {
    const canonicalPrefix = normalize(resolve(prefix));
    if (
      canonical === canonicalPrefix ||
      canonical.startsWith(canonicalPrefix.endsWith('/') ? canonicalPrefix : `${canonicalPrefix}/`)
    ) {
      if (shadowsStateDir(foldForDeny(canonicalPrefix), pathKey, stateDirKeys)) continue;
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
 * `foldForDeny` keys — this is a deny-direction test.
 */
function shadowsStateDir(prefixKey: string, pathKey: string, stateDirKeys: string[]): boolean {
  return stateDirKeys.some(
    (dir) => within(dir, pathKey) && within(prefixKey, dir) && prefixKey !== dir,
  );
}

/**
 * Layer 2b on the real target (post-merge round I2): true when `real` — the
 * realpath of the accessed path — lies in a state dir that no `allowed` prefix
 * at or below that state dir covers, each prefix compared by ITS realpath.
 * Layer 2b alone judges the lexical grant, so a granted `/x/link` → `$HOME`
 * passed it for `/x/link/.ethos/…`. `foldForDeny` keys; deny-direction only.
 * Mirror of `reachesStateDirThroughLink` in
 * `packages/storage-fs/src/scoped-storage.ts`. Pinned by the I2 case in
 * `../__tests__/scoped-fs-casefold-statedir.test.ts`.
 */
function reachesStateDirThroughLink(
  real: string,
  allowed: Iterable<string>,
  stateDirs: readonly string[],
): boolean {
  const realKey = foldForDeny(real);
  const holding = stateDirs
    .map((d) => foldForDeny(normalize(resolve(d))))
    .filter((dir) => within(dir, realKey));
  if (holding.length === 0) return false;
  const prefixKeys = [...allowed].map((p) => {
    const canonicalPrefix = normalize(resolve(p));
    return foldForDeny(realPathOfLongestExistingAncestor(canonicalPrefix) ?? canonicalPrefix);
  });
  return holding.some(
    (dir) => !prefixKeys.some((prefix) => within(dir, prefix) && within(prefix, realKey)),
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
