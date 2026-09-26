import { createServer, type Server } from 'node:http';
import { basename } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import Database from '@ethosagent/sqlite';

export interface HealthPayload {
  status: 'ok' | 'degraded';
  uptime: number;
  [key: string]: unknown;
}

export type HealthPayloadFn = () => HealthPayload | Promise<HealthPayload>;

/**
 * P2-counters (D16/D17) — authorizes a `/metrics` scrape on the gateway
 * health server. Receives the raw `Authorization` header value (or
 * `undefined`). Omitted entirely when no api-key store is wired for this
 * process, in which case the loopback-only bind is the sole gate — the same
 * posture `/healthz` on this server already has.
 */
export type MetricsAuthCheck = (
  authorizationHeader: string | undefined,
) => boolean | Promise<boolean>;

export interface ReadinessCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheckResult[];
}

export interface HealthServerOptions {
  /** R6 — backs `GET /readyz`. Absent → `/readyz` 404s, as before. */
  readiness?: () => Promise<ReadinessReport>;
  /** R6 — event-loop delay p99 in ms, published on `/metrics` as
   *  `ethos_event_loop_lag_p99_seconds`. Absent → the gauge is omitted. */
  eventLoopLagP99Ms?: () => number;
}

/** Default `/readyz` event-loop threshold. A loop whose p99 delay is over a
 *  second is answering, but every bot and lane on it is waiting that long. */
export const READYZ_EVENT_LOOP_P99_THRESHOLD_MS = 1_000;

/**
 * R6 — the event-loop delay sampler behind `/readyz` and `/metrics`.
 * `monitorEventLoopDelay` accumulates for the life of the histogram, so it is
 * rolled every `windowMs`: `p99Ms()` is the larger of the last full window and
 * the window in progress, so a stall shows for at least one window after it
 * ends and a stall from an hour ago shows not at all. The timer is unref'd.
 */
export function createEventLoopLagSampler(windowMs = 30_000): {
  p99Ms: () => number;
  stop: () => void;
} {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const toMs = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : 0);
  let lastWindowMs = 0;
  const timer = setInterval(() => {
    lastWindowMs = histogram.count > 0 ? toMs(histogram.percentile(99)) : 0;
    histogram.reset();
  }, windowMs);
  timer.unref();
  return {
    p99Ms: () => Math.max(lastWindowMs, histogram.count > 0 ? toMs(histogram.percentile(99)) : 0),
    stop: () => {
      clearInterval(timer);
      histogram.disable();
    },
  };
}

/** Opens a SQLite file read-only and reads its schema — the "store opens"
 *  probe. Throws when the file is missing, unreadable, corrupt, or held under
 *  an exclusive lock (a restore in progress). */
function probeSqliteOpens(path: string): void {
  const db = new Database(path, { readonly: true });
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } finally {
    db.close();
  }
}

/**
 * R6 — the `/readyz` check set: every adapter reports healthy, every listed
 * SQLite store opens, and the event loop's p99 delay is at or under the
 * threshold. `adapters` should be the gateway's CACHED health
 * (`buildGatewayHeartbeat` → `cachedHealth`, apps/ethos/src/commands/
 * gateway.ts) so a readiness probe never costs an adapter round trip — the
 * email adapter's is an IMAP login. Pinned by the '/readyz' cases in
 * `apps/ethos/src/__tests__/health-server.test.ts`.
 */
export function createReadinessCheck(opts: {
  adapters: () => Promise<Array<{ name: string; ok: boolean }>>;
  sqlitePaths: string[];
  lagP99Ms: () => number;
  lagThresholdMs?: number;
}): () => Promise<ReadinessReport> {
  const threshold = opts.lagThresholdMs ?? READYZ_EVENT_LOOP_P99_THRESHOLD_MS;
  return async () => {
    const checks: ReadinessCheckResult[] = [];
    for (const adapter of await opts.adapters()) {
      checks.push({ name: `adapter:${adapter.name}`, ok: adapter.ok });
    }
    for (const path of opts.sqlitePaths) {
      try {
        probeSqliteOpens(path);
        checks.push({ name: `sqlite:${basename(path)}`, ok: true });
      } catch (err) {
        checks.push({
          name: `sqlite:${basename(path)}`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const lag = opts.lagP99Ms();
    checks.push({
      name: 'event_loop',
      ok: lag <= threshold,
      detail: `p99 ${Math.round(lag)}ms, threshold ${threshold}ms`,
    });
    return { ready: checks.every((c) => c.ok), checks };
  };
}

/**
 * U9 + R6 — this process's own gauges, appended to `/metrics` on every scrape
 * (outside the counter text's cache, so memory is live): `process.memoryUsage()`
 * and, when a sampler is wired, the event-loop delay p99.
 */
export function renderProcessMetrics(eventLoopLagP99Ms?: () => number): string {
  const mem = process.memoryUsage();
  const lines = [
    '# TYPE ethos_process_rss_bytes gauge',
    `ethos_process_rss_bytes ${mem.rss}`,
    '# TYPE ethos_process_heap_used_bytes gauge',
    `ethos_process_heap_used_bytes ${mem.heapUsed}`,
    '# TYPE ethos_process_heap_total_bytes gauge',
    `ethos_process_heap_total_bytes ${mem.heapTotal}`,
    '# TYPE ethos_process_external_bytes gauge',
    `ethos_process_external_bytes ${mem.external}`,
  ];
  if (eventLoopLagP99Ms) {
    lines.push(
      '# TYPE ethos_event_loop_lag_p99_seconds gauge',
      `ethos_event_loop_lag_p99_seconds ${eventLoopLagP99Ms() / 1000}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function createHealthServer(
  port: number,
  host: string,
  getPayload: HealthPayloadFn,
  getMetricsText?: () => Promise<string>,
  checkMetricsAuth?: MetricsAuthCheck,
  options: HealthServerOptions = {},
): Server {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
      try {
        const payload = await getPayload();
        const code = payload.status === 'ok' ? 200 : 503;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'degraded', error: 'health check failed' }));
      }
      return;
    }
    // R6 — readiness, separate from `/healthz` liveness: a 503 here means
    // "alive, but do not route to me" (an adapter down, a store that will not
    // open, a lagging loop), which must not get the process restarted.
    if (req.method === 'GET' && req.url === '/readyz' && options.readiness) {
      try {
        const report = await options.readiness();
        res.writeHead(report.ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: report.ready ? 'ready' : 'not_ready', ...report }));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not_ready', error: 'readiness check failed' }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/metrics' && getMetricsText) {
      if (checkMetricsAuth && !(await checkMetricsAuth(req.headers.authorization))) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
      try {
        const text = (await getMetricsText()) + renderProcessMetrics(options.eventLoopLagP99Ms);
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(text);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('metrics render failed');
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `[health] port ${port} in use — health endpoint unavailable. ` +
          `Set ETHOS_GATEWAY_HEALTH_PORT or ETHOS_RUNALL_HEALTH_PORT to change.`,
      );
    }
  });
  server.listen(port, host);
  // Deliberately NOT unref'd: for gateway/serve/boot, every other handle
  // (heartbeats, cron) is unref'd for clean shutdown, so with no platform
  // adapter holding a socket this is the only thing keeping the process
  // alive. unref'ing it too left nothing refed — Node force-exits (code 13,
  // unfinished top-level await) the moment it goes idle. Callers still
  // `.close()` this in their SIGINT/SIGTERM handlers, so shutdown stays clean.
  return server;
}
