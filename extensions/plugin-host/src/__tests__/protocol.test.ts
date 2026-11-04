import { describe, expect, it } from 'vitest';
import { HostConnection, RequestTimeoutError, RpcError } from '../connection';
import {
  HOST_TO_PARENT_KIND,
  LineCodec,
  MAX_FRAME_BYTES,
  PARENT_TO_HOST_KIND,
  ProtocolViolation,
  type RpcMessage,
} from '../protocol';
import { callTool, eventsOf, fixtureDir, isAlive, makeHarness, waitFor } from './helpers/harness';

function sample(method: string, kind: 'request' | 'notification', id: number): RpcMessage {
  const params = { sample: method, nested: { n: 1, list: ['é', '日本'] } };
  return kind === 'request'
    ? { jsonrpc: '2.0', id, method, params }
    : { jsonrpc: '2.0', method, params };
}

describe('LineCodec', () => {
  const all = [...Object.entries(PARENT_TO_HOST_KIND), ...Object.entries(HOST_TO_PARENT_KIND)];

  it('round-trips every method in both tables, including split chunks', () => {
    expect(all.length).toBeGreaterThan(30);
    all.forEach(([method, kind], i) => {
      const msg = sample(method, kind, i + 1);
      const wire = Buffer.from(LineCodec.encode(msg));
      const codec = new LineCodec();
      // Feed one byte at a time: framing must not depend on chunk boundaries.
      const out: RpcMessage[] = [];
      for (const byte of wire) out.push(...codec.push(Buffer.from([byte])));
      expect(out).toEqual([msg]);
    });
  });

  it('encodes notifications without an id and requests with one', () => {
    for (const [method, kind] of all) {
      const line = JSON.parse(LineCodec.encode(sample(method, kind, 7)));
      expect('id' in line).toBe(kind === 'request');
    }
  });

  it('returns several messages from one chunk and ignores blank lines', () => {
    const a = sample('ethos/ping', 'request', 1);
    const b = sample('ethos/log', 'notification', 0);
    const chunk = `${LineCodec.encode(a)}\n${LineCodec.encode(b)}`;
    expect(new LineCodec().push(chunk)).toEqual([a, b]);
  });

  it('treats a malformed line as a protocol violation', () => {
    expect(() => new LineCodec().push('not json\n')).toThrow(ProtocolViolation);
    expect(() => new LineCodec().push('{"jsonrpc":"1.0","method":"x"}\n')).toThrow(
      ProtocolViolation,
    );
    expect(() => new LineCodec().push('{"jsonrpc":"2.0","id":"a","method":"x"}\n')).toThrow(
      ProtocolViolation,
    );
    expect(() => new LineCodec().push('{"jsonrpc":"2.0","id":1}\n')).toThrow(ProtocolViolation);
  });

  it('treats a frame over the limit as a protocol violation, with or without a newline', () => {
    const small = new LineCodec(64);
    expect(() => small.push(`${'x'.repeat(100)}\n`)).toThrow(/exceeds 64 bytes/);
    expect(() => new LineCodec(64).push('y'.repeat(100))).toThrow(/exceeds 64 bytes/);
    expect(() =>
      LineCodec.encode({ jsonrpc: '2.0', method: 'm', params: 'z'.repeat(100) }, 64),
    ).toThrow(ProtocolViolation);
    expect(MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('HostConnection', () => {
  function make(handlers = {}) {
    const written: string[] = [];
    const violations: string[] = [];
    const conn = new HostConnection({
      write: (line) => void written.push(line),
      handlers,
      onViolation: (r) => void violations.push(r),
    });
    const feed = (msg: object) => conn.feed(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    return { conn, written, violations, feed };
  }

  it('correlates responses by id and issues ids per connection', async () => {
    const { conn, written, feed } = make();
    const p1 = conn.request('ethos/ping', {});
    const p2 = conn.request('ethos/ping', {});
    expect(written.map((l) => JSON.parse(l).id)).toEqual([1, 2]);
    feed({ id: 2, result: 'two' });
    feed({ id: 1, result: 'one' });
    await expect(p1).resolves.toBe('one');
    await expect(p2).resolves.toBe('two');
  });

  it('drops and counts a response id it never issued', async () => {
    const { conn, feed } = make();
    const p = conn.request('ethos/ping', {});
    feed({ id: 999, result: 'forged' });
    expect(conn.stats).toMatchObject({ strayResponses: 1, duplicateResponses: 0 });
    feed({ id: 1, result: 'real' });
    await expect(p).resolves.toBe('real');
  });

  it('drops and counts a duplicate response', async () => {
    const { conn, feed } = make();
    const p = conn.request('ethos/ping', {});
    feed({ id: 1, result: 'first' });
    feed({ id: 1, result: 'second' });
    await expect(p).resolves.toBe('first');
    expect(conn.stats).toMatchObject({ strayResponses: 0, duplicateResponses: 1 });
  });

  it('turns an error response into an RpcError and a missing handler into method-not-found', async () => {
    const { conn, written, feed } = make({ 'ethos/log': async () => 'handled' });
    const p = conn.request('ethos/ping', {});
    feed({ id: 1, error: { code: -32000, message: 'nope' } });
    await expect(p).rejects.toBeInstanceOf(RpcError);
    feed({ id: 5, method: 'ethos/secrets.get', params: { ref: 'x' } });
    await waitFor(() => written.length >= 2);
    expect(JSON.parse(written[1] ?? '{}')).toMatchObject({ id: 5, error: { code: -32601 } });
    feed({ id: 6, method: 'ethos/log', params: {} });
    await waitFor(() => written.length >= 3);
    expect(JSON.parse(written[2] ?? '{}')).toMatchObject({ id: 6, result: 'handled' });
  });

  it('times out a request and counts its late answer as a duplicate', async () => {
    const { conn, feed } = make();
    await expect(conn.request('ethos/ping', {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      RequestTimeoutError,
    );
    feed({ id: 1, result: 'late' });
    expect(conn.stats.duplicateResponses).toBe(1);
  });

  it('reports a violation once and ignores input afterwards', () => {
    const { conn, violations } = make();
    conn.feed('garbage\n');
    conn.feed('more garbage\n');
    expect(violations).toHaveLength(1);
    expect(conn.stats.violations).toBe(1);
  });
});

describe('protocol violations against a live host', () => {
  it('a malformed line kills the host', async () => {
    const h = await makeHarness({ mockMode: 'garbage' });
    try {
      await expect(h.pool.acquire({ id: 'bad', dir: '/unused' })).rejects.toThrow();
      const denied = eventsOf(h, 'plugin_host.denied');
      expect(denied[0]?.payload).toMatchObject({ kind: 'protocol', ref: 'malformed JSON line' });
    } finally {
      await h.cleanup();
    }
  });

  it('a frame over 8 MiB kills the host', async () => {
    const h = await makeHarness({ mockMode: 'oversize' });
    try {
      await expect(h.pool.acquire({ id: 'big', dir: '/unused' })).rejects.toThrow();
      const denied = eventsOf(h, 'plugin_host.denied');
      expect(String(denied[0]?.payload.ref)).toMatch(/exceeds 8388608 bytes/);
    } finally {
      await h.cleanup();
    }
  });

  it('stray and duplicate responses from a live host are dropped and counted', async () => {
    const h = await makeHarness({ mockMode: 'dup' });
    try {
      const lease = await h.pool.acquire({ id: 'dup', dir: '/unused' });
      await waitFor(() => (h.pool.entry('dup')?.connectionStats?.strayResponses ?? 0) > 0);
      expect(h.pool.entry('dup')?.connectionStats).toMatchObject({
        strayResponses: 1,
        duplicateResponses: 1,
        violations: 0,
      });
      expect(await callTool(lease, 't')).toEqual({ ok: true, value: 'mock-ok' });
    } finally {
      await h.cleanup();
    }
  });

  it('plugin console.log lands on stderr and every stdout line still parses', async () => {
    const h = await makeHarness();
    try {
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      expect(await callTool(lease, 'echo_log')).toEqual({ ok: true, value: 'logged' });
      await waitFor(() => h.debugLines.some((l) => l.includes('hello from plugin stdout')));
      expect(h.debugLines.some((l) => l.includes('hello from plugin stderr'))).toBe(true);
      expect(h.pool.entry('echo')?.connectionStats).toMatchObject({ violations: 0 });
      expect(isAlive(h.pool.pidOf('echo'))).toBe(true);
    } finally {
      await h.cleanup();
    }
  }, 30_000);
});
