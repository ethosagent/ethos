// The scheduled half of `ethos backup` — what the `backup` system cron job
// runs, and the settings that drive it.
//
// Three things separate a scheduled backup from the CLI one:
//
//  1. It runs INSIDE a serving process, so the snapshot mode is `'backup'`
//     (async, plan D2). `VACUUM INTO` is synchronous in `@ethosagent/sqlite`
//     and would stall the event loop — every gateway turn, every HTTP request,
//     every voice frame — for as long as it takes to copy the databases.
//  2. It rotates. Run after run it points at one directory, so without a limit
//     it fills the disk it is protecting.
//  3. It shares that directory with a human who may run `ethos backup` at the
//     same moment, hence the `.lock` sentinel.
//
// Rotation deletes files, so it is deliberately narrow about which ones it
// will consider: only entries matching the exact name this module writes
// (`SCHEDULED_ARCHIVE_RE`). A `*.tar.gz` glob would sweep up a manual
// `ethos backup` archive, a pre-upgrade copy an operator parked here, or an
// unrelated tarball — the way a backup tool ends up eating something it did
// not create.

import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { type EthosConfig, ethosDir } from '@ethosagent/config';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { createBackup } from './backup/create';
import type { ExternalMemoryNotice } from './backup/external-memory';
import { DEFAULT_SCOPES, parseScopes, type ScopeName } from './backup/scopes';
import { acquireSentinelLock } from './backup/sentinel-lock';
import type { TarSkip } from './backup/tar';
import type { MemoryBackendSelection } from './memory-backend';

/** Fired at 04:00 local by default — after the nightly pass (03:00), not with it. */
export const DEFAULT_BACKUP_CRON = '0 4 * * *';
/** How many scheduled archives survive rotation. */
export const DEFAULT_BACKUP_KEEP = 7;

/**
 * Filenames the scheduled job produces, and the ONLY filenames rotation will
 * delete. Anchored on both ends and fully literal about both the timestamp
 * shape and the suffix.
 *
 * The suffix group is OPTIONAL because earlier versions of this module wrote
 * the un-suffixed name, and those archives are still sitting in the backup
 * directories of every deployment that upgrades. Rotation's contract is "only
 * the names this module writes" — that has to mean names it has ever written,
 * or the pre-upgrade set is orphaned and never deleted. Nothing produces the
 * un-suffixed name any more, so the group only ever matches history.
 *
 * It stays narrow in the ways that matter: eight lowercase hex digits and
 * nothing else, so a hand-named `…Z-final.tar.gz` an operator parked here is
 * still not ours to delete.
 */
export const SCHEDULED_ARCHIVE_RE =
  /^ethos-scheduled-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-[0-9a-f]{8})?\.tar\.gz$/;

/**
 * `ethos-scheduled-<iso>Z-<hex>.tar.gz` — the same shape, spelled the same way,
 * as `webArchiveName` in `apps/web-api/src/services/backup.service.ts` and
 * `defaultArchiveName` in `apps/ethos/src/commands/backup.ts`.
 *
 * The random suffix is what makes the name UNIQUE. The timestamp has
 * one-second resolution, and `createBackup` finishes by renaming its temp file
 * onto `outPath` — POSIX `rename` replaces an existing destination silently.
 * Two schedulers sharing one backup directory (`ethos serve` and
 * `ethos gateway` on one machine, both ticking at 04:00) therefore only need
 * the second to take the `.lock` within the same second as the first released
 * it, and the second archive renames over the first. Nothing errors, the
 * directory shows one row, and one of the two nightly backups is simply not
 * there. Both siblings answer it this way; all three must stay the same shape.
 *
 * The suffix goes AFTER the timestamp, and the timestamp is fixed-width, so
 * two names from different seconds still differ inside the timestamp — which
 * is what rotation's lexicographic ordering rests on (see `rotateBackups`).
 */
export function scheduledArchiveName(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `ethos-scheduled-${stamp}Z-${randomBytes(4).toString('hex')}.tar.gz`;
}

/** `backup.enabled` — on unless the operator turned it off. */
export function backupEnabled(config: EthosConfig): boolean {
  return config.backup?.enabled !== false;
}

/** `backup.cron`, defaulted. */
export function backupCron(config: EthosConfig): string {
  return config.backup?.cron ?? DEFAULT_BACKUP_CRON;
}

/**
 * Where backups are kept. `${ETHOS_HOME}` is deliberately NOT a token config
 * expands (plan D5) — the default is computed here, in code, and a relative
 * `backup.dir` resolves under the data dir rather than the process cwd, which
 * for a daemon is wherever it happened to be started.
 */
