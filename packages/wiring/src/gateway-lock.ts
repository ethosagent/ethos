// The gateway singleton lock (plan reach-and-containment §2.7, D2-12).
//
// Two gateways on one state directory poll the same bot tokens (Telegram
// answers the second `getUpdates` with 409 Conflict and the two processes steal
// updates from each other), both sweep the delivery ledger, and both would
// reset each other's `processing` inbound-spool rows at boot. This lock makes
// "one gateway per state dir" a guarantee: `ethos gateway start` takes it
// before any store is opened or adapter constructed, and refuses — exit code
// {@link GATEWAY_LOCK_EXIT_CODE} — when a live gateway holds it.
//
// Per STATE DIR, not per machine: `<dataDir>/gateway.lock`, so two
// `ETHOS_STATE_DIR` profiles on one host run two gateways legitimately.
//
// No raw `node:fs` of its own. A third caller of `acquireSentinelLock`
// (packages/wiring/src/backup/sentinel-lock.ts, which holds the `node:fs`
// calls), beside `acquireBackupLock` and `acquireIdentityMapLock`; this file
// supplies only the lock's settings and its refusal text. Stale detection is
// that module's protocol: a dead pid, or a live pid recorded on a different
// Linux boot, is taken over; a live pid with no provable boot difference never
// is — off Linux a recycled pid leaves the lock for the operator, and the
// refusal says how to clear it.

import { join } from 'node:path';
import {
  acquireSentinelLock,
  inspectSentinelLock,
  type SentinelLockInspection,
} from './backup/sentinel-lock';

/** The exit code `ethos gateway start` uses when the lock is held. `ethos
 *  run-all` and the desktop app key on it: held is final, not a crash. */
export const GATEWAY_LOCK_EXIT_CODE = 3;

/** A body with no readable pid (truncated write, foreign file) is stale past this. */
const UNREADABLE_STALE_MS = 60_000;

export function gatewayLockPath(dataDir: string): string {
  return join(dataDir, 'gateway.lock');
}

export function gatewayLockRefusal(dataDir: string, holderPid: number | null): string {
  const holder = holderPid === null ? 'pid unknown' : `pid ${holderPid}`;
  return (
    `Another Ethos gateway is already running for ${dataDir} (${holder}). ` +
    "Stop that process, or check it with 'ethos gateway status'. " +
    `If no such process exists, remove ${gatewayLockPath(dataDir)}.`
  );
}

/** Thrown by {@link acquireGatewayLock} when a live gateway holds the lock. */
export class GatewayLockHeldError extends Error {
  readonly code = 'gateway_lock_held' as const;
  constructor(
    message: string,
    readonly holderPid: number | null,
    readonly lockPath: string,
  ) {
    super(message);
    this.name = 'GatewayLockHeldError';
  }
}

/**
 * Take `<dataDir>/gateway.lock`; resolves to its `release` (which deletes only
 * this process's own bytes). ONE attempt (`timeoutMs: 0`): a second gateway
 * that waited would start the moment the first died, which is a supervisor's
 * job, not the gateway's. A stale incumbent is still taken over on that one
 * attempt. Throws {@link GatewayLockHeldError} when refused; any other error
 * (an unwritable state dir) propagates as-is.
 */
export async function acquireGatewayLock(dataDir: string): Promise<() => void> {
  const lockPath = gatewayLockPath(dataDir);
  let refusedBy: number | null | undefined;
  try {
    return await acquireSentinelLock({
      lockPath,
      timeoutMs: 0,
      retryMs: 100,
      unreadableStaleMs: UNREADABLE_STALE_MS,
      refusal: (pid) => {
        refusedBy = pid;
        return gatewayLockRefusal(dataDir, pid);
      },
    });
  } catch (err) {
    if (refusedBy !== undefined) {
      throw new GatewayLockHeldError(
        err instanceof Error ? err.message : String(err),
        refusedBy,
        lockPath,
      );
    }
    throw err;
  }
}

/** Read the lock without taking it — `ethos gateway status`. Same stale rule
 *  as the acquire, so "stale" here means the next start takes it over. */
export function inspectGatewayLock(dataDir: string): SentinelLockInspection {
  return inspectSentinelLock(gatewayLockPath(dataDir), UNREADABLE_STALE_MS);
}

/** Re-exported for the gateway's spool claim identity (`pid:boot`). */
export { currentBootId } from './backup/holder-identity';
export type { SentinelLockInspection };
