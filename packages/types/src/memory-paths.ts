// Which filesystem paths hold private memory (plan
// personality-memory-boundary-and-self-amendment, G1-5 / D7).
//
// A shared turn (`TurnAudience` `'shared'`, ./audience.ts) may not read or
// write any of these through a file tool, while every other file under a
// personality directory — the `files/` asset folder, `ui/` Canvas templates,
// `SOUL.md` — stays reachable. The deny targets memory FILES through a
// predicate rather than a prefix list, because a prefix list cannot say
// `personalities/*/MEMORY.md`.
//
// Enforced as the `denyWhen` option of BOTH personality filesystem boundaries:
// `ScopedStorage.check` / `checkSubtree` (packages/storage-fs/src/scoped-storage.ts)
// and `ScopedFsImpl.checkReach` (packages/core/src/scoped/scoped-fs.ts), each
// judging the lexical path AND every symlink-resolved hop. The predicate is
// built per shared turn by `sharedTurnDenyFor`
// (packages/core/src/agent-loop/audience.ts), inside `sharedTurnPathDeny`
// below — which, since verification round E4, also refuses everything else
// under the state dir but the turn's own `files/`, `ui/`, `SOUL.md` and the
// skills. The file-name set is pinned
// against each memory backend's own constants by
// `packages/types/src/__tests__/memory-paths.test.ts`.
//
// Pure and dependency-free like the id validators beside it: string
// operations only, no `node:path`. Callers pass ABSOLUTE, already-resolved
// paths (both boundaries `resolve()` before asking); a `..` segment is not
// interpreted here.
//
// Every comparison is case- and normalization-folded (`foldForDeny`,
// ./deny-fold.ts): on a case-insensitive file system `personalities/a/memory.md`
// IS `MEMORY.md`, so an exact comparison would let a case variant through.
// Folding only ever refuses more, and this module only answers deny questions.

import { foldForDeny } from './deny-fold';

/**
 * Where private memory lives on this machine.
 *
 * - `stateDirs` — the Ethos state directory (`<ethosHome>` / the wiring
 *   `dataDir`). Under each: the personality-scope memory files in
 *   `personalities/<id>/`, the whole `users/` tree (`user:<id>` scope), team
 *   memory in `teams/<team>/memory/` (D4(a)), and the vector store's
 *   `memory.db*` + its `MEMORY.md` export plus the global/team history and
 *   approval-queue files at the root.
 * - `extraRoots` — directories private in their entirety: the vault root when
 *   `memory: vault` (vault `search()` reads across the whole vault, not only
 *   the agent subtree).
 *
 * Roots are matched lexically (case-folded): a state directory reached
 * through a symlink ABOVE it is matched only by the names the caller passed.
 * Callers therefore pass every form of each root — `sharedTurnDenyFor`
 * (packages/core/src/agent-loop/audience.ts) adds the default state dirs and
 * the realpath of every root — and both boundaries also judge the realpath of
 * the target's longest existing ancestor.
 */
export interface PrivateMemoryRoots {
  stateDirs: readonly string[];
  extraRoots?: readonly string[];
}

/**
 * A boundary's private-path deny predicate. `'access'` asks about the path
 * itself (read, write, list, exists …); `'subtree'` asks whether removing or
 * renaming the path would move a private memory path without naming it (a
 * directory that CONTAINS one). `kind` says whether an `'access'` is a read
 * or a write; both boundaries pass it, and a predicate given none must judge
 * the access as a write (fail closed). `privateMemoryPathDeny` ignores it;
 * `sharedTurnPathDeny` allows two entries for reading only.
 */
export type PrivatePathDeny = (
  absPath: string,
  op: 'access' | 'subtree',
  kind?: 'read' | 'write',
) => boolean;

/** Memory file names in a personality scope directory (`MarkdownFileMemoryProvider`). */
export const PRIVATE_MEMORY_FILE_NAMES: readonly string[] = ['MEMORY.md', 'USER.md'];

/**
 * The directory `HistoryStore` keeps full before-content blobs in, next to
 * `memory-history.jsonl` — memory content, so private too.
 */
export const PRIVATE_MEMORY_BLOB_DIR = 'history-blobs';

/**
 * The vector store's database, directly under the state dir. Its SQLite
 * siblings (`-wal`, `-shm`, `-journal`) share the prefix and are private too.
 */
