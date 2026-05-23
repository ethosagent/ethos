import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SystemEventBus } from '../services/system-event-bus';

export interface SystemSseRoutesOptions {
  systemBus: SystemEventBus;
}

export function systemSseRoutes(opts: SystemSseRoutesOptions) {
  const app = new Hono();

  app.get('/system', async (c) => {
    return streamSSE(c, async (stream) => {
      let seq = 0;
      let pingInterval: ReturnType<typeof setInterval> | null = null;

      const handler = (data: import('../services/system-event-bus').SystemEvent) => {
        seq++;
        void stream.writeSSE({
          id: String(seq),
          data: JSON.stringify(data),
        });
      };

      stream.onAbort(() => {
        opts.systemBus.offSystem(handler);
        if (pingInterval) clearInterval(pingInterval);
      });

      opts.systemBus.onSystem(handler);

      pingInterval = setInterval(() => {
        seq++;
        void stream.writeSSE({
          id: String(seq),
          data: JSON.stringify({ type: 'ping' }),
        });
      }, 25_000);

      await new Promise<void>(() => {});
    });
  });

  return app;
}
