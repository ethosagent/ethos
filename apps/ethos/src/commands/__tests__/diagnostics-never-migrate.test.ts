// Diagnostics never migrate a store (plan openclaw-9.5-adoption D24).
//
// `ethos upgrade` runs the NEW binary's `ethos doctor --json` as its health
// gate and rolls back to the old binary on a regression. If that doctor — or a
// `gateway status` an operator runs while deciding — migrated a store, the
// rolled-back binary would meet a `user_version` newer than its code and
// `migrate()`'s downgrade guard (packages/sqlite/src/migrate.ts) would refuse to
// open it. So every open on these surfaces is raw and read-only in effect.
//
// Two kinds of test:
//   1. Behavioural: an old-schema fixture keeps its `user_version` AND its table
//      set (a migration's baseline would create the missing tables) after each
//      surface runs; a newer-schema fixture is read, not refused.
//   2. Structural guard: doctor.ts and gateway-status.ts may not construct any
//      class whose module runs a `user_version` migration. The class list is
//      DERIVED by scanning the workspace, not hand-kept, so a store added later
//      is covered the day it lands.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { INBOUND_SPOOL_SCHEMA_VERSION, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import Database from '@ethosagent/sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkInboundSpool, checkSessionsDb, runFunnelReport } from '../doctor';
import { readGatewayStatus, runGatewaySpool } from '../gateway-status';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

let dir: string;
let prevStateDir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diag-no-migrate-'));
  prevStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = prevStateDir;
  rmSync(dir, { recursive: true, force: true });
});

interface Shape {
  version: number;
  tables: string[];
}

function shape(path: string): Shape {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.pragma('user_version') as Array<{ user_version: number }>;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    return { version: rows[0]?.user_version ?? 0, tables: tables.map((t) => t.name) };
  } finally {
    db.close();
  }
}

function setVersion(path: string, version: number): void {
  const db = new Database(path);
  db.pragma(`user_version = ${version}`);
  db.close();
}

/** A sessions.db holding only the `sessions` table at `user_version` 0: the
 *  store's migration would create `messages` et al. and stamp a version. */
function oldSessionsDb(): string {
  const path = join(dir, 'sessions.db');
  const db = new Database(path);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  db.close();
  return path;
}

/** A real spool file walked back to `user_version` 0: `migrate()` would re-stamp it. */
function oldSpool(): string {
  const path = join(dir, 'inbound-spool.db');
  new SQLiteInboundSpool(path).close();
  setVersion(path, 0);
  return path;
}

/** A spool with the v1 table (no `tool_started_at` / `kind` / `review_job_id`)
 *  at `user_version` 1, holding one dead row: what a gateway from before
 *  schema v2 leaves behind. The v2 migration would add the three columns. */
function v1Spool(): string {
  const path = join(dir, 'inbound-spool.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE inbound_spool (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, bot_key TEXT NOT NULL, chat_id TEXT NOT NULL,
    thread_id TEXT, message_id TEXT NOT NULL, lane_key TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_by TEXT,
    UNIQUE (platform, bot_key, chat_id, message_id)
  ) STRICT`);
  db.prepare(
    `INSERT INTO inbound_spool (id, platform, bot_key, chat_id, message_id, lane_key, payload,
     status, attempts, last_error, received_at, updated_at)
     VALUES ('d1', 'telegram', 'bot-a', 'c', 'm', 'l', '{}', 'dead', 3, 'boom', 1, 1)`,
  ).run();
  db.pragma('user_version = 1');
  db.close();
  return path;
}

/** A spool with the v2 table (no `absorbed_into`) at `user_version` 2, holding
 *  one dead row: what a gateway from before schema v3 leaves behind. The v3
 *  migration would add the column, and `requeueSpoolDead` now writes it. */
function v2Spool(): string {
  const path = join(dir, 'inbound-spool.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE inbound_spool (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, bot_key TEXT NOT NULL, chat_id TEXT NOT NULL,
    thread_id TEXT, message_id TEXT NOT NULL, lane_key TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_by TEXT,
    tool_started_at INTEGER, kind TEXT NOT NULL DEFAULT 'inbound', review_job_id TEXT,
    UNIQUE (platform, bot_key, chat_id, message_id)
  ) STRICT`);
  db.prepare(
    `INSERT INTO inbound_spool (id, platform, bot_key, chat_id, message_id, lane_key, payload,
     status, attempts, last_error, received_at, updated_at)
     VALUES ('d2', 'telegram', 'bot-a', 'c', 'm', 'l', '{}', 'dead', 3, 'boom', 1, 1)`,
  ).run();
  db.pragma('user_version = 2');
  db.close();
  return path;
}