export function backupDirectory(config?: EthosConfig): string {
  const configured = config?.backup?.dir;
  if (!configured) return join(ethosDir(), 'backups');
  return isAbsolute(configured) ? configured : join(ethosDir(), configured);
}

export interface ResolvedBackupSettings {
  enabled: boolean;
  cron: string;
  scopes: ScopeName[];
  keep: number;
  dir: string;
}

/**
 * Full `backup.*` resolution. THROWS on an unusable `backup.scope` — the
 * scheduler never calls this (it reads `backupEnabled`/`backupCron`, which
 * cannot fail), so a scope typo surfaces as a failed backup run with the
 * offending name in the error, not as a config load that takes the whole CLI
 * down or as four other system jobs that silently never got seeded.
 */
export function resolveBackupSettings(config: EthosConfig): ResolvedBackupSettings {
  const scope = config.backup?.scope;
  const keep = config.backup?.keep;
  return {
    enabled: backupEnabled(config),
    cron: backupCron(config),
    scopes: scope && scope.length > 0 ? parseScopes(scope.join(',')) : [...DEFAULT_SCOPES],
    keep: keep !== undefined && keep > 0 ? Math.floor(keep) : DEFAULT_BACKUP_KEEP,
    dir: backupDirectory(config),
  };
}

// ---------------------------------------------------------------------------
// The `.lock` sentinel
// ---------------------------------------------------------------------------

const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 100;
/**
 * The clock fallback, used only when the lock body carries no readable pid (a
 * truncated write, or a file some other tool put there). A lock that names a
 * live process from THIS boot is not stale at any age, however long it has been
 * held — see `backup/holder-identity.ts` for why there is no outer clock any
 * more.
 */
const LOCK_STALE_MS = 60 * 60 * 1000;

export function backupLockPath(dir: string): string {
  return join(dir, '.lock');
}

/**
 * Exclusive-create sentinel: a manual `ethos backup` and the scheduled job must
 * not stream the same databases into two archives at once.
 *
 * The protocol — `wx` create, token confirmation, stale takeover by pid and
 * boot only when the incumbent is unchanged since read, release that deletes
 * only its own bytes, and the residual windows it does NOT close — lives in
 * `acquireSentinelLock` (`backup/sentinel-lock.ts`), shared with
 * `acquireIdentityMapLock`. What is this lock's own: the 5s default wait (the
 * CLI passes `timeoutMs: 0` to refuse at once), the 100ms poll, the one-hour
 * clock for a body with no readable pid, and the refusal text below.
 */
