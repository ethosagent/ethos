// `ethos sessions repair` engine: diagnose and repair `<dataDir>/sessions.db`.
//
// Returns report objects and prints nothing (the CLI renders them). Every
// diagnostic open is a raw `@ethosagent/sqlite` handle, never `SQLiteSessionStore`:
// diagnostics never migrate a store (apps/ethos/src/commands/__tests__/
// diagnostics-never-migrate.test.ts).
//
// - Check mode: `readonly` handle plus `PRAGMA query_only = ON`; writes nothing.
//   Pinned by __tests__/repair.test.ts ("check mode writes nothing").
// - `deep`: online-backup copy in a temp dir, `rank = 1` FTS check on the COPY,
//   copy deleted. Pinned by "deep leaves the live file untouched".
// - Apply: the exclusive gate (gate.ts) is the "is anything using the DB"
//   authority; it is held for the whole operation, so a late opener is refused
//   and there is no swap window. A verbatim pre-repair copy is taken through the
//   gate handle before any change.
//
// Raw `node:fs` (existsSync, statSync, mkdirSync, mkdtempSync, rmSync, statfsSync)
// is the documented packages/wiring carve-out. The pre-repair copy goes to
// `<dataDir>/.pre-repair/`, which no backup scope classifies
// (__tests__/repair.test.ts ".pre-repair is not classified into any backup scope").

import { existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  classifyIntegrity,
  deepCheckMessagesFts,
  type FtsProbe,
  type IntegrityClass,
  probeMessagesFts,
  rebuildMessagesFts,
  SESSIONS_DB_SCHEMA_VERSION,
} from '@ethosagent/session-sqlite';
import Database, { backup } from '@ethosagent/sqlite';
import { EthosError } from '@ethosagent/types';
import { acquireDatabaseLockGate, DatabaseInUseError } from './gate';
import { describeSessionsDbHolders } from './holders';

export type RepairAction = 'rebuild_fts' | 'reindex';

/** The apply stages `onProgress` is told about, in order. */
export type RepairStage = 'gate-acquired' | 'pre-repair-copy' | 'repaired' | 'verified';

export interface RowScan {
  badMetadata: number;
  badToolCalls: number;
  badContentBlocks: number;
  badTimestamps: number;
  /** First 10 ids per column; timestamps are `sessions:<id>` / `messages:<id>`. */
  sampleIds: {
    metadata: string[];
    toolCalls: string[];
    contentBlocks: string[];
    timestamps: string[];
  };
}

export interface AppliedRepair {
  actions: RepairAction[];
  /** The verbatim pre-repair copy, or null when no change was made. */
  copy: string | null;
  verified: boolean;
  durationMs: number;
  /** True for a heap/unknown class: nothing was changed, restore from a backup. */
  unrepairable?: true;
}

export interface SessionsDbReport {
  ok: boolean;
  database: 'sessions.db';
  path: string;
  /** False when there is no sessions.db yet; every other field is then empty. */
  exists: boolean;
  sizeBytes: number;
  classification: IntegrityClass;
  integrity: { ok: boolean; detail?: string };
  fts: {
    messages: number;
    indexedDocs: number;
    unindexed: number;
    dangling: number;
    deep: { ok: boolean; detail?: string } | null;
  };
  rows: RowScan;
  plan: RepairAction[];
  applied: AppliedRepair | null;
  /** Non-fatal notes (a check that could not run, a free-space probe that threw). */
  warnings: string[];
}

export interface StatfsResult {
  bavail: number;
  bsize: number;
}

export interface DiagnoseOptions {
  /** Run the authoritative `rank = 1` FTS check on a temp copy. */
  deep?: boolean;
  /** Test seam; defaults to `fs.statfsSync`. */
  statfs?: (path: string) => StatfsResult;
  /** Test seam for the deep-check copy; defaults to the online `backup`. */
  copyDb?: (db: Database.Database, dest: string) => Promise<unknown>;
}