export const PRIVATE_MEMORY_DB_FILE = 'memory.db';

/**
 * True for a memory bookkeeping file — every name starting `memory-`:
 * `memory-history.jsonl` and its monthly `memory-history-YYYY-MM.jsonl`
 * archives (and the rotation's `.rotating` snapshot), `memory-pending.jsonl`,
 * `memory-tombstones.jsonl`, and the nightly pass's `memory-meta.json` and
 * `memory-archive.md` (archived memory sections). A prefix, not a list, so a
 * new bookkeeping file is private by default.
 */
export function isMemoryBookkeepingFileName(name: string): boolean {
  const folded = foldForDeny(name);
  return folded.startsWith('memory-') && folded.length > 'memory-'.length;
}

/**
 * A state-dir or scope-directory entry that is memory content or memory
 * bookkeeping: `MEMORY.md`/`USER.md` and any `.<suffix>` sibling (an atomic
 * write's temp file holds the same bytes), `history-blobs/`, and
 * {@link isMemoryBookkeepingFileName}.
 */
function isMemoryEntryName(name: string): boolean {
  return (
    FOLDED_MEMORY_FILE_NAMES.some((n) => name === n || name.startsWith(`${n}.`)) ||
    name === PRIVATE_MEMORY_BLOB_DIR ||
    isMemoryBookkeepingFileName(name)
  );
}

/** {@link PRIVATE_MEMORY_FILE_NAMES}, folded like every segment compared against them. */
const FOLDED_MEMORY_FILE_NAMES: readonly string[] = PRIVATE_MEMORY_FILE_NAMES.map(foldForDeny);

/**
 * Segments of an absolute path with empty segments (doubled or trailing `/`)
 * dropped, each folded by `foldForDeny` — so every comparison below is
 * case-insensitive, including the root prefix (`~/.ETHOS` is `~/.ethos`).
 */
function segmentsOf(absPath: string): string[] {
  return foldForDeny(absPath)
    .split('/')
    .filter((s) => s.length > 0 && s !== '.');
}

/**
 * The segments of `absPath` below `root`, `[]` when they are the same path,
 * or `null` when `absPath` is not `root` and not under it.
 */
function segmentsBelow(absPath: string, root: string): string[] | null {
  const path = segmentsOf(absPath);
  const base = segmentsOf(root);
  if (path.length < base.length) return null;
  for (let i = 0; i < base.length; i++) if (path[i] !== base[i]) return null;
  return path.slice(base.length);
}

/**
 * True when `absPath` is private memory under `roots` (the list in
 * {@link PrivateMemoryRoots}). Directories count when they ARE private
 * (`users/`, `teams/<team>/memory/`, an extra root, `history-blobs/`) — not
 * when they merely contain something private; see
 * {@link containsPrivateMemoryPath} for that.
 */