export async function acquireBackupLock(
  dir: string,
  opts?: { timeoutMs?: number },
): Promise<() => void> {
  const lockPath = backupLockPath(dir);
  return await acquireSentinelLock({
    lockPath,
    timeoutMs: opts?.timeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS,
    retryMs: LOCK_RETRY_MS,
    unreadableStaleMs: LOCK_STALE_MS,
    refusal: (pid) =>
      `another backup is already in progress — ${lockPath} is held` +
      `${pid === null ? '' : ` by process ${pid}`}. ` +
      (pid === null
        ? 'Wait for it to finish, or remove that file if no backup is running.'
        : `Wait for it to finish. Check with \`ps -p ${pid}\`: if process ${pid} is genuinely ` +
          `not running, delete ${lockPath} and retry. Removing it while that process IS ` +
          'backing up puts two writers on the same databases and two rotations deleting ' +
          "against each other's archives, so only do this once you have confirmed it is gone."),
  });
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Keep the newest `keep` scheduled archives; delete the rest, oldest first.
 *
 * Ordered by the timestamp in the NAME rather than mtime: the name is written
 * once and is lexicographically monotonic, while an mtime is whatever the last
 * `cp -p`, rsync or restore left behind. The uniqueness suffix cannot disturb
 * that — it sits behind a fixed-width timestamp, so two names from different
 * seconds have already diverged before a comparison reaches it. Returns what it
 * deleted.
 */
export async function rotateBackups(
  storage: Storage,
  dir: string,
  keep: number,
): Promise<string[]> {
  if (keep < 1) return [];
  const entries = await storage.listEntries(dir);
  const mine = entries
    .filter((e) => !e.isDir && SCHEDULED_ARCHIVE_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  const doomed = mine.slice(0, Math.max(0, mine.length - keep));
  for (const name of doomed) {
    await storage.remove(join(dir, name));
  }
  return doomed;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunScheduledBackupOptions {
  /** `~/.ethos` (or an `ETHOS_STATE_DIR` override). */
  dataDir: string;
  settings: ResolvedBackupSettings;
  storage: Storage;
  /** Vault to enumerate for the archive's secrets manifest. */
  secrets?: SecretsResolver;
  /** Injected by tests so archive names are deterministic. */
  now?: Date;
  /** How long to wait for the `.lock`. Defaults to 5s. */
  lockTimeoutMs?: number;
  /**
   * The deployment's memory selection. Under `memory: vault` the memory is
   * outside `dataDir` and in no archive, and the run output must say so (F04)
   * — this is the only place a scheduled run is reported.
   */
  memory?: MemoryBackendSelection;
}

export interface ScheduledBackupResult {
  path: string;
  scopes: ScopeName[];
  fileCount: number;
  bytes: number;
  /** Archives rotation removed, oldest first. */
  rotated: string[];
  /**
   * Files the writer could not encode into a tar entry, with the reason. Not
   * fatal — one unarchivable name must not cost the whole nightly archive —
   * and `fileCount` already excludes them, but the archive is then less than
   * what was asked for and `summarizeScheduledBackup` must say so.
   */
  skippedFiles: TarSkip[];
  /** Memory outside `dataDir`, absent from this archive (`memory: vault`). */
  externalMemory?: ExternalMemoryNotice;
}

/**
 * Create one scheduled archive, then rotate. Throws on any failure — the cron
 * tick turns a throw into a logged error plus `lastError` on the job. No CLI
 * surface reads that field: `ethos status` reports the newest archive by mtime
 * whatever its outcome, and `ethos cron list` prints `lastRunAt`, not
 * `lastError`. What an operator sees instead is the cron output file
 * `summarizeScheduledBackup` writes — see its doc below. A backup that fails
 * quietly is worse than no backup, because it looks like one.
 */
export async function runScheduledBackup(
  opts: RunScheduledBackupOptions,
): Promise<ScheduledBackupResult> {
  const { dir, scopes, keep } = opts.settings;
  const release = await acquireBackupLock(
    dir,
    opts.lockTimeoutMs !== undefined ? { timeoutMs: opts.lockTimeoutMs } : {},
  );
  try {
    const outPath = join(dir, scheduledArchiveName(opts.now ?? new Date()));
    const result = await createBackup({
      dataDir: opts.dataDir,
      outPath,
      scopes,
      // MANDATORY here (D2): this runs in a serving process.
      snapshot: 'backup',
      ...(opts.secrets ? { secrets: opts.secrets } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
    });
    const rotated = await rotateBackups(opts.storage, dir, keep);
    return {
      path: result.path,
      scopes: result.scopes,
      fileCount: result.fileCount,
      bytes: result.bytes,
      rotated,
      skippedFiles: result.skippedFiles,
      ...(result.externalMemory ? { externalMemory: result.externalMemory } : {}),
    };
  } finally {
    release();
  }
}

/**
 * The line the cron tick persists to `~/.ethos/cron/output/backup/<ts>.md`.
 *
 * That file is the ONLY place a scheduled run is reported. The seeded `backup`
 * job carries no `origin`, so nothing is delivered to a channel, and the other
 * field a run can write — `lastError` — has no reader on any CLI surface:
 * `ethos status` reports the newest archive by mtime whatever its outcome, and
 * `ethos cron list` prints `lastRunAt` and not `lastError`. Its one reader
 * anywhere is `apps/web-api`'s backup service, which no CLI-only deployment
 * runs. A fact that is not in this string is a fact nobody ever sees.
 *
 * So skips lead, and they lead with the word that keeps the line below from
 * reading as an unqualified success. The run is NOT failed — an archive minus
 * one file is worth far more than no archive, and failing here would also cost
 * the rotation that already ran — but it is not clean either, and an operator
 * skimming this file must be able to tell those apart on the first line.
 *
 * A run with no skips returns exactly the sentence it always did.
 */
export function summarizeScheduledBackup(result: ScheduledBackupResult): string {
  const rotated =
    result.rotated.length > 0 ? `, rotated ${result.rotated.length} older archive(s)` : '';
  const written = `Backup written to ${result.path} (${result.fileCount} files, ${result.bytes} bytes, scopes: ${result.scopes.join('+')})${rotated}`;
  // Vault memory is not a skip — nothing tried to archive it — but it is the
  // same question an operator reads this file to answer: what is not in there.
  const external = result.externalMemory ? [`  ⚠ ${result.externalMemory.message}`] : [];
  if (result.skippedFiles.length === 0) {
    return external.length > 0 ? [written, ...external].join('\n') : written;
  }
  return [
    `Backup INCOMPLETE — ${result.skippedFiles.length} file(s) could not be archived and are NOT in it.`,
    written,
    ...result.skippedFiles.map((skip) => `  ⚠ ${skip.path} — ${skip.reason}`),
    ...external,
  ].join('\n');
}
