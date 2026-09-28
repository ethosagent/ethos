// Raw `node:fs` (`realpathSync`, `lstatSync`, `readlinkSync`) is the storage-fs
// carve-out: this package IS the filesystem adapter, and a realpath is a
// filesystem fact no `Storage` method answers.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { type DefinitionWriteFloor, personalityDefinitionWriteFloor } from '@ethosagent/types';

/**
 * Canonical set of security-sensitive filesystem paths — credentials,
 * private keys, shell histories, and system auth/kernel interfaces that no
 * personality or tool may read or write.
 *
 * Single source of truth for the filesystem deny mechanisms that would
 * otherwise drift independently:
 *   - ScopedStorage always-deny floor → `defaultAlwaysDeny()` (read + write)
 *   - tools-file write blocklist      → `BLOCKED_WRITE_*` (write only)
 *   - tools-terminal / tools-process  → `ARGV_FS_DENY_PATTERNS` (shell-argv match),
 *     plus `stateDirReference`, which refuses any literal state-dir path
 *
 * Each entry is a path prefix: a directory deny (e.g. `~/.ssh`) also covers
 * everything beneath it. Recomputes `homedir()` per call so a test that
 * overrides `$HOME` before constructing a consumer sees the override rather
 * than a snapshotted directory.
 *
 * Coverage differs by mechanism, and that difference is intentional: the
 * always-deny and write floors cover this set in full, but the argv floor is
 * pattern-based and can only match a subset of these paths inside an
 * arbitrary shell string, so it references a subset. The parity tests in the
 * four consumers assert each one covers the manifest to the extent its
 * mechanism can, and never denies a path this manifest does not list.
 *
 * Under every Ethos state dir ({@link ethosStateDirs}) the manifest denies
 * {@link STATE_DIR_DENY_ENTRIES} (PST-001, plan openclaw-2026.9.6-gaps). The
 * state dir itself is NOT denied: a personality's own directory
 * (`personalities/<self>/`, where `MEMORY.md` and `files/` live) and
 * `skills/` sit under it and are in its default reach
 * (`deriveFsReachPaths`, `packages/core/src/fs-reach.ts`).
 *
 * The entries are an enumeration, not "everything but my own directory":
 * stores not listed (`delivery-ledger.db`, `inbound-spool.db`, `cron/`,
 * `teams/`, …) and OTHER personalities' directories are kept out of the
 * DEFAULT reach by two further rules, not by this floor (UBP-047):
 *   - a grant that is a strict ANCESTOR of a state dir (the cwd grant when the
 *     process runs from `~` or `/`) does not reach into it — layer 2b in
 *     `ScopedStorage.check` (`scoped-storage.ts`) and `ScopedFsImpl.checkReach`
 *     (`packages/core/src/scoped/scoped-fs.ts`);
 *   - a process cwd AT or inside the state dir is dropped from the default
 *     reach (`deriveFsReachPaths`, `packages/core/src/fs-reach.ts`).
 * Pinned by `__tests__/scoped-storage-casefold-statedir.test.ts` and
 * `packages/core/src/__tests__/scoped-fs-casefold-statedir.test.ts`.
 *
 * LIMITATION: a personality that DECLARES `fs_reach` naming the state dir
 * itself (`${ETHOS_HOME}/`) or a directory inside it still reaches what that
 * names, other personalities included — an explicit grant is honoured, and
 * the non-definition files there (`MEMORY.md`, `files/`) stay writable; only
 * their definition entries are floored ({@link personalityDefinitionFloor}).
 * The floor is static with no notion of which personality is asking. Local
 * `terminal` is not mediated by Storage at all (see `PERSONALITY_DEFINITION_ENTRIES`
 * in `@ethosagent/types`).
 * `backups/` is deliberately NOT listed although its archives carry every
 * store above: the operator's own archive download confines its reads to that
 * directory with a `ScopedStorage` over this same floor
 * (`BackupService.reachable`, apps/web-api/src/services/backup.service.ts).
 */
