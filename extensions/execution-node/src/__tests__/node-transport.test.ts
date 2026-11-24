/**
 * NodeHub + NodeToolTransport (plan laptop-tool-node T4). This file is the pin for
 * "a call is never retried" (the 'drop mid-call' case: exactly one `call` frame) and for
 * "the newer connection wins" (the 'eviction' case).
 */
import type { ToolResult } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelloFrame } from '../frames';
import { NODE_DISCONNECTED } from '../frames';
import { NodeHub } from '../node-hub';
import { NodeToolTransport } from '../node-tool-transport';
import { fakeConn, makeHello, makeRequest } from './fixtures';

const T0 = Date.parse('2026-11-24T10:00:00.000Z');

const hello = (name: string, over: Partial<HelloFrame> = {}): HelloFrame =>
  makeHello({ name, clock: T0, ...over });
const request = makeRequest;
let n = 0;
function makeHub(now: () => number = () => T0) {
  n = 0;
  return new NodeHub({ now, randomId: () => `id${++n}` });
}
const ok = (value: string): ToolResult => ({ ok: true, value });

afterEach(() => vi.useRealTimers());

describe('NodeHub offline', () => {
  it('reports node_offline with name and last seen', async () => {
    const hub = makeHub();
    const s = hub.attach('k1', hello('lap'), fakeConn());
    s.detach();
    const p = hub.pick({ node: 'lap' });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.result).toMatchObject({ ok: false, code: 'not_available', reason: 'node_offline' });
      if (!p.result.ok) {
        expect(p.result.error).toContain('lap');
        expect(p.result.error).toContain(new Date(T0).toISOString());
      }
    }
    const r = await new NodeToolTransport(hub, { node: 'lap', timeoutMs: 1000 }).execute(
      request(),
      new AbortController().signal,
    );
    expect(r).toMatchObject({ ok: false, code: 'not_available', reason: 'node_offline' });
  });
});

describe('NodeHub calls', () => {
  it('resolves a result frame and ignores an unknown callId', async () => {
    const hub = makeHub();
    const conn = fakeConn();
    const s = hub.attach('k1', hello('lap'), conn);
    const p = s.call(request(), { signal: new AbortController().signal, timeoutMs: 1000 });
    const frame = conn.sent[0];
    expect(frame?.kind).toBe('call');
    s.receive({ v: 1, kind: 'result', callId: 'nope', result: ok('x') });
    s.receive({ v: 1, kind: 'result', callId: 'id1', result: ok('hello') });
    await expect(p).resolves.toEqual(ok('hello'));
  });

  it('delivers progress in order and answers ping with pong', async () => {
    const hub = makeHub();
    const conn = fakeConn();
    const s = hub.attach('k1', hello('lap'), conn);
    const seen: string[] = [];
    const p = s.call(request(), {
      signal: new AbortController().signal,
      timeoutMs: 1000,
      onProgress: (m) => seen.push(m),
    });
    s.receive({ v: 1, kind: 'progress', callId: 'id1', message: 'a' });
    s.receive({ v: 1, kind: 'progress', callId: 'id1', message: 'b', audience: 'user' });
    s.receive({ v: 1, kind: 'ping', at: 5 });
    expect(seen).toEqual(['a', 'b']);
    expect(conn.sent.at(-1)).toEqual({ v: 1, kind: 'pong', at: 5 });
    s.receive({ v: 1, kind: 'result', callId: 'id1', result: ok('x') });
    await p;
  });

  it('a mid-call drop fails with node_disconnected and never retries', async () => {
    const hub = makeHub();
    const conn = fakeConn();
    const s = hub.attach('k1', hello('lap'), conn);
    const p = new NodeToolTransport(hub, { node: 'lap', timeoutMs: 1000 }).execute(
      request(),
      new AbortController().signal,
    );
    s.detach();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('execution_failed');
      expect(r.error.startsWith(NODE_DISCONNECTED)).toBe(true);
    }
    expect(conn.sent.filter((f) => f.kind === 'call')).toHaveLength(1);
  });

  it('abort sends one cancel and resolves aborted', async () => {
    const hub = makeHub();
    const conn = fakeConn();
    const s = hub.attach('k1', hello('lap'), conn);
    const ac = new AbortController();
    const p = s.call(request(), { signal: ac.signal, timeoutMs: 1000 });
    ac.abort();
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: 'execution_failed' });
    if (!r.ok) expect(r.error).toContain('aborted');
    expect(conn.sent.filter((f) => f.kind === 'cancel')).toEqual([
      { v: 1, kind: 'cancel', callId: 'id1' },
    ]);
  });

  it('stamps the deadline on the node clock: now + skew + timeout + 5000', () => {
    const hub = makeHub();
    const conn = fakeConn();
    const s = hub.attach('k1', hello('lap', { clock: T0 + 7000 }), conn);
    void s.call(request(), { signal: new AbortController().signal, timeoutMs: 2000 });
    const f = conn.sent[0];
    expect(f?.kind === 'call' && f.deadline).toBe(T0 + 7000 + 2000 + 5000);
  });

  it('times out at timeoutMs + 5000 with a cancel', async () => {
    vi.useFakeTimers();
    const hub = makeHub();
    const conn = fakeConn();
    const s = hub.attach('k1', hello('lap'), conn);
    const p = s.call(request(), { signal: new AbortController().signal, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(5999);
    expect(conn.sent.some((f) => f.kind === 'cancel')).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('timed out');
    expect(conn.sent.filter((f) => f.kind === 'cancel')).toHaveLength(1);
  });
});

