// The gateway singleton lock and the inbound spool, as ONE setup shared by the
// two commands that own platform adapters: `ethos gateway start`
// (commands/gateway.ts) and `ethos boot` (commands/boot.ts).
//
// Plan reach-and-containment §2.2–§2.7. The two halves belong together: the
// spool's boot-time orphan recovery resets `processing` rows to `received`,
// which is safe only because the lock guarantees no other process on this
// state dir is running them. So a command that opens the spool must take the
// lock first — which is why both live here rather than inline in each command.
// `ethos serve` owns no adapters and takes neither (D2-15).

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { type InboundSpool, SQLiteInboundSpool } from '@ethosagent/inbound-spool';
import {
  acquireGatewayLock,
  currentBootId,
  GATEWAY_LOCK_EXIT_CODE,
  GatewayLockHeldError,
} from '@ethosagent/wiring';

// Structural shapes, not imports: only `commands/gateway.ts` may import
// `@ethosagent/gateway` (daemon-free doctrine, `__tests__/daemon-free-smoke.test.ts`).
// Each mirrors the Gateway member it names; `buildGateway`'s typecheck is what
// catches a drift.

/** `GatewayConfig['inboundSpoolOptions']` — the subset this module sets. */
export interface InboundSpoolGatewayOptions {
  maxAttempts?: number;
  maxReplayAgeMs?: number;
  owner?: string;
}

/** `Gateway.replayInboundSpool`. */
interface InboundSpoolReplayer {
  replayInboundSpool(): Promise<{ replayed: number; deferred: number; dead: number }>;
}

/** `GatewayObservability.recordSafetyBlock`. */
interface SafetyBlockSink {
  recordSafetyBlock(opts: { code?: string; details?: Record<string, unknown> }): void;
}

/** How long a `done` inbound-spool row is kept (plan reach-and-containment
 *  D2-11). Its payload was already nulled at `markDone`; the row stays for the
 *  UNIQUE key and forensics. `received`/`processing` rows are never age-pruned. */
export const INBOUND_SPOOL_RETENTION_MS = 7 * 86_400_000;
/** How long a `dead` spool row is kept before it is pruned (with an event): a
 *  dead letter nobody looked at for a month is not going to be looked at. */
export const INBOUND_SPOOL_DEAD_RETENTION_MS = 30 * 86_400_000;

/**
 * One gateway per state dir (plan reach-and-containment §2.7). Call right
 * after config load and BEFORE any store is opened or adapter constructed: a
 * second process would poll the same bot tokens and reset this one's in-flight
 * inbound-spool rows. Refused → prints the refusal and exits
 * `GATEWAY_LOCK_EXIT_CODE` (3), which `ethos run-all` and the desktop app read
 * as "already running", not as a crash. Any other error propagates.
 *
 * Resolves to the lock's `release`, which the caller runs in its shutdown path
 * once the spool is closed. It is also registered on `process.on('exit')`: an
 * uncaught crash of a live process still runs exit handlers, so the next start
 * does not have to classify a stale lock. `release` deletes only this
 * process's own bytes (`acquireSentinelLock`), so running it twice is safe.
 */
export async function takeGatewayLockOrExit(dataDir: string): Promise<() => void> {
  let release: () => void;
  try {
    release = await acquireGatewayLock(dataDir);
  } catch (err) {
    if (err instanceof GatewayLockHeldError) {
      console.error(err.message);
      process.exit(GATEWAY_LOCK_EXIT_CODE);
    }
    throw err;
  }
  process.on('exit', () => release());
  return release;
}

/**
 * Open `<dataDir>/inbound-spool.db` and the Gateway options that go with it
 * (`gateway.inboundSpool.maxAttempts` / `maxReplayAgeMs` from config.yaml, plus
 * this process's claim identity). Only after {@link takeGatewayLockOrExit}.
 */
export function openInboundSpool(
  config: EthosConfig,
  dataDir: string,
): {
  inboundSpool: SQLiteInboundSpool;
  inboundSpoolOptions: InboundSpoolGatewayOptions;
} {
  const spoolConfig = config.gateway?.inboundSpool;
  return {
    inboundSpool: new SQLiteInboundSpool(join(dataDir, 'inbound-spool.db')),
    inboundSpoolOptions: {
      ...(spoolConfig?.maxAttempts !== undefined ? { maxAttempts: spoolConfig.maxAttempts } : {}),
      ...(spoolConfig?.maxReplayAgeMs !== undefined
        ? { maxReplayAgeMs: spoolConfig.maxReplayAgeMs }
        : {}),
      // pid:boot, plus a per-process nonce so a container's recurring pid 1 on
      // an unchanged kernel boot still names a distinct claimant.
      owner: `${process.pid}:${currentBootId() ?? 'unknown-boot'}:${randomUUID().slice(0, 8)}`,
    },
  };
}

/**
 * Inbound spool retention (D2-11): `done` after a week, `dead` after 30 days,
 * the latter recorded as `gateway.spool_dead_pruned`. `received`/`processing`
 * are owed work and are never age-pruned. A failure is a warning, never a dead
 * process. The caller runs it once at boot and then on its hourly retention tick.
 */
export function pruneInboundSpool(
  spool: Pick<InboundSpool, 'pruneDone' | 'pruneDead'>,
  deps: {
    observability: SafetyBlockSink;
    warn: (message: string) => void;
  },
): void {
  try {
    spool.pruneDone(Date.now() - INBOUND_SPOOL_RETENTION_MS);
    const deadPruned = spool.pruneDead(Date.now() - INBOUND_SPOOL_DEAD_RETENTION_MS);
    if (deadPruned > 0) {
      deps.observability.recordSafetyBlock({
        code: 'gateway.spool_dead_pruned',
        details: { count: deadPruned },
      });
    }
  } catch (err) {
    deps.warn(`inbound spool retention prune failed: ${String(err)}`);
  }
}

/**
 * Boot replay of the inbound spool (plan §2.4). Call only AFTER every adapter
 * has started — a replayed turn replies through a live adapter — beside the
 * delivery-ledger sweep. Fire-and-forget: the first `replayInboundSpool()` also
 * arms the Gateway's own 60s replay tick (`inboundSpoolOptions.replayIntervalMs`,
 * extensions/gateway), so a requeue from `ethos gateway spool replay` or the
 * web Deliveries page runs without a restart; `Gateway.shutdown` stops it.
 */
export function startInboundSpoolReplay(
  gateway: InboundSpoolReplayer,
  deps: { info: (message: string) => void; warn: (message: string) => void },
): void {
  void gateway
    .replayInboundSpool()
    .then(({ replayed, deferred, dead }) => {
      if (replayed > 0 || deferred > 0 || dead > 0) {
        deps.info(
          `Inbound spool: replayed ${replayed}, ${deferred} deferred, ${dead} dead-lettered`,
        );
      }
    })
    .catch((err) => {
      deps.warn(`inbound spool boot replay failed: ${String(err)}`);
    });
}