export interface RepairOptions extends DiagnoseOptions {
  now?: () => Date;
  /** Awaited at each stage; the late-opener test starts its opener from here. */
  onProgress?: (stage: RepairStage) => void | Promise<void>;
  /** Test seam; defaults to `describeSessionsDbHolders`. */
  describeHolders?: (dataDir: string) => Promise<string[]>;
  /**
   * The findings of a `diagnoseSessionsDb` that just ran. When given, the
   * gate-time re-inspection reuses them instead of rescanning rows and making a
   * second deep temp copy; it still re-runs `integrity_check` and the FTS probe
   * under the gate, which is all the plan needs. Pinned by
   * `__tests__/repair.test.ts` ("apply reuses the prior row scan and deep check").
   */
  prior?: Pick<SessionsDbReport, 'rows'> & { deep: SessionsDbReport['fts']['deep'] };
}

const FREE_SPACE_FACTOR = 1.2;
const MAX_DETAIL_LINES = 10;
const SAMPLE_IDS = 10;

function sessionsDbPath(dataDir: string): string {
  return join(dataDir, 'sessions.db');
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0; // absent sidecar
  }
}

type RowCountKey = 'badMetadata' | 'badToolCalls' | 'badContentBlocks' | 'badTimestamps';
type RowSampleKey = keyof RowScan['sampleIds'];

/** One row of the scan table: a malformed-column predicate and where its count lands. */
interface RowCheck {
  table: 'sessions' | 'messages';
  count: RowCountKey;
  sample: RowSampleKey;
  /** Label in `rowsSummary`. */
  label: string;
  where: string;
  /** Sample-id prefix (timestamps span two tables). */
  prefix: string;
}

const ROW_CHECKS: readonly RowCheck[] = [
  {
    table: 'sessions',
    count: 'badMetadata',
    sample: 'metadata',
    label: 'metadata',
    where: 'metadata IS NOT NULL AND NOT json_valid(metadata)',
    prefix: '',
  },
  {
    table: 'messages',
    count: 'badToolCalls',
    sample: 'toolCalls',
    label: 'tool_calls',
    where: 'tool_calls IS NOT NULL AND NOT json_valid(tool_calls)',
    prefix: '',
  },
  {
    table: 'messages',
    count: 'badContentBlocks',
    sample: 'contentBlocks',
    label: 'content_blocks',
    where: 'content_blocks IS NOT NULL AND NOT json_valid(content_blocks)',
    prefix: '',
  },
  {
    table: 'sessions',
    count: 'badTimestamps',
    sample: 'timestamps',
    label: 'timestamps',
    where: 'julianday(created_at) IS NULL OR julianday(updated_at) IS NULL',
    prefix: 'sessions:',
  },
  {
    table: 'messages',
    count: 'badTimestamps',
    sample: 'timestamps',
    label: 'timestamps',
    where: 'julianday(timestamp) IS NULL',
    prefix: 'messages:',
  },
];

function emptyRows(): RowScan {
  return {
    badMetadata: 0,
    badToolCalls: 0,
    badContentBlocks: 0,
    badTimestamps: 0,
    sampleIds: { metadata: [], toolCalls: [], contentBlocks: [], timestamps: [] },
  };
}

/** `metadata 2 · timestamps 1`, or `none` when every count is 0. */
export function rowsSummary(rows: RowScan): string {
  const parts: string[] = [];
  const seen = new Set<RowCountKey>();
  for (const c of ROW_CHECKS) {
    if (seen.has(c.count)) continue;
    seen.add(c.count);
    if (rows[c.count] > 0) parts.push(`${c.label} ${rows[c.count]}`);
  }
  return parts.length === 0 ? 'none' : parts.join(' · ');
}

