/**
 * NodeClient, pairNode, URL policy and backoff (plan laptop-tool-node §4 Replay/Output rows,
 * D-REPLACED, D-401). A fake socket factory and fake timers stand in for `ws`.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecuteRequest, ToolProgressEvent, ToolResult } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capNodeResult, NODE_RESULT_CAP_CHARS } from '../caps';
import {
  decodeNodeFrame,
  encodeFrame,
  type HelloFrame,
  NODE_FRAME_MAX_BYTES,
  type NodeToServerFrame,
  type ServerToNodeFrame,
} from '../frames';
import { NodeClient, type NodeClientStatus, pairNode } from '../node-client';
import { NodeGuard } from '../node-guard';
import type { NodeSocketFactory, NodeSocketHandlers } from '../node-socket-transport';
import { assertSecureNodeUrl, NodeUrlError, nextBackoffMs } from '../node-url';
import { callFrame as fxCallFrame, NOW } from './fixtures';

interface FakeSocket {
  url: string;
  init: { headers?: Record<string, string>; maxPayload: number };
  h: NodeSocketHandlers;
  sent: string[];
  closed?: { code?: number; reason?: string };
}
let sockets: FakeSocket[] = [];
const factory: NodeSocketFactory = (url, init, h) => {
  const s: FakeSocket = { url, init, h, sent: [] };
  sockets.push(s);
  return {
    send: (t) => void s.sent.push(t),
    close: (code, reason) => {
      s.closed = {
        ...(code !== undefined ? { code } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
    },
  };
};
const frames = (s: FakeSocket): NodeToServerFrame[] =>
  s.sent.map((t) => {
    const d = decodeNodeFrame(t);
    if (!d.ok) throw new Error(d.reason);
    return d.frame;
  });
const push = (s: FakeSocket, f: ServerToNodeFrame) => s.h.onText(encodeFrame(f));
const flush = () => vi.advanceTimersByTimeAsync(0);

let root: string;
let guard: NodeGuard;
let statuses: NodeClientStatus[];

const callFrame = (name: string, args: unknown, req: Partial<ToolExecuteRequest> = {}, id = 'c1') =>
  fxCallFrame(name, args, { callId: id, req });

function makeClient(
  execute: (
    r: ToolExecuteRequest,
    s: AbortSignal,
    emit: (e: ToolProgressEvent) => void,
  ) => Promise<ToolResult>,
  url = 'https://ethos.example.com',
) {
  return new NodeClient({
    url,
    key: 'sk-ethos-abc',
    hello: {
      name: 'lap',
      roots: [{ path: root, readOnly: false }],
      tools: ['read_file'],
      personalities: ['*'],
    },
    guard,
    execute,
    socketFactory: factory,
    now: () => NOW,
    random: () => 1,
    onStatus: (s) => void statuses.push(s),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  statuses = [];
  root = realpathSync(mkdtempSync(join(tmpdir(), 'node-client-')));
  guard = new NodeGuard({
    policy: {
      roots: [{ path: root, readOnly: false }],
      tools: ['read_file'],
      personalities: ['*'],
      writes: 'auto',
      allowUnattended: true,
    },
    approve: null,
    now: () => NOW,
  });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('url policy and backoff', () => {
  it('refuses cleartext to a non-loopback host', () => {
    expect(() => assertSecureNodeUrl('http://example.com', '/node/ws')).toThrow(NodeUrlError);
    expect(() => assertSecureNodeUrl('ws://10.0.0.5:3000', '/node/ws')).toThrow(NodeUrlError);
    expect(() => assertSecureNodeUrl('ftp://localhost', '/node/ws')).toThrow(NodeUrlError);
  });
  it('accepts loopback cleartext and TLS, mapping to ws(s) + path', () => {
    expect(assertSecureNodeUrl('http://127.0.0.1:3000', '/node/ws').href).toBe(
      'ws://127.0.0.1:3000/node/ws',
    );
    expect(assertSecureNodeUrl('http://localhost:3000', '/node/ws').href).toBe(
      'ws://localhost:3000/node/ws',
    );
    expect(assertSecureNodeUrl('http://[::1]:3000', '/node/ws').href).toBe(
      'ws://[::1]:3000/node/ws',
    );
    expect(assertSecureNodeUrl('https://ethos.example.com', '/node/pair').href).toBe(
      'wss://ethos.example.com/node/pair',
    );
  });
  it('refuses a URL with userinfo so ws never sends Basic auth', () => {
    expect(() => assertSecureNodeUrl('https://user:pw@ethos.example.com', '/node/ws')).toThrow(
      NodeUrlError,
    );
    expect(() => assertSecureNodeUrl('wss://user@ethos.example.com', '/node/ws')).toThrow(
      NodeUrlError,
    );
  });

  it('backs off 1s doubling to a 60s ceiling (random = 1)', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => nextBackoffMs(n, () => 1))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
  });
  it('jitters between 1s and the ceiling (random = 0 and 0.5)', () => {
    expect(nextBackoffMs(5, () => 0)).toBe(1000);
    expect(nextBackoffMs(3, () => 0.5)).toBe(4500);
    expect(nextBackoffMs(20, () => 0.5)).toBe(30500);
    for (let i = 0; i < 50; i++) {
      const d = nextBackoffMs(4);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(16000);
    }
  });
});

describe('NodeClient', () => {
  it('connects with a bearer header, sends hello with clock, then answers a call', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: 'data' }));
    const c = makeClient(execute);
    c.start();
    const s = sockets[0] as FakeSocket;
    expect(s.url).toBe('wss://ethos.example.com/node/ws');
    expect(s.init.headers).toEqual({ Authorization: 'Bearer sk-ethos-abc' });
    expect(s.init.maxPayload).toBe(NODE_FRAME_MAX_BYTES);
    s.h.onOpen();
    const hello = frames(s)[0] as HelloFrame;
    expect(hello).toMatchObject({ kind: 'hello', name: 'lap', clock: NOW });
    expect(c.status).toBe('connected');
    push(s, callFrame('read_file', { path: join(root, 'a.txt') }));
    await flush();
    const out = frames(s).filter((f) => f.kind === 'result');
    expect(out).toEqual([
      { v: 1, kind: 'result', callId: 'c1', result: { ok: true, value: 'data' } },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    await c.stop();
  });

  it('sends a refused admission as the result and never executes', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: 'x' }));
    const c = makeClient(execute);
    c.start();
    const s = sockets[0] as FakeSocket;
    s.h.onOpen();
    push(s, callFrame('terminal', { command: 'ls' }));
    await flush();
    const res = frames(s).find((f) => f.kind === 'result');
    expect(res).toMatchObject({ kind: 'result', result: { ok: false, code: 'not_available' } });
    expect(execute).not.toHaveBeenCalled();
    await c.stop();
  });

  it('cuts oversize values at min(budget, cap) and keeps structured only when small', async () => {
    const big = 'x'.repeat(NODE_RESULT_CAP_CHARS + 500);
    const c = makeClient(async () => ({
      ok: true,
      value: big,
      structured: { a: 'y'.repeat(20_000) },
    }));
    c.start();
    const s = sockets[0] as FakeSocket;
    s.h.onOpen();
    push(s, callFrame('read_file', { path: join(root, 'a') }, { resultBudgetChars: 10 }, 'small'));
    push(s, callFrame('read_file', { path: join(root, 'a') }, {}, 'large'));
    await flush();
    const results = frames(s).filter((f) => f.kind === 'result');
    const byId = (id: string) => results.find((f) => f.kind === 'result' && f.callId === id);
    const small = byId('small');
    const large = byId('large');
    if (small?.kind !== 'result' || !small.result.ok) throw new Error('small');
    if (large?.kind !== 'result' || !large.result.ok) throw new Error('large');
    expect(small.result.value).toBe(`${'x'.repeat(10)}\n[truncated — ${big.length} chars total]`);
    expect(small.result.structured).toBeUndefined();
    expect(large.result.value).toBe(
      `${'x'.repeat(NODE_RESULT_CAP_CHARS)}\n[truncated — ${big.length} chars total]`,
    );
    await c.stop();
  });

  it('keeps a small structured payload', async () => {
    const c = makeClient(async () => ({ ok: true, value: 'v', structured: { n: 1 } }));
    c.start();
    const s = sockets[0] as FakeSocket;
    s.h.onOpen();
    push(s, callFrame('read_file', { path: join(root, 'a') }));
    await flush();
    const res = frames(s).find((f) => f.kind === 'result');
    expect(res).toMatchObject({ result: { ok: true, value: 'v', structured: { n: 1 } } });
    await c.stop();
  });

  it('cancel aborts the running call', async () => {
    let seen: AbortSignal | undefined;
    const c = makeClient(
      (_r, signal) =>
        new Promise<ToolResult>((res) => {
          seen = signal;
          signal.addEventListener('abort', () =>
            res({ ok: false, code: 'execution_failed', error: 'aborted' }),
          );
        }),
    );
    c.start();
    const s = sockets[0] as FakeSocket;
    s.h.onOpen();
    push(s, callFrame('read_file', { path: join(root, 'a') }));
    await flush();
    expect(seen?.aborted).toBe(false);
    push(s, { v: 1, kind: 'cancel', callId: 'c1' });
    expect(seen?.aborted).toBe(true);
    await c.stop();
  });

  it('refuses a duplicate callId while the first runs, and cancel still aborts the first', async () => {
    const signals: AbortSignal[] = [];
    const c = makeClient(
      (_r, signal) =>
        new Promise<ToolResult>((res) => {
          signals.push(signal);
          signal.addEventListener('abort', () =>
            res({ ok: false, code: 'execution_failed', error: 'aborted' }),
          );
        }),
    );
    c.start();
    const s = sockets[0] as FakeSocket;
    s.h.onOpen();
    push(s, callFrame('read_file', { path: join(root, 'a') }));
    await flush();
    push(s, callFrame('read_file', { path: join(root, 'a') }));
    await flush();
    const dup = frames(s).filter((f) => f.kind === 'result');
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ result: { ok: false, code: 'not_available' } });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    push(s, { v: 1, kind: 'cancel', callId: 'c1' });
    expect(signals[0]?.aborted).toBe(true);
    await c.stop();
  });

  it('caps a progress message at 4 KB', async () => {
    const c = makeClient(async (_r, _s, emit) => {
      emit({ type: 'progress', toolName: 'read_file', message: 'p'.repeat(10_000) });
      return { ok: true, value: 'v' };
    });
    c.start();
    const s = sockets[0] as FakeSocket;
    s.h.onOpen();
    push(s, callFrame('read_file', { path: join(root, 'a') }));
    await flush();
    const prog = frames(s).find((f) => f.kind === 'progress');
    if (prog?.kind !== 'progress') throw new Error('no progress');
    expect(prog.message.length).toBe(4096);
    await c.stop();
  });

  it('capNodeResult on ok:false drops cause and caps reason, field and conflictKey', () => {
    const big = 'z'.repeat(5000);
    const out = capNodeResult(
      { ok: false, code: 'execution_failed', error: big, cause: { huge: big } },
      100,
    );
    expect(out).not.toHaveProperty('cause');
    expect(out.ok === false && out.error.length).toBeLessThan(200);
    const na = capNodeResult({ ok: false, code: 'not_available', error: 'e', reason: big }, 100);
    expect(na.ok === false && 'reason' in na && (na.reason ?? '').length).toBeLessThan(200);
    const inv = capNodeResult({ ok: false, code: 'input_invalid', error: 'e', field: big }, 100);
    expect(inv.ok === false && 'field' in inv && (inv.field ?? '').length).toBeLessThan(200);
    const st = capNodeResult({ ok: false, code: 'STALE_WRITE', error: 'e', conflictKey: big }, 100);
    expect(st.ok === false && 'conflictKey' in st && (st.conflictKey ?? '').length).toBeLessThan(
      200,
    );
  });

  it('closes 1008 on a bad server frame and pongs a ping', () => {
    const c = makeClient(async () => ({ ok: true, value: '' }));
    c.start();
    const s = sockets[0] as FakeSocket;
    s.h.onOpen();
    push(s, { v: 1, kind: 'ping', at: 9 });
    expect(frames(s).at(-1)).toEqual({ v: 1, kind: 'pong', at: 9 });
    s.h.onText('{"v":1,"kind":"exec"}');
    expect(s.closed?.code).toBe(1008);
  });

  it('does not reconnect after close 4000 (replaced)', async () => {
    const c = makeClient(async () => ({ ok: true, value: '' }));
    c.start();
    (sockets[0] as FakeSocket).h.onOpen();
    (sockets[0] as FakeSocket).h.onClose(4000, 'replaced');
    expect(c.status).toBe('replaced');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('does not reconnect after close 4401 (key revoked while connected)', async () => {
    const c = makeClient(async () => ({ ok: true, value: '' }));
    c.start();
    (sockets[0] as FakeSocket).h.onOpen();
    (sockets[0] as FakeSocket).h.onClose(4401, 'key revoked');
    expect(c.status).toBe('unauthorized');
    expect(statuses).not.toContain('disconnected');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('does not reconnect after a 401 upgrade', async () => {
    const c = makeClient(async () => ({ ok: true, value: '' }));
    c.start();
    const s = sockets[0] as FakeSocket;
    s.h.onUnexpectedResponse(401);
    s.h.onClose(1006, '');
    expect(c.status).toBe('unauthorized');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('reconnects after other closes with backoff, resetting after an open; newConnection per socket', async () => {
    const spy = vi.spyOn(guard, 'newConnection');
    const c = makeClient(async () => ({ ok: true, value: '' }));
    c.start();
    (sockets[0] as FakeSocket).h.onClose(1006, '');
    expect(c.status).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(2);
    (sockets[1] as FakeSocket).h.onClose(1006, '');
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(3);
    (sockets[2] as FakeSocket).h.onOpen();
    (sockets[2] as FakeSocket).h.onClose(1006, '');
    await vi.advanceTimersByTimeAsync(1001);
    expect(sockets).toHaveLength(4);
    expect(spy).toHaveBeenCalledTimes(1);
    (sockets[3] as FakeSocket).h.onOpen();
    expect(spy).toHaveBeenCalledTimes(2);
    await c.stop();
    expect(c.status).toBe('stopped');
  });

  it('refuses a cleartext non-loopback url at construction', () => {
    expect(() => makeClient(async () => ({ ok: true, value: '' }), 'http://example.com')).toThrow(
      NodeUrlError,
    );
  });
});

describe('pairNode', () => {
  const roots = [{ path: '/p', readOnly: false }];
  const server = (s: FakeSocket, f: object) => s.h.onText(JSON.stringify({ v: 1, ...f }));

  it('requests, surfaces the code, and resolves the key on approval (no auth header)', async () => {
    const onCode = vi.fn();
    const p = pairNode({
      url: 'https://ethos.example.com',
      name: 'lap',
      roots,
      socketFactory: factory,
      onCode,
    });
    const s = sockets[0] as FakeSocket;
    expect(s.url).toBe('wss://ethos.example.com/node/pair');
    expect(s.init.headers).toBeUndefined();
    s.h.onOpen();
    expect(JSON.parse(s.sent[0] ?? '')).toMatchObject({
      v: 1,
      kind: 'pair_request',
      name: 'lap',
      roots,
    });
    server(s, { kind: 'pair_pending', code: 'ABCD2345', expiresAt: 99 });
    expect(onCode).toHaveBeenCalledWith('ABCD2345', 99);
    server(s, { kind: 'pair_approved', key: 'sk-ethos-new', keyId: 'kid' });
    await expect(p).resolves.toEqual({ key: 'sk-ethos-new', keyId: 'kid' });
  });

  it('rejects on pair_refused and on close', async () => {
    const p1 = pairNode({
      url: 'http://127.0.0.1:3000',
      name: 'lap',
      roots,
      socketFactory: factory,
      onCode: () => {},
    });
    const a = sockets[0] as FakeSocket;
    a.h.onOpen();
    server(a, { kind: 'pair_refused', reason: 'expired' });
    await expect(p1).rejects.toThrow('expired');
    const p2 = pairNode({
      url: 'http://127.0.0.1:3000',
      name: 'lap',
      roots,
      socketFactory: factory,
      onCode: () => {},
    });
    const b = sockets[1] as FakeSocket;
    b.h.onOpen();
    b.h.onClose(1006, '');
    await expect(p2).rejects.toThrow();
  });
});
