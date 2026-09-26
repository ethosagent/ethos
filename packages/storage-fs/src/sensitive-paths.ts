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
 * LIMITATION: the entries are an enumeration, not "everything but my own
 * directory". Stores not listed (`delivery-ledger.db`, `inbound-spool.db`,
 * `cron/`, `teams/`, …) and OTHER personalities' directories stay readable to
 * a personality whose declared or default reach covers the state dir (the
 * default reach covers it when the process cwd is `~` or the state dir). The
 * floor is static and has no notion of which personality is asking.
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