function emptyReport(dataDir: string): SessionsDbReport {
  return {
    ok: true,
    database: 'sessions.db',
    path: sessionsDbPath(dataDir),
    exists: false,
    sizeBytes: 0,
    classification: 'ok',
    integrity: { ok: true },
    fts: { messages: 0, indexedDocs: 0, unindexed: 0, dangling: 0, deep: null },
    rows: emptyRows(),
    plan: [],
    applied: null,
    warnings: [],
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `PRAGMA integrity_check` as one verdict string: rows joined, or the thrown message. */
export function integrityVerdict(db: Database.Database): string {
  try {
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join('\n');
  } catch (err) {
    return message(err);
  }
}

function trimDetail(verdict: string): string {
  const lines = verdict.split('\n');
  return lines.length <= MAX_DETAIL_LINES
    ? verdict
    : `${lines.slice(0, MAX_DETAIL_LINES).join('\n')}\n... (${lines.length - MAX_DETAIL_LINES} more)`;
}

/**
 * Read-only row scan (plan 6.3, F14): `json_valid` / `julianday` in SQL. One pass
 * over `sessions` and one over `messages` count every predicate with
 * `SUM(CASE ...)`; sample ids are fetched only for a predicate that matched.
 */
function scanRows(db: Database.Database): RowScan {
  const rows = emptyRows();
  for (const table of ['sessions', 'messages'] as const) {
    const checks = ROW_CHECKS.filter((c) => c.table === table);
    const select = checks
      .map((c, i) => `COALESCE(SUM(CASE WHEN ${c.where} THEN 1 ELSE 0 END), 0) AS c${i}`)
      .join(', ');
    const counts = db.prepare(`SELECT ${select} FROM ${table}`).get() as Record<string, number>;
    checks.forEach((c, i) => {
      const n = counts[`c${i}`] ?? 0;
      if (n === 0) return;
      rows[c.count] += n;
      const ids = db
        .prepare(`SELECT id FROM ${table} WHERE ${c.where} LIMIT ${SAMPLE_IDS}`)
        .all() as { id: string }[];
      rows.sampleIds[c.sample].push(...ids.map((r) => `${c.prefix}${r.id}`));
    });
  }
  rows.sampleIds.timestamps = rows.sampleIds.timestamps.slice(0, SAMPLE_IDS);
  return rows;
}

function freeBytes(statfs: (p: string) => StatfsResult, path: string): number {
  const s = statfs(path);
  return s.bavail * s.bsize;
}

/**
 * The authoritative FTS check on a COPY: `rank = 1` is an INSERT, so it cannot run
 * on a read-only live handle (F5). Returns `null` (plus a warning) when the copy
 * itself could not be made: only a completed check on a made copy may say `!ok`.
 * Pinned by __tests__/repair.test.ts ("a failed deep-check copy is not FTS damage").
 */
async function deepCheckOnCopy(
  db: Database.Database,
  dbSize: number,
  statfs: (p: string) => StatfsResult,
  warnings: string[],
  copyDb: (db: Database.Database, dest: string) => Promise<unknown>,
): Promise<{ ok: boolean; detail?: string } | null> {
  try {
    if (freeBytes(statfs, tmpdir()) < dbSize) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Not enough free space in ${tmpdir()} for a deep check (needs about ${dbSize} bytes)`,
        action: 'Free disk space, or run without --deep.',
        details: { dir: tmpdir(), neededBytes: dbSize },
      });
    }
  } catch (err) {
    if (err instanceof EthosError) throw err;
    warnings.push(`free-space check for --deep could not run: ${message(err)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'ethos-sessions-deep-'));
  try {
    const dest = join(dir, 'sessions.db');
    try {
      await copyDb(db, dest);
    } catch (err) {
      warnings.push(`deep check could not run: ${message(err)}`);
      return null;
    }
    const copy = new Database(dest);
    try {
      return deepCheckMessagesFts(copy);
    } finally {
      copy.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The findings on an open handle. Writes nothing (except into the deep temp copy). */
async function inspect(
  db: Database.Database,
  dbPath: string,
  opts: DiagnoseOptions,
  prior?: RepairOptions['prior'],
): Promise<SessionsDbReport> {
  const warnings: string[] = [];
  const statfs = opts.statfs ?? statfsSync;
  const sizeBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`);

  const verdict = integrityVerdict(db);
  const integrityOk = verdict.trim() === 'ok';
  let classification: IntegrityClass = integrityOk ? 'ok' : classifyIntegrity(verdict, db);

  let probe: FtsProbe = {
    messages: 0,
    indexedDocs: 0,
    unindexed: 0,
    dangling: 0,
    ftsPresent: false,
  };
  try {
    probe = probeMessagesFts(db);
  } catch (err) {
    warnings.push(`FTS probe could not run: ${message(err)}`);
  }

  let rows = prior?.rows ?? emptyRows();
  if (!prior) {
    try {
      rows = scanRows(db);
    } catch (err) {
      warnings.push(`row scan could not run: ${message(err)}`);
    }
  }

  let deep: { ok: boolean; detail?: string } | null = prior?.deep ?? null;
  if (!prior && opts.deep && probe.ftsPresent) {
    deep = await deepCheckOnCopy(db, sizeBytes, statfs, warnings, opts.copyDb ?? backup);
  }

  const drift = probe.unindexed + probe.dangling > 0;
  if (classification === 'ok' && probe.ftsPresent && (drift || (deep !== null && !deep.ok))) {
    classification = 'fts';
  }

  const plan: RepairAction[] = [];
  if (classification === 'fts') plan.push('rebuild_fts');
  if (classification === 'index') {
    plan.push('reindex');
    if (drift) plan.push('rebuild_fts');
  }

  const rowsClean = rowsSummary(rows) === 'none';
  return {
    ok: classification === 'ok' && rowsClean,
    database: 'sessions.db',
    path: dbPath,
    exists: true,
    sizeBytes,
    classification,
    integrity: integrityOk ? { ok: true } : { ok: false, detail: trimDetail(verdict) },
    fts: {
      messages: probe.messages,
      indexedDocs: probe.indexedDocs,
      unindexed: probe.unindexed,
      dangling: probe.dangling,
      deep,
    },
    rows,
    plan,
    applied: null,
    warnings,
  };
}

/** A file that could not even be opened: report it, never throw a raw SqliteError. */
function unopenableReport(dbPath: string, detail: string): SessionsDbReport {
  return {
    ...emptyReport(dirname(dbPath)),
    ok: false,
    exists: true,
    sizeBytes: fileSize(dbPath),
    classification: 'unknown',
    integrity: { ok: false, detail: trimDetail(detail) },
  };
}

/**
 * Check mode: findings and the plan `repairSessionsDb` would run. Opens the file
 * read-only with `query_only = ON`, never migrates, never takes a lock.
 */
export async function diagnoseSessionsDb(
  dataDir: string,
  opts: DiagnoseOptions = {},
): Promise<SessionsDbReport> {
  const dbPath = sessionsDbPath(dataDir);
  if (!existsSync(dbPath)) return emptyReport(dataDir);
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return unopenableReport(dbPath, message(err));
  }
  try {
    db.exec('PRAGMA query_only = ON');
    return await inspect(db, dbPath, opts);
  } finally {
    db.close();
  }
}

/** The refusal when the gate is held: names the holders (the gateway included) when known. */
async function busyError(
  dataDir: string,
  dbPath: string,
  err: DatabaseInUseError,
  describeHolders: (dir: string) => Promise<string[]>,
): Promise<EthosError> {
  let holders: string[] = [];
  try {
    holders = await describeHolders(dataDir);
  } catch {
    // naming holders is best effort and must never mask the refusal
    holders = [];
  }
  const named =
    holders.length > 0
      ? holders.join('; ')
      : 'another Ethos process (gateway, serve, chat, or the desktop app)';
  return new EthosError({
    code: 'DB_BUSY',
    cause: 'sessions.db is in use by another process, so it cannot be repaired',
    action:
      `Open now: ${named}. Stop them and retry. ` +
      'If the gateway runs under `ethos run-all`, stop that supervisor too (Ctrl-C it, or stop its service): ' +
      'run-all restarts a stopped gateway within seconds. A gateway under systemd or PM2 needs that unit stopped.',
    details: { path: dbPath, lockError: err.lockError, holders },
  });
}

/**
 * Apply the repair for the findings, or refuse. See the header for the guarantees.
 * Refuses with `DB_BUSY` (gate held), `IMPORT_NEWER_SCHEMA` (newer `user_version`) or
 * `INTERNAL` (too little free space / pre-repair copy failed) BEFORE changing
 * anything. Heap or unknown corruption changes nothing and returns
 * `applied.unrepairable`.
 */
export async function repairSessionsDb(
  dataDir: string,
  opts: RepairOptions = {},
): Promise<SessionsDbReport> {
  const started = Date.now();
  const dbPath = sessionsDbPath(dataDir);
  if (!existsSync(dbPath)) return emptyReport(dataDir);
  const progress = opts.onProgress ?? (() => undefined);
  const statfs = opts.statfs ?? statfsSync;

  let gate: Database.Database | null;
  try {
    gate = acquireDatabaseLockGate(dbPath);
  } catch (err) {
    if (err instanceof DatabaseInUseError) {
      throw await busyError(
        dataDir,
        dbPath,
        err,
        opts.describeHolders ?? describeSessionsDbHolders,
      );
    }
    // Not contention (NOTADB, CANTOPEN, ...): the file itself cannot be opened.
    throw new EthosError({
      code: 'DB_CORRUPT',
      cause: `sessions.db could not be opened for repair: ${message(err)}`,
      action: 'restore from a backup: ethos import <archive>',
      details: { path: dbPath },
    });
  }
  if (!gate) return emptyReport(dataDir);

  try {
    await progress('gate-acquired');

    const versionRows = gate.pragma('user_version') as { user_version: number }[];
    const version = versionRows[0]?.user_version ?? 0;
    if (version > SESSIONS_DB_SCHEMA_VERSION) {
      throw new EthosError({
        code: 'IMPORT_NEWER_SCHEMA',
        cause: `sessions.db: database user_version=${version} is newer than this build (${SESSIONS_DB_SCHEMA_VERSION}); refusing to repair it`,
        action: 'Upgrade Ethos to a build that understands this schema, then retry.',
        details: {
          store: 'session-sqlite',
          databaseVersion: version,
          codeVersion: SESSIONS_DB_SCHEMA_VERSION,
        },
      });
    }

    const report = await inspect(gate, dbPath, opts, opts.prior);
    const finish = (applied: AppliedRepair): SessionsDbReport => ({
      ...report,
      ok: applied.verified,
      applied,
    });
    const elapsed = () => Date.now() - started;

    if (report.classification === 'heap' || report.classification === 'unknown') {
      return finish({
        actions: [],
        copy: null,
        verified: false,
        durationMs: elapsed(),
        unrepairable: true,
      });
    }
    if (report.plan.length === 0) {
      return finish({ actions: [], copy: null, verified: true, durationMs: elapsed() });
    }

    // Free space: the verbatim copy needs about the DB size; refuse below 1.2x.
    try {
      const free = freeBytes(statfs, dataDir);
      if (free < report.sizeBytes * FREE_SPACE_FACTOR) {
        throw new EthosError({
          code: 'INTERNAL',
          cause: `Not enough free space for the pre-repair copy (${free} bytes free, need ${Math.ceil(report.sizeBytes * FREE_SPACE_FACTOR)})`,
          action: `Free disk space under ${dataDir} and retry. Nothing was changed.`,
          details: { dir: dataDir, freeBytes: free, dbBytes: report.sizeBytes },
        });
      }
    } catch (err) {
      if (err instanceof EthosError) throw err;
      report.warnings.push(`free-space check could not run: ${message(err)}`);
    }

    // Verbatim copy through the gate handle (a second connection would be locked out).
    const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    const root = join(dataDir, '.pre-repair');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const copyDir = mkdtempSync(join(root, `${stamp}-`));
    const copy = join(copyDir, 'sessions.db');
    try {
      await backup(gate, copy);
    } catch (err) {
      rmSync(copyDir, { recursive: true, force: true });
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Could not take the pre-repair copy of sessions.db: ${message(err)}`,
        action:
          'Nothing was changed. Check disk space and permissions under the state dir, then retry.',
        details: { dir: copyDir },
      });
    }
    await progress('pre-repair-copy');

    for (const action of report.plan) {
      if (action === 'reindex') gate.exec('REINDEX');
      else rebuildMessagesFts(gate);
    }
    await progress('repaired');

    const after = integrityVerdict(gate).trim() === 'ok';
    let clean = false;
    if (after) {
      const p = probeMessagesFts(gate);
      clean = p.unindexed + p.dangling === 0;
    }
    await progress('verified');
    return finish({
      actions: [...report.plan],
      copy,
      verified: after && clean,
      durationMs: elapsed(),
    });
  } finally {
    gate.close();
  }
}
