// plan laptop-tool-node T7 + verification B3/B4: the web-api node lane over a REAL `ws` connection.
// The harness lives in ./node-socket-fixtures.

import { NODE_PAIR_PATH } from '@ethosagent/wiring/nodes';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { authMiddleware } from '../../middleware/auth';
import { csrfMiddleware } from '../../middleware/csrf';
import { errorHandler } from '../../middleware/error-envelope';
import { nodeAdminRoutes } from '../node-admin-routes';
import {
  advanceClock,
  hub,
  open,
  pairing,
  pairRequest,
  ROOTS,
  setup,
  until,
} from './node-socket-fixtures';

describe('/node/admin routes', () => {
  const COOKIE = { cookie: 'ethos_auth=good' };
  const POST_HEADERS = {
    ...COOKIE,
    host: '127.0.0.1:3000',
    origin: 'http://127.0.0.1:3000',
    'content-type': 'application/json',
  };
  let app: Hono;
  let code: string;

  beforeEach(async () => {
    await setup();
    app = new Hono();
    app.onError(errorHandler);
    app.use('/node/admin/*', authMiddleware({ verify: async (c) => c === 'good' }));
    app.use('/node/admin/*', csrfMiddleware());
    app.route('/node/admin', nodeAdminRoutes({ hub, pairing }));
    const ws = await open(NODE_PAIR_PATH);
    ws.send(pairRequest('adminpaired'));
    await until(() => pairing.listPending().length === 1);
    code = pairing.listPending()[0]?.code ?? '';
  });

  const approve = (headers: Record<string, string>, body: unknown) =>
    app.request('/node/admin/approve', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('both routes are 401 without the cookie', async () => {
    expect((await app.request('/node/admin/list')).status).toBe(401);
    expect((await approve({ 'content-type': 'application/json' }, { code })).status).toBe(401);
  });

  it('GET /list returns nodes and pending', async () => {
    const res = await app.request('/node/admin/list', { headers: COOKIE });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nodes: [],
      pending: [{ code, name: 'adminpaired', roots: ROOTS }],
    });
  });

  it('POST /approve: 400 bad body, 200 ok, 404 unknown, 410 expired', async () => {
    expect((await approve(POST_HEADERS, '{nope')).status).toBe(400);
    expect((await approve(POST_HEADERS, { code: 5 })).status).toBe(400);
    const ok = await approve(POST_HEADERS, { code });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, name: 'adminpaired' });
    const again = await approve(POST_HEADERS, { code });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ ok: false, reason: 'unknown_code' });
    const ws = await open(NODE_PAIR_PATH);
    ws.send(pairRequest('stale'));
    await until(() => pairing.listPending().length === 1);
    const stale = pairing.listPending()[0]?.code ?? '';
    advanceClock(600_001);
    expect((await approve(POST_HEADERS, { code: stale })).status).toBe(410);
  });
});
