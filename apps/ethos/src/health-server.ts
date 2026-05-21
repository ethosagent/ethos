import { createServer, type Server } from 'node:http';

export interface HealthPayload {
  status: 'ok' | 'degraded';
  uptime: number;
  [key: string]: unknown;
}

export type HealthPayloadFn = () => HealthPayload | Promise<HealthPayload>;

export function createHealthServer(
  port: number,
  host: string,
  getPayload: HealthPayloadFn,
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
  server.unref();
  return server;
}
