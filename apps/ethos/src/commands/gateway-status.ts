// `ethos gateway status [--json]` and `ethos gateway spool replay|discard <id>`
// (plan reach-and-containment §2.6, §2.7).
//
// Kept out of commands/gateway.ts on purpose: these read two lock/heartbeat
// files and two SQLite stores, and must not import `@ethosagent/gateway`
// (daemon-free-smoke.test.ts). The desktop app shells out to `status --json`
// with a 2s timeout.
//
// Raw `node:fs` here is the app-layer composition-root allowance (apps/ is not
// in the no-raw-fs scan): an existence probe so a status read never CREATES an
// empty database, and a read of the heartbeat file.
//
// Neither store is opened through its class: both constructors run `migrate()`,
// and a newer binary migrating a store ahead of its gateway is what makes
// `ethos upgrade`'s rollback unsafe (plan openclaw-9.5-adoption D24). Each file
// is opened raw and read (or, for `spool`, written) through the package's
// handle-taking helpers. Pinned by __tests__/diagnostics-never-migrate.test.ts.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { type DeliveryStats, readDeliveryStats } from '@ethosagent/delivery-ledger';
import {
  discardSpoolDead,
  INBOUND_SPOOL_SCHEMA_VERSION,
  readSpoolRow,
  readSpoolStats,
  requeueSpoolDead,
  type SpoolStats,
} from '@ethosagent/inbound-spool';
import Database from '@ethosagent/sqlite';
import {
  gatewayLockPath,
  inspectGatewayLock,
  type SentinelLockInspection,
} from '@ethosagent/wiring';

/** A heartbeat older than this, from a live lock holder, reads as unhealthy.
 *  The gateway writes one every 10s; the desktop used the same 30s window. */
export const HEARTBEAT_FRESH_MS = 30_000;

export type GatewayState = 'running' | 'stale' | 'unhealthy' | 'stopped';

export interface GatewayStatus {
  state: GatewayState;
  pid: number | null;
  heartbeatAgeMs: number | null;
  lockPath: string;
  spool: SpoolStats | null;
  ledger: Omit<DeliveryStats, 'voice'> | null;
}

/** Exit code per state: 0 running, 1 stopped or stale, 2 unhealthy. */
export function gatewayStatusExitCode(state: GatewayState): number {
  if (state === 'running') return 0;
  if (state === 'unhealthy') return 2;
  return 1;
}

/**
 * Classify from the lock (who holds it, and whether the next start would take
 * it over — `inspectGatewayLock` uses the acquire's own stale rule) and the
 * heartbeat's age. The lock answers "is there one"; the heartbeat answers "is
 * it healthy".
 */
export function classifyGatewayStatus(
  lock: SentinelLockInspection,
  heartbeat: { updatedAt?: string } | null,
  now: number,
): { state: GatewayState; pid: number | null; heartbeatAgeMs: number | null } {
  if (lock.holder === 'none') return { state: 'stopped', pid: null, heartbeatAgeMs: null };
  const updated = heartbeat?.updatedAt ? Date.parse(heartbeat.updatedAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(updated) ? Math.max(0, now - updated) : null;
  if (lock.holder === 'stale') return { state: 'stale', pid: lock.pid, heartbeatAgeMs };
  const healthy = heartbeatAgeMs !== null && heartbeatAgeMs <= HEARTBEAT_FRESH_MS;
  return { state: healthy ? 'running' : 'unhealthy', pid: lock.pid, heartbeatAgeMs };
}

export function formatGatewayStatus(s: GatewayStatus): string {
  const pid = s.pid === null ? 'unknown' : String(s.pid);
  const age = s.heartbeatAgeMs === null ? null : Math.round(s.heartbeatAgeMs / 1000);
  switch (s.state) {
    case 'running':
      return `running (pid ${pid}, heartbeat ${age}s ago)`;
    case 'stale':
      return `stale lock (pid ${pid} not running) — next start will take it over`;
    case 'unhealthy':
      return age === null
        ? `unhealthy (pid ${pid} alive, no heartbeat)`
        : `unhealthy (pid ${pid} alive, heartbeat ${age}s old)`;
    case 'stopped':
      return 'stopped';
  }
}

function readHeartbeat(dir: string): { updatedAt?: string } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'gateway-health.json'), 'utf-8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { updatedAt?: string })
      : null;
  } catch {
    return null;
  }
}

