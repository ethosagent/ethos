import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
export function systemSseRoutes(opts) {
    const app = new Hono();
    app.get('/system', async (c) => {
        return streamSSE(c, async (stream) => {
            let seq = 0;
            let pingInterval = null;
            const handler = (data) => {
                seq++;
                void stream.writeSSE({
                    id: String(seq),
                    data: JSON.stringify(data),
                });
            };
            stream.onAbort(() => {
                opts.systemBus.offSystem(handler);
                if (pingInterval)
                    clearInterval(pingInterval);
            });
            opts.systemBus.onSystem(handler);
            pingInterval = setInterval(() => {
                seq++;
                void stream.writeSSE({
                    id: String(seq),
                    data: JSON.stringify({ type: 'ping' }),
                });
            }, 25_000);
            await new Promise(() => { });
        });
    });
    return app;
}
