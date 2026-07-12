// SSE task-events stream (plan §10) — authed with the same token + PoP as the
// RPC POST (the PoP bound to the `tasks/subscribe` pseudo-method), and gated so
// an unauthenticated subscriber cannot read task state.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { A2A_METHOD_TASKS_SUBSCRIBE, createA2aRpcRouter } from '../rpc';
import { type A2aTask, InMemoryA2aTaskStore } from '../task-store';
import {
  countingRunner,
  HELLO_SCRIPT,
  makeAgent,
  mintPeerToken,
  newPeerStore,
  signPop,
  stubIdentity,
  TARGET_ID,
} from './a2a-fixtures';

function build() {
  const target = makeAgent(TARGET_ID);
  const peer = makeAgent('peer-a');
  const peerStore = newPeerStore();
  const store = new InMemoryA2aTaskStore();
  const app = new Hono();
  app.route(
    '/a2a',
    createA2aRpcRouter({
      getIdentity: stubIdentity(target, { skills: ['search'] }),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, { runs: 0 }),
      taskStore: store,
    }),
  );
  return { target, peer, peerStore, store, app };
}

const seededTask = (): A2aTask => ({
  id: 'task-1',
  status: 'completed',
  result: 'done text',
  createdAt: 1,
  idempotencyKey: 'k',
  traceId: 't',
  peerFingerprint: 'fp',
});

describe('SSE /a2a/:id/tasks/:taskId/events', () => {
  it('rejects an unauthenticated subscriber', async () => {
    const { app } = build();
    const res = await app.request(`/a2a/${TARGET_ID}/tasks/task-1/events`);
    expect(res.status).toBe(401);
  });

  it('streams the current (terminal) task state to an authed subscriber', async () => {
    const { app, target, peer, peerStore, store } = build();
    await store.create(seededTask());
    const minted = await mintPeerToken(target, peer, ['search'], peerStore);
    const ts = Date.now();
    const res = await app.request(`/a2a/${TARGET_ID}/tasks/task-1/events`, {
      headers: {
        authorization: `Bearer ${minted.token}`,
        'x-a2a-pop': signPop(peer, A2A_METHOD_TASKS_SUBSCRIBE, minted.claims.jti, ts),
        'x-a2a-pop-timestamp': String(ts),
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('completed');
    expect(body).toContain('done text');
  });

  it('404s an unknown task for an authed subscriber', async () => {
    const { app, target, peer, peerStore } = build();
    const minted = await mintPeerToken(target, peer, ['search'], peerStore);
    const ts = Date.now();
    const res = await app.request(`/a2a/${TARGET_ID}/tasks/nope/events`, {
      headers: {
        authorization: `Bearer ${minted.token}`,
        'x-a2a-pop': signPop(peer, A2A_METHOD_TASKS_SUBSCRIBE, minted.claims.jti, ts),
        'x-a2a-pop-timestamp': String(ts),
      },
    });
    expect(res.status).toBe(404);
  });
});
