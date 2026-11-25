// plan laptop-tool-node T7 + verification B3/B4: the web-api node lane over a REAL `ws` connection
// on an ephemeral port (same harness shape as voice/__tests__/satellite-socket.test.ts), with a
// real SqliteApiKeyStore. The pairing half is driven through the socket; the admin routes through
// Hono's `app.request` with a stubbed cookie verifier.

import { createHash } from 'node:crypto';
import {
  decodePairServerFrame,
  NODE_PAIR_PATH,
  NODE_SOCKET_PATH,
  type PairClientFrame,
} from '@ethosagent/wiring/nodes';
import { beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { NodePairing, type PairConnection } from '../node-pairing';
import {
  advanceClock,
  bearer,
  closed,
  connect,
  hello,
  hub,
  message,
  nodeKey,
  open,
  pairing,
  pairRequest,
  ROOTS,
  setup,
  store,
  until,
} from './node-socket-fixtures';

describe('/node/ws upgrade policy', () => {
  beforeEach(() => setup());

  it('no Authorization header is 401', async () => {
    expect((await connect(NODE_SOCKET_PATH)).status).toBe(401);
  });

  it('a chat-scoped key is 403', async () => {
    const { secret } = await store.create({ name: 'chat', scopes: ['chat'] });
    expect((await connect(NODE_SOCKET_PATH, bearer(secret))).status).toBe(403);
  });

  it('a revoked key is 401', async () => {
    const { secret, record } = await nodeKey();
    await store.revoke(record.prefix);
    expect((await connect(NODE_SOCKET_PATH, bearer(secret))).status).toBe(401);
  });
});

describe('/node/ws session', () => {
  it('a node:host key plus hello registers the node under the KEY name, not the hello name', async () => {
    await setup();
    const { secret, record } = await nodeKey('node:laptop');
    const ws = await open(NODE_SOCKET_PATH, bearer(secret));
    ws.send(hello('spoofed'));
    await until(() => hub.list().some((n) => n.online));
    expect(hub.list()).toMatchObject([
      { name: 'laptop', keyId: record.id, online: true, roots: ROOTS },
    ]);
    ws.close();
  });

  it('a bad frame after hello closes 1008', async () => {
    await setup();
    const { secret } = await nodeKey();
    const ws = await open(NODE_SOCKET_PATH, bearer(secret));
    const done = closed(ws);
    ws.send(hello());
    await until(() => hub.list().length === 1);
    ws.send('not json');
    expect(await done).toBe(1008);
  });

  it('no hello within helloTimeoutMs closes 1008', async () => {
    await setup({ helloTimeoutMs: 80 });
    const { secret } = await nodeKey();
    const ws = await open(NODE_SOCKET_PATH, bearer(secret));
    expect(await closed(ws)).toBe(1008);
    expect(hub.list()).toEqual([]);
  });

  it('revoking the key while connected closes 4401 and the node goes offline (B4)', async () => {
    await setup();
    const { secret, record } = await nodeKey();
    const ws = await open(NODE_SOCKET_PATH, bearer(secret));
    const done = closed(ws);
    ws.send(hello());
    await until(() => hub.list().some((n) => n.online));
    await store.revoke(record.prefix);
    expect(await done).toBe(4401);
    await until(() => hub.list().every((n) => !n.online));
  });

  // Verification M5: a revoked key's entry is pruned, so re-pairing the name is not ambiguous.
  it('a revoked key (4401) is pruned from the hub; re-pairing the name resolves it', async () => {
    await setup();
    const old = await nodeKey('node:lap');
    const ws = await open(NODE_SOCKET_PATH, bearer(old.secret));
    const done = closed(ws);
    ws.send(hello());
    await until(() => hub.list().some((n) => n.online));
    await store.revoke(old.record.prefix);
    expect(await done).toBe(4401);
    await until(() => hub.list().length === 0);
    const fresh = await nodeKey('node:lap');
    const ws2 = await open(NODE_SOCKET_PATH, bearer(fresh.secret));
    ws2.send(hello());
    await until(() => hub.pick({ node: 'lap' }).ok);
    expect(hub.list()).toHaveLength(1);
    ws2.close();
  });

  it('a second socket with the same key evicts the first with 4000', async () => {
    await setup();
    const { secret } = await nodeKey();
    const first = await open(NODE_SOCKET_PATH, bearer(secret));
    const firstClosed = closed(first);
    first.send(hello());
    await until(() => hub.list().some((n) => n.online));
    const second = await open(NODE_SOCKET_PATH, bearer(secret));
    second.send(hello());
    expect(await firstClosed).toBe(4000);
    await until(() => hub.list().some((n) => n.online && n.replacedAt !== undefined));
    expect(second.readyState).toBe(WebSocket.OPEN);
    second.close();
  });
});

describe('/node/pair', () => {
  async function pendingCode(ws: WebSocket, name: string): Promise<string> {
    const got = message(ws);
    ws.send(pairRequest(name));
    const f = decodePairServerFrame(await got);
    if (!f.ok || f.frame.kind !== 'pair_pending') throw new Error('expected pair_pending');
    return f.frame.code;
  }

  it('approve mints a node:host key, delivers it once, closes 1000, and forgets the code', async () => {
    await setup();
    const ws = await open(NODE_PAIR_PATH);
    const code = await pendingCode(ws, 'laptop2');
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    const approved = message(ws);
    const done = closed(ws);
    const res = await pairing.approve(code.toLowerCase());
    expect(res).toMatchObject({ ok: true, name: 'laptop2' });
    const frame = decodePairServerFrame(await approved);
    if (!frame.ok || frame.frame.kind !== 'pair_approved') throw new Error('expected approved');
    const { key, keyId } = frame.frame;
    expect(key.startsWith('sk-ethos-')).toBe(true);
    expect(await done).toBe(1000);
    const row = (await store.list()).find((k) => k.id === keyId);
    expect(row).toMatchObject({ name: 'node:laptop2', scopes: ['node:host'] });
    expect(await pairing.approve(code)).toEqual({ ok: false, reason: 'unknown_code' });
  });

  it('a code past its TTL is refused expired and the socket gets pair_refused', async () => {
    await setup();
    const ws = await open(NODE_PAIR_PATH);
    const code = await pendingCode(ws, 'late');
    const refused = message(ws);
    advanceClock(600_001);
    expect(await pairing.approve(code)).toEqual({ ok: false, reason: 'expired' });
    expect(decodePairServerFrame(await refused)).toMatchObject({
      ok: true,
      frame: { kind: 'pair_refused', reason: 'expired' },
    });
  });

  it('a bad node name is refused with pair_refused', async () => {
    await setup();
    const ws = await open(NODE_PAIR_PATH);
    const refused = message(ws);
    ws.send(pairRequest('../evil name'));
    expect(decodePairServerFrame(await refused)).toMatchObject({
      ok: true,
      frame: { kind: 'pair_refused' },
    });
    expect(pairing.listPending()).toEqual([]);
  });

  it('with 5 pending, a sixth upgrade is 429', async () => {
    await setup();
    for (let i = 0; i < 5; i++) await pendingCode(await open(NODE_PAIR_PATH), `n${i}`);
    expect(pairing.listPending()).toHaveLength(5);
    expect((await connect(NODE_PAIR_PATH)).status).toBe(429);
  });

  it('the per-IP token bucket refuses the 6th upgrade within a minute', async () => {
    await setup({ pairing: { maxPending: 100 } });
    for (let i = 0; i < 5; i++) {
      const ws = await open(NODE_PAIR_PATH);
      ws.close();
    }
    expect((await connect(NODE_PAIR_PATH)).status).toBe(429);
  });

  it('re-pairing a name revokes the old node:<name> key', async () => {
    await setup();
    const old = await nodeKey('node:laptop');
    const ws = await open(NODE_PAIR_PATH);
    const code = await pendingCode(ws, 'laptop');
    const approved = message(ws);
    const res = await pairing.approve(code);
    expect(res.ok).toBe(true);
    await approved;
    expect(await store.findByHash(hashOf(old.secret))).toBeNull();
    const live = (await store.list()).filter((k) => k.name === 'node:laptop' && !k.revokedAt);
    expect(live).toHaveLength(1);
  });

  // Verification M4: an idle pending socket must survive ingress idle timeouts (plan §10).
  it('pings a pending pair socket every pingIntervalMs', async () => {
    await setup();
    const ws = await open(NODE_PAIR_PATH);
    let pings = 0;
    ws.on('ping', () => {
      pings++;
    });
    await pendingCode(ws, 'idle');
    await until(() => pings >= 2);
    ws.close();
  });

  // Verification m2: a code approved after the laptop hung up must not leave a live key behind.
  it('revokes the minted key when the pending socket is no longer open', async () => {
    const sent: unknown[] = [];
    let onFrame: (f: PairClientFrame) => void = () => {};
    let open = true;
    const conn: PairConnection = {
      send: (f) => {
        sent.push(f);
      },
      close: () => {},
      isOpen: () => open,
      onFrame: (cb) => {
        onFrame = cb;
      },
      onClose: () => {},
    };
    const p = new NodePairing({ apiKeys: store });
    p.open(conn);
    onFrame({ v: 1, kind: 'pair_request', name: 'ghost', roots: [] });
    const code = p.listPending()[0]?.code ?? '';
    open = false;
    await expect(p.approve(code)).resolves.toEqual({ ok: false, reason: 'connection_closed' });
    const rows = (await store.list()).filter((k) => k.name === 'node:ghost');
    expect(rows.every((k) => k.revokedAt)).toBe(true);
    expect(sent.some((f) => (f as { kind: string }).kind === 'pair_approved')).toBe(false);
  });

  it('failed delivery keeps the old key of the same name valid', async () => {
    let onFrame: (f: PairClientFrame) => void = () => {};
    const conn: PairConnection = {
      send: () => {},
      close: () => {},
      isOpen: () => false,
      onFrame: (cb) => {
        onFrame = cb;
      },
      onClose: () => {},
    };
    const old = await store.create({ name: 'node:keeper', scopes: ['node:host'] });
    const p = new NodePairing({ apiKeys: store });
    p.open(conn);
    onFrame({ v: 1, kind: 'pair_request', name: 'keeper', roots: [] });
    const code = p.listPending()[0]?.code ?? '';
    await expect(p.approve(code)).resolves.toEqual({ ok: false, reason: 'connection_closed' });
    const rows = (await store.list()).filter((k) => k.name === 'node:keeper');
    expect(rows).toHaveLength(2);
    expect(rows.find((k) => k.id === old.record.id)?.revokedAt).toBeFalsy();
    expect(rows.find((k) => k.id !== old.record.id)?.revokedAt).toBeTruthy();
  });

  it('successful delivery revokes the older keys of the same name', async () => {
    let onFrame: (f: PairClientFrame) => void = () => {};
    const conn: PairConnection = {
      send: () => {},
      close: () => {},
      isOpen: () => true,
      onFrame: (cb) => {
        onFrame = cb;
      },
      onClose: () => {},
    };
    const old = await store.create({ name: 'node:swap', scopes: ['node:host'] });
    const p = new NodePairing({ apiKeys: store });
    p.open(conn);
    onFrame({ v: 1, kind: 'pair_request', name: 'swap', roots: [] });
    await p.approve(p.listPending()[0]?.code ?? '');
    const rows = (await store.list()).filter((k) => k.name === 'node:swap');
    expect(rows.find((k) => k.id === old.record.id)?.revokedAt).toBeTruthy();
    expect(rows.filter((k) => !k.revokedAt)).toHaveLength(1);
  });

  it('a send that throws also revokes the minted key', async () => {
    let onFrame: (f: PairClientFrame) => void = () => {};
    const conn: PairConnection = {
      send: (f) => {
        if (f.kind === 'pair_approved') throw new Error('socket gone');
      },
      close: () => {},
      isOpen: () => true,
      onFrame: (cb) => {
        onFrame = cb;
      },
      onClose: () => {},
    };
    const p = new NodePairing({ apiKeys: store });
    p.open(conn);
    onFrame({ v: 1, kind: 'pair_request', name: 'ghost2', roots: [] });
    const code = p.listPending()[0]?.code ?? '';
    await expect(p.approve(code)).resolves.toEqual({ ok: false, reason: 'connection_closed' });
    const rows = (await store.list()).filter((k) => k.name === 'node:ghost2');
    expect(rows.every((k) => k.revokedAt)).toBe(true);
  });

  // Verification m4: the bucket keys like rateLimitMiddleware: X-Forwarded-For only behind a proxy.
  it('without trustProxy a spoofed X-Forwarded-For does not mint a fresh bucket', async () => {
    await setup({ pairing: { maxPending: 100 } });
    for (let i = 0; i < 5; i++)
      (await open(NODE_PAIR_PATH, { 'x-forwarded-for': `9.9.9.${i}` })).close();
    expect((await connect(NODE_PAIR_PATH, { 'x-forwarded-for': '9.9.9.99' })).status).toBe(429);
  });

  it('with trustProxy each forwarded client gets its own bucket', async () => {
    await setup({ pairing: { maxPending: 100 }, trustProxy: true });
    for (let i = 0; i < 8; i++) {
      (await open(NODE_PAIR_PATH, { 'x-forwarded-for': `9.9.9.${i}` })).close();
    }
    for (let i = 0; i < 5; i++)
      (await open(NODE_PAIR_PATH, { 'x-forwarded-for': '7.7.7.7' })).close();
    expect((await connect(NODE_PAIR_PATH, { 'x-forwarded-for': '7.7.7.7' })).status).toBe(429);
  });

  it('a pending entry is dropped when its socket closes', async () => {
    await setup();
    const ws = await open(NODE_PAIR_PATH);
    await pendingCode(ws, 'gone');
    ws.close();
    await until(() => pairing.listPending().length === 0);
  });
});

function hashOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
