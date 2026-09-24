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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { type DeliveryStats, SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { type SpoolStats, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
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

async function readStoreStats(dir: string): Promise<Pick<GatewayStatus, 'spool' | 'ledger'>> {
  let spool: SpoolStats | null = null;
  let ledger: GatewayStatus['ledger'] = null;
  const spoolPath = join(dir, 'inbound-spool.db');
  if (existsSync(spoolPath)) {
    try {
      const s = new SQLiteInboundSpool(spoolPath);
      try {
        spool = s.stats();
      } finally {
        s.close();
      }
    } catch {
      spool = null;
    }
  }
  const ledgerPath = join(dir, 'delivery-ledger.db');
  if (existsSync(ledgerPath)) {
    try {
      const l = new SQLiteDeliveryLedger(ledgerPath);
      try {
        const { voice: _voice, ...counts } = await l.stats();
        ledger = counts;
      } finally {
        l.close();
      }
    } catch {
      ledger = null;
    }
  }
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
    if (status.spool && (status.spool.received > 0 || status.spool.dead > 0)) {
      console.log(
        `inbound spool: ${status.spool.received} owed, ${status.spool.processing} in progress, ${status.spool.dead} dead`,
      );
    }
  }
  return gatewayStatusExitCode(status.state);
}

const SPOOL_USAGE = 'Usage: ethos gateway spool <replay|discard> <id>';

/**
 * `ethos gateway spool replay <id>` — a dead row back to `received` with its
 * attempts reset; the running gateway's replay tick (or the next boot) runs it.
 * `ethos gateway spool discard <id>` — a dead row closed without a turn.
 * Returns the exit code.
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
  const spool = new SQLiteInboundSpool(path);
  try {
    const row = spool.get(id);
    if (!row) {
      console.error(`No spooled message ${id}.`);
      return 1;
    }
    if (row.status !== 'dead') {
      console.error(
        `Message ${id} is ${row.status}, not dead — only dead letters can be ${action}ed.`,
      );
      return 1;
    }
    if (action === 'replay') {
      spool.requeue(id);
      console.log(
        `Requeued ${id}. A running gateway replays it within a minute; otherwise on its next start.`,
      );
    } else {
      spool.discard(id);
      console.log(`Discarded ${id}.`);
    }
    return 0;
  } finally {
    spool.close();
  }
}