describe('NodeHub eviction and selection', () => {
  it('a second attach for the same key closes the first with 4000 and fails its calls', async () => {
    const hub = makeHub();
    const c1 = fakeConn();
    const s1 = hub.attach('k1', hello('lap'), c1);
    const p = s1.call(request(), { signal: new AbortController().signal, timeoutMs: 1000 });
    const c2 = fakeConn();
    hub.attach('k1', hello('lap'), c2);
    expect(c1.closed?.code).toBe(4000);
    const r = await p;
    expect(!r.ok && r.error.startsWith(NODE_DISCONNECTED)).toBe(true);
    const entries = hub.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.online).toBe(true);
    expect(entries[0]?.replacedAt).toBe(new Date(T0).toISOString());
    // The evicted session's late detach must not take the new connection offline.
    s1.detach();
    expect(hub.list()[0]?.online).toBe(true);
  });

  it('zero candidates lists known names', async () => {
    const hub = makeHub();
    hub.attach('k1', hello('lap'), fakeConn()).detach();
    const p = hub.pick({ personalityId: 'coder' });
    expect(!p.ok && !p.result.ok && p.result.code).toBe('not_available');
    expect(!p.ok && !p.result.ok && p.result.error).toContain('lap');
    // D11 (verification m5): an offline candidate carries its last-seen time.
    expect(!p.ok && !p.result.ok && p.result.error).toContain(
      `'lap' (offline, last seen ${new Date(T0).toISOString()})`,
    );
  });

  it('two online candidates without a node arg is input_invalid naming both', () => {
    const hub = makeHub();
    hub.attach('k1', hello('lap'), fakeConn());
    hub.attach('k2', hello('desk'), fakeConn());
    const p = hub.pick({ personalityId: 'coder' });
    expect(p.ok).toBe(false);
    if (!p.ok && !p.result.ok) {
      expect(p.result.code).toBe('input_invalid');
      expect(p.result.error).toContain('lap');
      expect(p.result.error).toContain('desk');
    }
    expect(hub.pick({ personalityId: 'coder', node: 'desk' }).ok).toBe(true);
  });

  it('refuses an explicit node name shared by several keys, listing key ids', () => {
    const hub = makeHub();
    hub.attach('key-aaa', hello('lap'), fakeConn());
    hub.attach('key-bbb', hello('lap'), fakeConn());
    const p = hub.pick({ personalityId: 'coder', node: 'lap' });
    expect(p.ok).toBe(false);
    if (!p.ok && !p.result.ok) {
      expect(p.result.code).toBe('input_invalid');
      expect(p.result.error).toContain('key-aaa');
      expect(p.result.error).toContain('key-bbb');
    }
  });

  it('honours the personality allowlist, with * matching an undefined personality', () => {
    const hub = makeHub();
    hub.attach('k1', hello('coderbox', { personalities: ['coder'] }), fakeConn());
    expect(hub.pick({ personalityId: 'writer' }).ok).toBe(false);
    expect(hub.pick({ personalityId: 'coder' }).ok).toBe(true);
    expect(hub.pick({}).ok).toBe(false);
    const hub2 = makeHub();
    hub2.attach('k1', hello('any'), fakeConn());
    expect(hub2.pick({}).ok).toBe(true);
  });

  it('list puts online nodes first', () => {
    const hub = makeHub();
    hub.attach('k1', hello('old'), fakeConn()).detach();
    hub.attach('k2', hello('new'), fakeConn());
    expect(hub.list().map((e) => e.name)).toEqual(['new', 'old']);
  });

  // Verification M5: revoke -> re-pair leaves exactly one entry under the name.
  it('a new key for a name drops the offline entry the old key left behind', () => {
    const hub = makeHub();
    hub.attach('key-old', hello('lap'), fakeConn()).detach();
    hub.attach('key-new', hello('lap'), fakeConn());
    const p = hub.pick({ personalityId: 'coder', node: 'lap' });
    expect(p.ok).toBe(true);
    expect(hub.list().map((e) => `${e.name}:${e.keyId}`)).toEqual(['lap:key-new']);
  });

  it('keeps an ONLINE same-name entry under another key (duplicates stay refused)', () => {
    const hub = makeHub();
    hub.attach('key-a', hello('lap'), fakeConn());
    hub.attach('key-b', hello('lap'), fakeConn());
    expect(hub.list()).toHaveLength(2);
  });

  it('forget drops an offline entry (revoked key) but never an online one', () => {
    const hub = makeHub();
    const s = hub.attach('key-old', hello('lap'), fakeConn());
    hub.forget('key-old');
    expect(hub.list()).toHaveLength(1); // still online
    s.detach();
    hub.forget('key-old');
    expect(hub.list()).toEqual([]);
  });
});
