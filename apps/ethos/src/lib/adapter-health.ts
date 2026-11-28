// One adapter's health probe for the gateway heartbeat, cached (R9). Extracted from
// apps/ethos/src/commands/gateway.ts (size gate); `buildGatewayHeartbeat` is the caller.
import type { PlatformAdapter } from '@ethosagent/types';

const HEALTH_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('health check timeout')), ms).unref(),
    ),
  ]);
}

/** How long one adapter `health()` result is reused (R9). The heartbeat writer
 *  ticks every HEARTBEAT_INTERVAL_MS and `/healthz`, `/readyz` and `/metrics`
 *  each build a heartbeat per request; without this, an adapter whose probe is
 *  a network round trip — the email adapter's is a full IMAP connect + logout
 *  (`EmailAdapter.health`) — logged in every 10 seconds and on every scrape. */
const HEALTH_CACHE_TTL_MS = 60_000;
const healthCache = new WeakMap<PlatformAdapter, { at: number; ok: Promise<boolean> }>();

/**
 * One adapter's health, probed at most once per HEALTH_CACHE_TTL_MS. The
 * in-flight probe is cached too, so concurrent callers share it; a rejection
 * or a HEALTH_TIMEOUT_MS timeout is cached as `false` for the same window.
 * Keyed by adapter object, so a bot a live reload adds starts uncached.
 * Pinned by the 'health cache' cases in
 * `apps/ethos/src/commands/__tests__/gateway-health.test.ts`.
 */
export function cachedHealth(adapter: PlatformAdapter): Promise<boolean> {
  const now = Date.now();
  const hit = healthCache.get(adapter);
  if (hit && now - hit.at < HEALTH_CACHE_TTL_MS) return hit.ok;
  const ok = withTimeout(adapter.health(), HEALTH_TIMEOUT_MS).then(
    (r) => r.ok,
    () => false,
  );
  healthCache.set(adapter, { at: now, ok });
  return ok;
}