export function isPrivateMemoryPath(absPath: string, roots: PrivateMemoryRoots): boolean {
  for (const root of roots.extraRoots ?? []) {
    if (segmentsBelow(absPath, root) !== null) return true;
  }
  for (const stateDir of roots.stateDirs) {
    const rel = segmentsBelow(absPath, stateDir);
    if (rel === null || rel.length === 0) continue;
    const first = rel[0];
    const third = rel[2];
    // `<stateDir>/users/**` — the `user:<id>` scope.
    if (first === 'users') return true;
    // `<stateDir>/personalities/<id>/<memory entry>/**`.
    if (first === 'personalities' && third !== undefined && isMemoryEntryName(third)) return true;
    // `<stateDir>/teams/<team>/memory/**` (D4(a)).
    if (first === 'teams' && third === 'memory') return true;
    // `<stateDir>/<memory.db*|MEMORY.md*|USER.md*|memory-*|history-blobs>/**`
    // — the vector store and its export, and the `global`/`team:` history
    // and approval-queue files, which resolve to the state dir itself.
    if (
      first !== undefined &&
      (first.startsWith(PRIVATE_MEMORY_DB_FILE) || isMemoryEntryName(first))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when removing or renaming `absPath` would move a private memory path:
 * it is private itself, or it is a directory containing one — an ancestor of
 * (or equal to) a state dir or extra root, `personalities/`, a
 * `personalities/<id>/` directory, `teams/` or a `teams/<team>/` directory.
 */
export function containsPrivateMemoryPath(absPath: string, roots: PrivateMemoryRoots): boolean {
  if (isPrivateMemoryPath(absPath, roots)) return true;
  const allRoots = [...roots.stateDirs, ...(roots.extraRoots ?? [])];
  for (const root of allRoots) {
    if (segmentsBelow(root, absPath) !== null) return true;
  }
  for (const stateDir of roots.stateDirs) {
    const rel = segmentsBelow(absPath, stateDir);
    if (rel === null) continue;
    if ((rel[0] === 'personalities' || rel[0] === 'teams') && rel.length <= 2) return true;
  }
  return false;
}

/**
 * The boundary predicate for {@link PrivateMemoryRoots}: `'access'` →
 * {@link isPrivateMemoryPath}, `'subtree'` → {@link containsPrivateMemoryPath}.
 */
export function privateMemoryPathDeny(roots: PrivateMemoryRoots): PrivatePathDeny {
  return (absPath, op) =>
    op === 'subtree'
      ? containsPrivateMemoryPath(absPath, roots)
      : isPrivateMemoryPath(absPath, roots);
}

/**
 * The file deny for a SHARED turn (plan personality-memory-boundary G1,
 * verification round E4): a shared turn can read nothing under the Ethos
 * state directory except its own `files/`, `ui/`, `SOUL.md` and the skills.
 *
 * Private memory is not the only private thing under a state dir — cron run
 * output (`cron/output/**`), compaction transcripts (`compaction/**`), the
 * session, job, kanban and goal databases, `config.yaml` and every other
 * personality's directory all carry what private turns read and said. So
 * under each of `roots.stateDirs` the rule is an allowlist, not a denylist:
 *
 * - `personalities/<self>/files/**` and `personalities/<self>/ui/**` — read
 *   and write (the asset drop and the Canvas templates `render_ui` reads);
 * - `personalities/<self>/SOUL.md` and `personalities/<self>/skills/**` —
 *   read only (their write is refused by the definition floor anyway);
 * - `skills/**` — read only;
 * - everything else, the state dir itself included — refused.
 *
 * On top of that, {@link isPrivateMemoryPath} still applies everywhere, so
 * `roots.extraRoots` (the vault) and memory anywhere else stay refused.
 * `self` is compared folded like every segment; an empty `self` (a call with
 * no personality) allows nothing under `personalities/`. `'subtree'` refuses
 * a remove/rename of anything the access rule refuses to write, of an
 * ancestor of a state dir, or of anything holding private memory.
 *
 * Built per shared turn by `sharedTurnDenyFor`
 * (packages/core/src/agent-loop/audience.ts), which passes every form of each
 * state dir (lexical, realpath; case and the macOS firmlink are folded here).
 * Pinned by the E4 cases in `packages/types/src/__tests__/memory-paths.test.ts`
 * and `packages/core/src/__tests__/shared-audience.test.ts`.
 */
export function sharedTurnPathDeny(roots: PrivateMemoryRoots, self: string): PrivatePathDeny {
  const ownId = foldForDeny(self);
  const refusedUnderStateDir = (absPath: string, kind: 'read' | 'write'): boolean => {
    for (const stateDir of roots.stateDirs) {
      const rel = segmentsBelow(absPath, stateDir);
      if (rel === null) continue;
      if (!sharedTurnMayReach(rel, ownId, kind)) return true;
    }
    return false;
  };
  return (absPath, op, kind) => {
    if (op === 'subtree') {
      if (containsPrivateMemoryPath(absPath, roots)) return true;
      return refusedUnderStateDir(absPath, 'write');
    }
    if (isPrivateMemoryPath(absPath, roots)) return true;
    return refusedUnderStateDir(absPath, kind ?? 'write');
  };
}

/** The allowlist in {@link sharedTurnPathDeny}, over folded segments below a state dir. */
function sharedTurnMayReach(
  rel: readonly string[],
  ownId: string,
  kind: 'read' | 'write',
): boolean {
  if (rel[0] === 'skills') return kind === 'read';
  if (rel[0] !== 'personalities' || ownId.length === 0 || rel[1] !== ownId) return false;
  const entry = rel[2];
  if (entry === 'files' || entry === 'ui') return true;
  // Its own skills are SOUL-adjacent, like `<state>/skills/` (verification
  // round G9); their write is refused by the definition floor anyway.
  if (entry === 'skills') return kind === 'read';
  return entry === 'soul.md' && rel.length === 3 && kind === 'read';
}
