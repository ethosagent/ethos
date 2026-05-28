import { createServer } from 'node:http';
export function createHealthServer(port, host, getPayload) {
    const server = createServer(async (req, res) => {
        if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
            try {
                const payload = await getPayload();
                const code = payload.status === 'ok' ? 200 : 503;
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            }
            catch {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'degraded', error: 'health check failed' }));
            }
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`[health] port ${port} in use — health endpoint unavailable. ` +
                `Set ETHOS_GATEWAY_HEALTH_PORT or ETHOS_RUNALL_HEALTH_PORT to change.`);
        }
    });
    server.listen(port, host);
    server.unref();
    return server;
}
