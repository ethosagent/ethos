import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
 * the floor is static with no notion of which personality is asking. Local
 * `terminal` is not mediated by Storage at all (see `PERSONALITY_DEFINITION_ENTRIES`
 * in `packages/core/src/fs-reach.ts`).
 * `backups/` is deliberately NOT listed although its archives carry every
 * store above: the operator's own archive download confines its reads to that
 * directory with a `ScopedStorage` over this same floor
 * (`BackupService.reachable`, apps/web-api/src/services/backup.service.ts).
 */
export function sensitiveDenyPaths(): string[] {
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
    ...ethosStateDirs().flatMap((dir) => STATE_DIR_DENY_ENTRIES.map((entry) => join(dir, entry))),
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
 * The key every DENY-side path comparison uses (UBP-008): this manifest's
 * floor in `ScopedStorage`, its write-deny list and state-dir exclusion, the
 * tools-file write blocklists and the terminal/process argv floors. On a
 * case-insensitive filesystem two spellings that differ only in case name one
 * file, so a deny entry must match every spelling. A full case fold (not
 * `toLowerCase` alone) so characters that case-FOLD onto ASCII — U+017F long
 * s, U+212A Kelvin sign — land on the same key, and NFC so composed and
 * decomposed spellings agree. The fold is lower-upper-lower (V-ES-1): U+1E9E
 * CAPITAL SHARP S uppercases to itself and lowercases to `ß`, so
 * upper-then-lower left `.ẞh` as `.ßh` while APFS opens it as `.ssh`;
 * lowercasing first reaches `ß`, whose uppercase is `SS`. On macOS the key
 * also drops a leading `/System/Volumes/Data` ({@link DATA_VOLUME_FIRMLINK},
 * V-ES-3), so the firmlink spelling of a denied path or of the state dir is
 * the same key. Folding more than the filesystem does only over-denies.
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
 * Every directory Ethos keeps its state in: `~/.ethos`, plus the
 * `ETHOS_STATE_DIR` override when one is set (the same override `ethosDir()`
 * in `@ethosagent/config` honours — this package sits below config in the
 * layer model, so it reads the variable itself). Read per call, like
 * `homedir()` above. Both are listed when the override is set because a
 * process can run under an override while the default dir still holds a
 * previous profile's keys.
 *
 * Also consumed by the terminal and process argv floors
 * (`extensions/tools-terminal/src/guard.ts`, `extensions/tools-process/src/guard.ts`),
 * which refuse a command that names a state dir at all (S16).
 */
export function ethosStateDirs(): string[] {
  const dirs = [join(homedir(), '.ethos')];
  const override = process.env.ETHOS_STATE_DIR;
  if (override && resolve(override) !== dirs[0]) dirs.push(resolve(override));
  return dirs;
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
 */
const STATE_DIR_DENY_ENTRIES: ReadonlyArray<string> = [
  'keys.json',
  'secrets',
  'config.yaml',
  'web-token',
  'mcp.json',
  'plugins',
  'scripts',
  ...sqliteFiles('sessions.db'),
  ...sqliteFiles('observability.db'),
  ...sqliteFiles('memory.db'),
];
