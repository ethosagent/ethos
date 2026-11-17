// `ethos gateway start` — the heartbeat's shape and the pure health / store-path
// helpers. Split out of gateway.ts, which re-exports them. `withTimeout`,
// `cachedHealth`, `buildGatewayHeartbeat` and the metrics auth check stay in
// gateway.ts: archcheck pins `withTimeout`'s `new Error` and the api-key hash
// import to that file's path.

import { join } from 'node:path';

export interface GatewayHeartbeat {
  pid: number;
  startedAt: string;
  updatedAt: string;
  adapters: Array<{ name: string; ok: boolean }>;
  /** U9 — this process's resident set size at `updatedAt`, read by
   *  `ethos status` (`gatewayMemoryFacet`, apps/ethos/src/commands/status.ts). */
  rssBytes: number;
}

/**
 * `/healthz` status from a heartbeat's adapter list: zero adapters is a valid
 * web-only deployment (helm minimal install) — degraded only when a CONFIGURED
 * adapter is down, so `every()`'s vacuous truth on `[]` is the point. Shared by
 * `ethos gateway start` and `ethos boot`; pinned by the 'gatewayHealthStatus'
 * cases in `apps/ethos/src/commands/__tests__/gateway-health.test.ts`.
 */
export function gatewayHealthStatus(
  adapters: Array<{ name: string; ok: boolean }>,
): 'ok' | 'degraded' {
  return adapters.every((a) => a.ok) ? 'ok' : 'degraded';
}

/** R6 — the SQLite stores an adapter-owning process (`ethos gateway start`,
 *  `ethos boot`) cannot serve without; `/readyz` requires each to open. */
export function gatewaySqliteStorePaths(dataDir: string): string[] {
  return ['sessions.db', 'delivery-ledger.db', 'inbound-dedup.db', 'inbound-spool.db'].map((file) =>
    join(dataDir, file),
  );
}
