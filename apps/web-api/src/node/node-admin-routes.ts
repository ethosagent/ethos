/**
 * Operator-facing node admin routes, mounted cookie-only at `/node/admin` (plan laptop-tool-node
 * verification B4). `ethos node list|approve` call them from the server host with the web token.
 * Response shapes and their decoders live in `@ethosagent/wiring/nodes` (admin-wire).
 * Pinned by ./__tests__/node-socket.test.ts.
 */
import type { NodeHub } from '@ethosagent/wiring/nodes';
import { Hono } from 'hono';
import type { NodePairing } from './node-pairing';

export function nodeAdminRoutes(deps: { hub: NodeHub; pairing: NodePairing }): Hono {
  const app = new Hono();

  app.get('/list', (c) => c.json({ nodes: deps.hub.list(), pending: deps.pairing.listPending() }));

  app.post('/approve', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const code =
      typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
    if (typeof code !== 'string' || code.length === 0) {
      return c.json({ error: 'body must be { "code": string }' }, 400);
    }
    const result = await deps.pairing.approve(code);
    if (result.ok) return c.json(result, 200);
    const status =
      result.reason === 'expired' ? 410 : result.reason === 'connection_closed' ? 409 : 404;
    return c.json(result, status);
  });

  return app;
}