function columns(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.pragma('table_info(inbound_spool)') as Array<{ name: string }>).map((c) => c.name);
  } finally {
    db.close();
  }
}

/** A real ledger file walked back to `user_version` 0: `migrate()` would re-stamp it. */
function oldLedger(): string {
  const path = join(dir, 'delivery-ledger.db');
  new SQLiteDeliveryLedger(path).close();
  setVersion(path, 0);
  return path;
}

describe('ethos doctor — sessions.db', () => {
  it('leaves an old-schema file exactly as it found it', async () => {
    const path = oldSessionsDb();
    const before = shape(path);
    const result = await checkSessionsDb(new FsStorage());
    expect(result).toEqual({ ok: true, absent: false });
    expect(shape(path)).toEqual(before);
  });

  it('reads a newer-schema file instead of refusing it', async () => {
    const path = oldSessionsDb();
    setVersion(path, 99);
    expect(await checkSessionsDb(new FsStorage())).toEqual({ ok: true, absent: false });
    expect(shape(path).version).toBe(99);
  });
});

describe('ethos doctor — inbound spool', () => {
  it('leaves an old-schema file exactly as it found it', async () => {
    const path = oldSpool();
    const before = shape(path);
    const report = await checkInboundSpool(dir, ['bot-a']);
    expect(report.status).toBe('ok');
    expect(shape(path)).toEqual(before);
  });

  it('reads a v1 spool (before interrupted/kind columns) without adding them', async () => {
    const path = v1Spool();
    const before = { shape: shape(path), columns: columns(path) };
    const report = await checkInboundSpool(dir, ['bot-a']);
    expect(report.status).toBe('ok');
    expect(report.counts).toMatchObject({ dead: 1, interrupted: 0 });
    expect(report.dead?.map((r) => r.id)).toEqual(['d1']);
    expect(report.interrupted).toEqual([]);
    expect({ shape: shape(path), columns: columns(path) }).toEqual(before);
  });

  it('reads a newer-schema file instead of refusing it', async () => {
    const path = oldSpool();
    setVersion(path, 99);
    expect((await checkInboundSpool(dir, ['bot-a'])).status).toBe('ok');
    expect(shape(path).version).toBe(99);
  });
});

describe('ethos doctor --funnel', () => {
  it('does not open observability.db', async () => {
    const path = join(dir, 'observability.db');
    const db = new Database(path);
    db.exec('CREATE TABLE placeholder (a TEXT)');
    db.close();
    const before = shape(path);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runFunnelReport(true);
    expect(shape(path)).toEqual(before);
  });
});

describe('ethos gateway status', () => {
  it('leaves old-schema spool and ledger files exactly as it found them', async () => {
    const spool = oldSpool();
    const ledger = oldLedger();
    const beforeSpool = shape(spool);
    const beforeLedger = shape(ledger);
    const status = await readGatewayStatus(dir);
    expect(status.spool).toEqual({ received: 0, processing: 0, done: 0, dead: 0, interrupted: 0 });
    expect(status.ledger).toEqual({ pending: 0, redelivering: 0, delivered: 0, abandoned: 0 });
    expect(shape(spool)).toEqual(beforeSpool);
    expect(shape(ledger)).toEqual(beforeLedger);
  });

  it('reads newer-schema files instead of refusing them', async () => {
    setVersion(oldSpool(), 99);
    setVersion(oldLedger(), 99);
    const status = await readGatewayStatus(dir);
    expect(status.spool).not.toBeNull();
    expect(status.ledger).not.toBeNull();
  });
});

