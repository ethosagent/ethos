import { EthosError } from '@ethosagent/types';
import { serve as honoServe } from '@hono/node-server';
export async function listenWithFallback(app, basePort, attempts, hostname = '127.0.0.1') {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        const port = basePort + i;
        try {
            const result = await tryListen(app, port, hostname);
            if (i > 0) {
                console.log(`[web] port ${basePort} busy, fell forward to ${port} (${i} attempt${i === 1 ? '' : 's'})`);
            }
            return result;
        }
        catch (err) {
            if (err.code !== 'EADDRINUSE')
                throw err;
            lastErr = err;
        }
    }
    throw new EthosError({
        code: 'INTERNAL',
        cause: `No free port in range ${basePort}-${basePort + attempts - 1}`,
        action: 'Pass --web-port=<n> to pick a different starting port, or stop whatever is using these.',
        details: { lastErr: lastErr instanceof Error ? lastErr.message : String(lastErr) },
    });
}
function tryListen(app, port, hostname) {
    return new Promise((resolve, reject) => {
        const server = honoServe({ fetch: app.fetch, port, hostname }, () => {
            resolve({ server, port });
        });
        // The Node server underlying @hono/node-server emits 'error' for bind
        // failures. Catch once; resolve has either fired by then or the error
        // beat it.
        server.once('error', (err) => reject(err));
    });
}
