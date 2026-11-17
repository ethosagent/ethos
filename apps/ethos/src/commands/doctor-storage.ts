// Raw `node:fs` for the same reasons `runDoctorFix` already reaches for
// `chmod`: Storage has no permissions API, and the integrity check hands a raw
// path to SQLite (the documented store carve-out in AGENTS.md). `statfsSync`
// likewise: Storage has no filesystem-type API (`checkStateDirFilesystem`).
import { existsSync, readdirSync, type StatsFs, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import type { FtsProbe, IntegrityClass } from '@ethosagent/wiring';
import { FTS_DOWN_CONSEQUENCE } from '../lib/sessions-db-advice';
import type { Storage } from './doctor-shared';

export interface DbCheckResult {
  /** false only when the DB exists but cannot be opened/queried. */
  ok: boolean;
  /** true when the file has not been created yet — a healthy fresh-install state. */
  absent: boolean;
  error?: string;
}

export async function checkSessionsDb(storage: Storage): Promise<DbCheckResult> {
  const dbPath = join(ethosDir(), 'sessions.db');
  if (!(await storage.exists(dbPath))) {
    return { ok: true, absent: true };
  }
  const { default: Database } = await import('@ethosagent/sqlite');
  let db: InstanceType<typeof Database> | undefined;
  try {
    // A raw open, never `SQLiteSessionStore`: that constructor runs `migrate()`,
    // and a NEWER binary's doctor migrating sessions.db is what leaves the
    // rolled-back binary unable to open it (`ethos upgrade`'s health gate runs
    // exactly that doctor — plan openclaw-9.5-adoption D24). Read-write for the
    // same reason as `checkDatabaseIntegrity` below; a SELECT writes nothing.
    // Pinned by __tests__/diagnostics-never-migrate.test.ts.
    db = new Database(dbPath);
    // Trivial query — exercises open + read path; surfaces WAL/corruption.
    db.prepare('SELECT 1 FROM sessions LIMIT 1').all();
    return { ok: true, absent: false };
  } catch (err) {
    return { ok: false, absent: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// Store integrity, vault permissions, skills/teams sanity (plan
// agent-state-backup §4)
// ---------------------------------------------------------------------------

export interface IntegrityResult {
  /** `dataDir`-relative database path. */
  database: string;
  status: 'ok' | 'absent' | 'failed';
  /** What `PRAGMA integrity_check` said, or why it could not be run. */
  detail?: string;
  /**
   * Set only for a failed `sessions.db`: which repair class the verdict is
   * (`classifyIntegrity`). `fts`/`index` are fixed by `ethos sessions repair`;
   * `heap`/`unknown` need a restore. Pinned by doctor-status-stores.test.ts.
   */
  kind?: Exclude<IntegrityClass, 'ok'>;
  /**
   * Set only for an `ok` `sessions.db` that has an FTS index: row-set drift
   * between `messages` and `messages_fts_docsize`, probed on the same handle as
   * the integrity check. A heuristic that NEVER changes `computeDoctorExit` (D4,
   * pinned by doctor-json.test.ts "exit stays 0 with drift > 0").
   */
  fts?: SessionsFtsDrift;
  /**
   * Set only for an `ok` `sessions.db` whose drift probe threw: the probe could
   * not run, so no drift verdict exists. Never affects `computeDoctorExit`.
   * Pinned by doctor-status-stores.test.ts ("a throwing drift probe is surfaced").
   */
  ftsProbeError?: string;
}

export type SessionsFtsDrift = Omit<FtsProbe, 'ftsPresent'>;

/** What one `WAL_STORES` pattern names on THIS machine. */
interface StoreExpansion {
  paths: string[];
  /** Set when the directory is there but could not be listed. Carries the errno. */
  error?: string;
}

/**
 * Expand one `WAL_STORES` location into the paths it names on THIS machine.
 * `*` matches one directory segment (`teams/*​/board.db`).
 *
 * A directory that is ABSENT expands to nothing — those stores do not exist
 * here, which is the truth. Any other failure is "I could not look", and
 * returning nothing for it would delete registered databases from the
 * integrity report and let `doctor` pass without having checked them. That
 * becomes a failed result instead, so it is printed and counts toward the exit.
 */
function expandStorePath(dataDir: string, pattern: string): StoreExpansion {
  const star = pattern.indexOf('*');
  if (star < 0) return { paths: [pattern] };
  const before = pattern.slice(0, star).replace(/\/$/, '');
  const after = pattern.slice(star + 1).replace(/^\//, '');
  const dir = join(dataDir, before);
  try {
    return {
      paths: readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${before}/${e.name}/${after}`)
        .sort(),
    };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown';
    if (code === 'ENOENT') return { paths: [] };
    return { paths: [], error: `cannot list ${before}/ (${code})` };
  }
}

/**
 * Run `PRAGMA integrity_check` over every database the repo declares.
 *
 * The list is `WAL_STORES` — the same registry the backup scope table is built
 * from and the drift gate holds to the repo — rather than a hardcoded name, so
 * a store added anywhere is covered here the moment it is classified. Excluded
 * stores (delivery-ledger, inbound-dedup, notify-queue) are checked too:
 * whether a database is worth backing up and whether it is corrupt are
 * different questions.
 */
export async function checkDatabaseIntegrity(dataDir: string): Promise<IntegrityResult[]> {
  const { WAL_STORES, classifyIntegrity, integrityVerdict, probeMessagesFts } = await import(
    '@ethosagent/wiring'
  );
  const { default: Database } = await import('@ethosagent/sqlite');

  const paths = new Set<string>();
  const unreadable: IntegrityResult[] = [];
  for (const store of WAL_STORES) {
    for (const pattern of [store.database, ...(store.alsoAt ?? [])]) {
      const expansion = expandStorePath(dataDir, pattern);
      for (const path of expansion.paths) paths.add(path);
      if (expansion.error !== undefined) {
        unreadable.push({ database: pattern, status: 'failed', detail: expansion.error });
      }
    }
  }

  const out: IntegrityResult[] = [...unreadable];
  for (const rel of [...paths].sort()) {
    const full = join(dataDir, rel);
    if (!existsSync(full)) {
      out.push({ database: rel, status: 'absent' });
      continue;
    }
    let db: InstanceType<typeof Database> | undefined;
    try {
      // Opened read-WRITE on purpose. A read-only open of a WAL database whose
      // `-shm` index is absent cannot create one and fails outright, which
      // would report a healthy store as corrupt. `integrity_check` itself
      // writes nothing.
      db = new Database(full);
      const handle = db;
      const verdict = integrityVerdict(handle);
      if (verdict.trim() === 'ok') {
        let drift: DriftProbe | undefined;
        if (rel === 'sessions.db') {
          // Plan D6: the probe is read-only SQL; query_only makes that a guarantee.
          // Set after integrity_check, on a handle that closes right after.
          handle.exec('PRAGMA query_only = ON');
          drift = driftOf(() => probeMessagesFts(handle));
        }
        out.push({
          database: rel,
          status: 'ok',
          ...(drift?.fts ? { fts: drift.fts } : {}),
          ...(drift?.error ? { ftsProbeError: drift.error } : {}),
        });
      } else {
        const result: IntegrityResult = {
          database: rel,
          status: 'failed',
          detail: verdict.split('\n')[0] || 'no result',
        };
        if (rel === 'sessions.db') {
          const kind = classifyIntegrity(verdict, handle);
          if (kind !== 'ok') result.kind = kind;
        }
        out.push(result);
      }
    } catch (err) {
      out.push({
        database: rel,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        ...(rel === 'sessions.db' ? { kind: 'unknown' as const } : {}),
      });
    } finally {
      db?.close();
    }
  }
  return out;
}

/**
 * FTS drift from a probe on the already-open `sessions.db` handle: undefined when there is
 * no FTS table, `{ error }` when the probe threw (surfaced, never swallowed). Read-only SQL on the caller's raw handle, never
 * `SQLiteSessionStore`, so it cannot migrate or write (pinned by
 * diagnostics-never-migrate.test.ts).
 */
function driftOf(probe: () => FtsProbe): DriftProbe | undefined {
  try {
    const p = probe();
    if (!p.ftsPresent) return undefined;
    return {
      fts: {
        messages: p.messages,
        indexedDocs: p.indexedDocs,
        unindexed: p.unindexed,
        dangling: p.dangling,
      },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

interface DriftProbe {
  fts?: SessionsFtsDrift;
  error?: string;
}

/** The `sessions.db` FTS drift carried by a `checkDatabaseIntegrity` result, or null. */
export function sessionsFtsOf(results: readonly IntegrityResult[]): SessionsFtsDrift | null {
  return results.find((r) => r.database === 'sessions.db')?.fts ?? null;
}

/**
 * The advice lines under a failed store-integrity check: `ethos sessions repair`
 * for an fts/index class, a backup restore for anything else. Pure; pinned by
 * doctor-status-stores.test.ts ("integrityAdvice ...").
 */
export function integrityAdvice(results: readonly IntegrityResult[]): string[] {
  const broken = results.filter((r) => r.status === 'failed');
  const repairable = broken.filter((r) => r.kind === 'fts' || r.kind === 'index');
  const lines: string[] = [];
  if (repairable.some((r) => r.kind === 'fts')) lines.push(FTS_DOWN_CONSEQUENCE);
  if (repairable.length > 0) {
    lines.push('Run `ethos sessions repair --apply` (a verbatim copy is taken first)');
  }
  if (broken.some((r) => !repairable.includes(r))) {
    lines.push('Restore from a backup: `ethos import <archive>`');
  }
  return lines;
}

export interface VaultModeResult {
  path: string;
  present: boolean;
  /** Octal permission bits, e.g. `'700'`. Absent when the directory is not there. */
  mode?: string;
  /** True when group or other hold ANY bit on the vault directory. */
  tooOpen: boolean;
}

/**
 * `~/.ethos/secrets/` holds credential files; nothing but the owner may reach
 * it. `FileSecretsResolver` already chmods the directory to 0700 on every
 * `set`, so anything else here was done to it from outside.
 *
 * The test is "group or other hold any bit", not "the mode is exactly 0700" —
 * 0500 is tighter, not looser, and calling it a failure would be wrong.
 */
/**
 * The one sentence `doctor` says about the vault's mode. Exported for the same
 * reason `computeDoctorExit` is: the claim is the thing under test.
 *
 * It prints the mode that was READ. The line this replaces printed a constant
 * `0700` for every mode that passed, which is a false statement about the
 * tighter ones the check deliberately accepts.
 */
export function describeSecretsDirMode(result: VaultModeResult): string {
  if (!result.present) return 'secrets/ not created yet.';
  return result.tooOpen
    ? `secrets/ is mode ${result.mode}, not owner-only`
    : `secrets/ is mode ${result.mode} (owner only)`;
}

export function checkSecretsDirMode(dataDir: string): VaultModeResult {
  const path = join(dataDir, 'secrets');
  if (!existsSync(path)) return { path, present: false, tooOpen: false };
  const mode = statSync(path).mode & 0o777;
  return {
    path,
    present: true,
    mode: mode.toString(8).padStart(3, '0'),
    tooOpen: (mode & 0o077) !== 0,
  };
}

/**
 * Linux `statfs(2)` `f_type` magic numbers (linux/magic.h, fs/smb/client) for
 * the filesystems SQLite's WAL locking is not safe on. virtiofs and Docker
 * Desktop's gRPC-FUSE both mount through the FUSE superblock and so report
 * FUSE_SUPER_MAGIC; Docker Desktop on Windows and WSL2's `/mnt/c` are 9p.
 */
const UNSAFE_STATE_FS: ReadonlyMap<number, string> = new Map([
  [0x65735546, 'fuse'],
  [0x01021997, '9p'],
  [0x6969, 'nfs'],
  [0x517b, 'smb'],
  [0xff534d42, 'cifs'],
  [0xfe534d42, 'smb2'],
]);

export interface StateDirFilesystemResult {
  path: string;
  /** `unknown` = this platform's statfs gives no filesystem identity to test. */
  status: 'ok' | 'warn' | 'unknown' | 'absent';
  /** Name of the unsafe filesystem, set only on `warn`. */
  fsType?: string;
  message: string;
}

/**
 * Warns when the state directory sits on a FUSE or network filesystem, where
 * SQLite's locking can corrupt the databases (R4). Only Linux is classified:
 * Node's `statfs` exposes `f_type` and no filesystem name, and on macOS that
 * field is `vfc_typenum`, a registration-order number with no stable meaning
 * (APFS reads 0x1a on one machine and could read otherwise on another). The
 * case this exists for — a container on Docker Desktop — is Linux inside.
 */
export function checkStateDirFilesystem(
  dataDir: string,
  deps: { statfs?: (path: string) => StatsFs; platform?: NodeJS.Platform } = {},
): StateDirFilesystemResult {
  const statfs = deps.statfs ?? statfsSync;
  const platform = deps.platform ?? process.platform;
  let type: number;
  try {
    type = statfs(dataDir).type >>> 0;
  } catch {
    return { path: dataDir, status: 'absent', message: 'state directory not created yet.' };
  }
  if (platform !== 'linux') {
    return {
      path: dataDir,
      status: 'unknown',
      message: `filesystem type not checked on ${platform} (statfs reports no filesystem name).`,
    };
  }
  const fsType = UNSAFE_STATE_FS.get(type);
  if (!fsType) {
    return { path: dataDir, status: 'ok', message: 'state directory is on a local filesystem.' };
  }
  return {
    path: dataDir,
    status: 'warn',
    fsType,
    message: `state directory is on ${fsType} — SQLite locking is unsafe there and the databases can corrupt. Use a Docker named volume or a local disk.`,
  };
}

export interface DirSanityIssue {
  /** `dataDir`-relative path the issue is about. */
  path: string;
  message: string;
}

/**
 * `skills/<id>/SKILL.md`, or `skills/<scope>/<slug>/SKILL.md` — the two layouts
 * `UniversalScanner` reads. A directory matching neither is a skill that will
 * never load, which is worth saying before the user wonders why.
 */
export function checkSkillsDir(dataDir: string): DirSanityIssue[] {
  const root = join(dataDir, 'skills');
  if (!existsSync(root)) return [];
  const issues: DirSanityIssue[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    if (existsSync(join(dir, 'SKILL.md'))) continue;
    const nested = readdirSync(dir, { withFileTypes: true }).some(
      (sub) => sub.isDirectory() && existsSync(join(dir, sub.name, 'SKILL.md')),
    );
    if (!nested) {
      issues.push({
        path: `skills/${entry.name}`,
        message: `no SKILL.md in skills/${entry.name}/ or any subdirectory — this skill will not load`,
      });
    }
  }
  return issues;
}

/**
 * A team's data lives at `teams/<name>/`, its manifest at `teams/<name>.yaml`.
 * A data directory with no manifest is a team nothing can start.
 */
export function checkTeamsDir(dataDir: string): DirSanityIssue[] {
  const root = join(dataDir, 'teams');
  if (!existsSync(root)) return [];
  const issues: DirSanityIssue[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (existsSync(join(root, `${entry.name}.yaml`))) continue;
    issues.push({
      path: `teams/${entry.name}`,
      message: `teams/${entry.name}/ has no teams/${entry.name}.yaml manifest — this team cannot start`,
    });
  }
  return issues;
}