/** Open `path` raw (no migration), run `read`, close. `null` when the file is
 *  absent or the read throws — an unreadable store is reported as no counts. */
function readRaw<T>(path: string, read: (db: Database.Database) => T): T | null {
  if (!existsSync(path)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(path);
    return read(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function readStoreStats(dir: string): Promise<Pick<GatewayStatus, 'spool' | 'ledger'>> {
  const spool = readRaw(join(dir, 'inbound-spool.db'), readSpoolStats);
  const ledger = readRaw(join(dir, 'delivery-ledger.db'), (db) => {
    const { voice: _voice, ...counts } = readDeliveryStats(db);
    return counts;
  });
  return { spool, ledger };
}

export async function readGatewayStatus(
  dir = ethosDir(),
  now = Date.now(),
): Promise<GatewayStatus> {
  const classified = classifyGatewayStatus(inspectGatewayLock(dir), readHeartbeat(dir), now);
  return { ...classified, lockPath: gatewayLockPath(dir), ...(await readStoreStats(dir)) };
}

/** `ethos gateway status [--json]`. Returns the exit code. */
export async function runGatewayStatus(args: readonly string[], dir = ethosDir()): Promise<number> {
  const status = await readGatewayStatus(dir);
  if (args.includes('--json')) {
    console.log(JSON.stringify(status));
  } else {
    console.log(formatGatewayStatus(status));
    const spool = status.spool;
    if (spool && (spool.received > 0 || spool.dead > 0 || spool.interrupted > 0)) {
      console.log(
        `inbound spool: ${spool.received} owed, ${spool.processing} in progress, ${spool.dead} dead, ${spool.interrupted} interrupted`,
      );
    }
  }
  return gatewayStatusExitCode(status.state);
}

const SPOOL_USAGE = 'Usage: ethos gateway spool <replay|discard> <id>';

/**
 * `ethos gateway spool replay <id>` — a dead or interrupted row back to
 * `received` with its attempts reset; the running gateway's replay tick (or the
 * next boot) runs it. For an interrupted row — cut after a tool had started
 * (plan openclaw-9.5-adoption D5) — that re-runs the turn, tools included: the
 * operator's explicit decision, the same one the user's `retry` makes.
 * `ethos gateway spool discard <id>` — a dead or interrupted row closed without
 * a turn. Returns the exit code.
 */
export function runGatewaySpool(args: readonly string[], dir = ethosDir()): number {
  const [action, id] = args;
  if ((action !== 'replay' && action !== 'discard') || !id) {
    console.log(SPOOL_USAGE);
    return 1;
  }
  const path = join(dir, 'inbound-spool.db');
  if (!existsSync(path)) {
    console.error(`No inbound spool at ${path}.`);
    return 1;
  }
  // Raw open: this writes, but must not migrate either — an operator running a
  // newer binary's `spool replay` before restarting the gateway would otherwise
  // bump the file past the version the running gateway (and a rollback) can
  // open. Instead, a file at any version other than the one these queries were
  // written for is refused rather than written into.
  const spool = new Database(path);
  try {
    spool.pragma('busy_timeout = 5000');
    const rows = spool.pragma('user_version') as Array<{ user_version: number }>;
    const version = rows[0]?.user_version ?? 0;
    if (version !== INBOUND_SPOOL_SCHEMA_VERSION) {
      console.error(
        `inbound-spool.db is at schema version ${version}; this ethos writes version ${INBOUND_SPOOL_SCHEMA_VERSION}. Run the ethos version that matches your gateway.`,
      );
      return 1;
    }
    const row = readSpoolRow(spool, id);
    if (!row) {
      console.error(`No spooled message ${id}.`);
      return 1;
    }
    if (row.status !== 'dead' && row.status !== 'interrupted') {
      console.error(
        `Message ${id} is ${row.status} — only dead or interrupted messages can be ${action}ed.`,
      );
      return 1;
    }
    if (action === 'replay') {
      requeueSpoolDead(spool, id, Date.now());
      console.log(
        `Requeued ${id}. A running gateway replays it within a minute; otherwise on its next start.`,
      );
    } else {
      discardSpoolDead(spool, id, Date.now());
      console.log(`Discarded ${id}.`);
    }
    return 0;
  } finally {
    spool.close();
  }
}