export function sensitiveDenyPaths(extraStateDirs: readonly string[] = []): string[] {
  const home = homedir();
  return [
    `${home}/.ssh`,
    `${home}/.aws/credentials`,
    `${home}/.aws/config`,
    `${home}/.gnupg`,
    `${home}/.netrc`,
    `${home}/.bash_history`,
    `${home}/.zsh_history`,
    `${home}/.psql_history`,
    `${home}/.mysql_history`,
    `${home}/.npmrc`,
    ...ethosStateDirs(extraStateDirs).flatMap((dir) =>
      STATE_DIR_DENY_ENTRIES.map((entry) => join(dir, entry)),
    ),
    `${home}/Library/Keychains`,
    '/etc/passwd',
    '/etc/shadow',
    '/etc/sudoers',
    '/etc/sudoers.d',
    '/root',
    '/boot',
    '/sys',
    '/proc/sys',
    '/proc/self/environ',
    '/proc/self/cmdline',
  ];
}

/**
 * Whether this platform's default filesystems compare names case-insensitively
 * — APFS on macOS and NTFS on Windows, where `~/.SSH/id_rsa` opens `~/.ssh/id_rsa`
 * and `TOOLSET.yaml` opens `toolset.yaml`. Linux is treated as case-sensitive,
 * so its behaviour is unchanged; a case-sensitive APFS volume only over-denies.
 */
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * A platform-conditional deny key (UBP-008), used by the terminal and process
 * argv floors (`extensions/tools-terminal/src/guard.ts`,
 * `extensions/tools-process/src/guard.ts`) and by the `write_file` pre-check's
 * second probe of the definition floor (`isPersonalityDefinitionPath`,
 * `extensions/tools-file/src/index.ts`). `ScopedStorage` does not use it: its
 * deny lists and state-dir exclusion compare `foldForDeny` keys, which fold
 * case on every platform (post-merge round I3). On a
 * case-insensitive filesystem two spellings that differ only in case name one
 * file, so a deny entry must match every spelling. A full case fold (not
 * `toLowerCase` alone) so characters that case-FOLD onto ASCII — U+017F long
 * s, U+212A Kelvin sign — land on the same key, and NFC so composed and
 * decomposed spellings agree. The fold is lower-upper-lower (V-ES-1): U+1E9E
 * CAPITAL SHARP S uppercases to itself and lowercases to `ß`, so
 * upper-then-lower left `.ẞh` as `.ßh` while APFS opens it as `.ssh`;
 * lowercasing first reaches `ß`, whose uppercase is `SS`. On macOS the key
 * also drops leading `/System/Volumes/Data`, `/.nofollow` and `/.resolve/<n>`
 * components ({@link VOLUME_ALIAS_PREFIX}, V-ES-3, V2-SEC-1), so an alias
 * spelling of a denied path or of the state dir is the same key. Every deny
 * refuses a `/.vol` or `/.resolve` path outright, whatever this key says
 * (`isUnmappablePathAlias`, @ethosagent/types). Folding more than the
 * filesystem does only over-denies.
 * Allow-side matches stay exact, so a case variant of an allowed path is
 * refused rather than widened.
 *
 * Mirror of `foldDenyKey` in `packages/core/src/scoped/scoped-fs.ts` — core
 * cannot import this package at runtime; the two change together. Pinned by
 * `__tests__/scoped-storage-casefold-statedir.test.ts`.
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
 * Every directory Ethos keeps its state in: `~/.ethos`, plus the
 * `ETHOS_STATE_DIR` override when one is set (the same override `ethosDir()`
 * in `@ethosagent/config` honours — this package sits below config in the
 * layer model, so it reads the variable itself). Read per call, like
 * `homedir()` above. Both are listed when the override is set because a
 * process can run under an override while the default dir still holds a
 * previous profile's keys.
 *
 * Each dir is listed in its lexical form AND its realpath ({@link withRealPaths}),
 * lexical first: a state dir that is (or sits under) a symlink — `~/.ethos` →
 * `~/dot/ethos` — is otherwise reachable by its real name with no deny or
 * floor matching it (verification round A2). Pinned by the symlinked-state-dir
 * cases in `state-dir-deny.test.ts`.
 *
 * `extra` adds the state dirs a caller knows that the environment does not:
 * wiring passes its `dataDir` (verification round F2), because a host can
 * hand `createAgentLoop` a data directory that is neither `~/.ethos` nor
 * `ETHOS_STATE_DIR` — the desktop app's custom data folder — and a floor
 * computed from the environment alone would leave that directory unguarded.
 * `ScopedStorage` judges its state-dir exclusion over the same set (its
 * scope's `stateDirs`), and `ScopedFsImpl` keeps a mirror fed by
 * `CapabilityBackends.stateDirs` (post-merge round I1).
 * Every wiring construction of the floors passes it
 * (`packages/wiring/src/build-infrastructure.ts`, `build-agent-loop.ts`,
 * `memory-backend.ts`); pinned by the custom-dataDir cases in
 * `state-dir-deny.test.ts` and `packages/wiring/src/__tests__/scoped-storage-factory.test.ts`.
 *
 * Also consumed by the terminal and process argv floors
 * (`extensions/tools-terminal/src/guard.ts`, `extensions/tools-process/src/guard.ts`),
 * which refuse a command that names a state dir at all (S16). Those, and the
 * `write_file` pre-check, see only `~/.ethos` and `ETHOS_STATE_DIR`: a data
 * directory known only to wiring reaches them through the environment, which
 * is why the desktop app also sets `ETHOS_STATE_DIR` to its data folder
 * (`apps/desktop/src/main/serve.ts`).
 */
export function ethosStateDirs(extra: readonly string[] = []): string[] {
  const dirs = [join(homedir(), '.ethos')];
  const override = process.env.ETHOS_STATE_DIR;
  for (const dir of override ? [override, ...extra] : extra) {
    const abs = resolve(dir);
    if (!dirs.includes(abs)) dirs.push(abs);
  }
  return withRealPaths(dirs);
}

/**
 * `dirs` followed by the realpath of each one that differs from every entry
 * already listed. The realpath is {@link realPathOfLongestExistingAncestor},
 * so a state dir that does not exist yet still gets the real form of the
 * directory it would be created in; one that cannot be resolved at all keeps
 * only its lexical form.
 */
export function withRealPaths(dirs: readonly string[]): string[] {
  const out = [...dirs];
  for (const dir of dirs) {
    const real = realPathOfLongestExistingAncestor(dir);
    if (real !== null && !out.includes(real)) out.push(real);
  }
  return out;
}

/** Bound on the combined parent steps and symlink hops of one resolution. */
const MAX_RESOLVE_STEPS = 256;

/**
 * The realpath of `path`'s longest existing ancestor with the missing tail
 * re-appended — where a write to `path` would actually land. A dangling
 * symlink on the way is followed to its target (a write through it creates
 * the target). Returns null when the path cannot be resolved: an error other
 * than ENOENT/ENOTDIR (EACCES, ELOOP, …) or too many steps. Callers deciding
 * a DENY treat null as a refusal.
 *
 * Mirror of `realPathOfLongestExistingAncestor` in
 * `packages/core/src/scoped/scoped-fs.ts` — core cannot import this package at
 * runtime (ARCHITECTURE.md §II); the two MUST change together.
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

/** A SQLite database and the two side files WAL mode keeps beside it. */
const sqliteFiles = (name: string): string[] => [name, `${name}-wal`, `${name}-shm`];

/**
 * Entries under each state dir that no personality may read or write.
 *
 * - `keys.json`, `secrets` — credential material.
 * - `config.yaml`, `web-token` — operator config and the web API bearer; a
 *   write to `config.yaml` could flip an operator opt-in such as
 *   `execution.allowLocalFallback`.
 * - `mcp.json`, `plugins`, `scripts` — each is code the next boot or cron
 *   run executes on the host.
 * - `sessions.db`, `observability.db`, `memory.db` — every personality's
 *   transcripts, telemetry and vector memory in one file each.
 * - `constitution.yaml`, `evolve-config.json`, `allowlist.json`,
 *   `approval-leases.json` — operator policy (verification round F1). The
 *   constitution bounds every personality's tools, budget and mounts;
 *   `evolve-config.json`'s `autoApprove` lets the learning pipeline promote
 *   skills into `personalities/<id>/skills/` unreviewed (`learningPolicyFor`,
 *   packages/wiring/src/learning-pipeline.ts); the allowlist and the approval
 *   leases pre-approve dangerous tool calls. READS are denied too: no turn has
 *   a reason to read them, and every reader holds compose-time Storage —
 *   `loadConstitution` (packages/wiring/src/build-infrastructure.ts and
 *   amendments.ts), `loadEvolveConfig` (learning-pipeline.ts, `ethos evolve`,
 *   `ethos eval`) and the web-api's `AllowlistRepository` / `LeaseRepository`
 *   / `EvolverRepository`.
 * - `learning` — the learning inbox (candidates, frozen replay cases, its
 *   audit log, and G2's amendment records). A turn that could write there
 *   could plant or edit a candidate the owner later approves; READS are denied
 *   too (plan personality-memory-boundary G2-pre B), because the drafts come
 *   from private sessions. Every legitimate reader and writer — `skill_propose`,
 *   `skills_pending_*`, the nightly pass, `ethos learning`, the web Learning
 *   page — holds compose-time Storage (`LearningContext` in
 *   packages/wiring/src/learning-pipeline.ts), never a turn's.
 */
const STATE_DIR_DENY_ENTRIES: ReadonlyArray<string> = [
  'keys.json',
  'secrets',
  'config.yaml',
  'web-token',
  'mcp.json',
  'plugins',
  'scripts',
  'constitution.yaml',
  'evolve-config.json',
  'allowlist.json',
  'approval-leases.json',
  ...sqliteFiles('sessions.db'),
  ...sqliteFiles('observability.db'),
  ...sqliteFiles('memory.db'),
  'learning',
];

/**
 * The personality-definition WRITE floor (plan personality-memory-boundary
 * G2-pre B): under every Ethos state dir ({@link ethosStateDirs}, read when
 * this is called, plus `extraStateDirs` — wiring's `dataDir`), any `personalities/<any id>/<entry>` for an entry in
 * `PERSONALITY_DEFINITION_ENTRIES` (`@ethosagent/types`) is refused for write
 * — another personality's `toolset.yaml`, and the definition files of a
 * personality directory created mid-turn, not only the caller's own. A
 * predicate over the layout (`personalityDefinitionWriteFloor`), not an
 * enumeration of existing personalities.
 *
 * Applied by EVERY `ScopedStorage` on its own (constructor → `check` /
 * `checkSubtree`, lexical path, every symlink hop and the target's realpath;
 * case-folded, `foldForDeny` in `@ethosagent/types`), and handed by wiring to
 * every `ScopedFsImpl` through `CapabilityBackends.definitionWriteFloor`
 * (packages/wiring/src/build-infrastructure.ts) — the same predicate, so the
 * two boundary copies cannot disagree. Reads stay open: a turn may read a
 * definition it cannot change. Pinned by `state-dir-deny.test.ts` and the
 * floor cases in `scoped-storage.test.ts` / `packages/core/src/__tests__/scoped-fs.test.ts`.
 *
 * Legitimate writers never pass through it: `scaffold_personality`, the web
 * editor and CLI (`FilePersonalityRegistry`), import/restore and claw-migrate
 * all hold compose-time, unscoped Storage.
 */
export function personalityDefinitionFloor(
  extraStateDirs: readonly string[] = [],
): DefinitionWriteFloor {
  return personalityDefinitionWriteFloor(ethosStateDirs(extraStateDirs));
}