describe('ethos gateway spool', () => {
  it('refuses to write into a spool at another schema version, and leaves it alone', () => {
    const path = oldSpool();
    const before = shape(path);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runGatewaySpool(['replay', 'some-id'], dir)).toBe(1);
    expect(shape(path)).toEqual(before);
  });

  it('refuses a v1 spool rather than writing v2 columns into it', () => {
    const path = v1Spool();
    const before = { shape: shape(path), columns: columns(path) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runGatewaySpool(['replay', 'd1'], dir)).toBe(1);
    expect({ shape: shape(path), columns: columns(path) }).toEqual(before);
  });

  it('refuses a v2 spool rather than writing v3 columns into it, and still reads it', async () => {
    const path = v2Spool();
    const before = { shape: shape(path), columns: columns(path) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runGatewaySpool(['replay', 'd2'], dir)).toBe(1);
    expect(runGatewaySpool(['discard', 'd2'], dir)).toBe(1);
    expect((await readGatewayStatus(dir)).spool?.dead).toBe(1);
    expect({ shape: shape(path), columns: columns(path) }).toEqual(before);
  });

  it('writes a spool at its own schema version without migrating it', () => {
    const path = join(dir, 'inbound-spool.db');
    const spool = new SQLiteInboundSpool(path);
    const { id } = spool.accept({
      platform: 'telegram',
      botKey: 'bot-a',
      chatId: 'c',
      messageId: 'm',
      laneKey: 'telegram:bot-a:c',
      payload: '{}',
    });
    spool.markDead(id, 'stale');
    spool.close();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runGatewaySpool(['replay', id], dir)).toBe(0);
    expect(shape(path).version).toBe(INBOUND_SPOOL_SCHEMA_VERSION);
    const reopened = new SQLiteInboundSpool(path);
    expect(reopened.get(id)?.status).toBe('received');
    reopened.close();
  });
});

// ---------------------------------------------------------------------------
// Structural guard
// ---------------------------------------------------------------------------

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
    const full = join(root, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Every exported class in a module that stamps or migrates `user_version`,
 *  across extensions/ and packages/ (the shim itself excluded). */
function migratingClasses(): Map<string, string> {
  const found = new Map<string, string>();
  for (const top of ['extensions', 'packages']) {
    for (const pkg of readdirSync(join(REPO_ROOT, top))) {
      const src = join(REPO_ROOT, top, pkg, 'src');
      if (pkg === 'sqlite' || !statSync(join(REPO_ROOT, top, pkg)).isDirectory()) continue;
      let files: string[];
      try {
        files = sourceFiles(src);
      } catch {
        continue;
      }
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const migrates =
          /import[^;]*\bmigrate\b[^;]*from '@ethosagent\/sqlite'/.test(text) ||
          /user_version\s*=/.test(text);
        if (!migrates) continue;
        for (const m of text.matchAll(/export class (\w+)/g)) {
          const name = m[1];
          if (name) found.set(name, relative(REPO_ROOT, file));
        }
      }
    }
  }
  return found;
}

/** Source with comments removed, so prose that NAMES a class ("never
 *  `SQLiteSessionStore`") is not read as a use of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Wiring accessors that construct a migrating store behind the call. */
const INDIRECT_OPENERS = [
  'getFunnelTracker',
  'getObservabilityService',
  'getEthosObservability',
  'getObservabilityStore',
];

describe('diagnostic surfaces never construct a migrating store', () => {
  const classes = migratingClasses();

  it('finds the migrating stores (the scan itself is not vacuous)', () => {
    for (const known of [
      'SQLiteSessionStore',
      'SQLiteInboundSpool',
      'SQLiteDeliveryLedger',
      'SQLiteObservabilityStore',
      'SQLiteJobStore',
    ]) {
      expect(classes.has(known), known).toBe(true);
    }
  });

  for (const surface of ['doctor.ts', 'gateway-status.ts']) {
    it(`${surface} references none of them`, () => {
      const text = code(readFileSync(join(import.meta.dirname, '..', surface), 'utf-8'));
      const hits = [...classes.keys(), ...INDIRECT_OPENERS].filter((name) =>
        new RegExp(`\\b${name}\\b`).test(text),
      );
      expect(hits).toEqual([]);
    });
  }
});
