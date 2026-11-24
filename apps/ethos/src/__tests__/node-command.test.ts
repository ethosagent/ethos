// plan laptop-tool-node T9 (brief D2): `ethos node connect | list | approve | revoke`.
// Everything is injected through NodeCommandDeps: an in-memory Storage/SecretsResolver, a fake
// socket factory and a fake fetch. The real-socket proof is
// apps/web-api/src/node/__tests__/node-e2e.test.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import {
  decodeNodeFrame,
  encodeFrame,
  type NodeSocketFactory,
  type NodeSocketHandlers,
  nodeKeyRef,
  readNodeState,
} from '@ethosagent/wiring/nodes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NodeCommandDeps, runNode } from '../commands/node';
import { createTtyApproval } from '../lib/node-tty';

const SERVER = 'http://127.0.0.1:3000';
const STATE_DIR = '/state';

interface FakeSock {
  url: string;
  headers: Record<string, string> | undefined;
  h: NodeSocketHandlers;
  sent: string[];
}

/** Fake `ws`: pair sockets answer themselves; node sockets are driven by the test. */
function makeNet(pairKey = 'sk-ethos-PAIREDKEY') {
  const sockets: FakeSock[] = [];
  const factory: NodeSocketFactory = (url, init, h) => {
    const s: FakeSock = { url, headers: init.headers, h, sent: [] };
    sockets.push(s);
    const isPair = url.endsWith('/node/pair');
    if (isPair) queueMicrotask(() => h.onOpen());
    return {
      send: (text) => {
        s.sent.push(text);
        if (isPair) {
          h.onText(encodeFrame({ v: 1, kind: 'pair_pending', code: 'ABCD2345', expiresAt: 1 }));
          h.onText(encodeFrame({ v: 1, kind: 'pair_approved', key: pairKey, keyId: 'id1' }));
        }
      },
      close: (code) => queueMicrotask(() => h.onClose(code ?? 1000, '')),
    };
  };
  return {
    sockets,
    factory,
    nodeSockets: () => sockets.filter((s) => s.url.endsWith('/node/ws')),
    pairSockets: () => sockets.filter((s) => s.url.endsWith('/node/pair')),
  };
}

let storage: InMemoryStorage;
let secrets: InMemorySecretsResolver;
let out: string[];
let err: string[];
let stop: (() => Promise<void>) | undefined;
let net: ReturnType<typeof makeNet>;

function deps(over: Partial<NodeCommandDeps> = {}): Partial<NodeCommandDeps> {
  return {
    storage,
    secrets,
    stateDir: STATE_DIR,
    dataDir: STATE_DIR,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    socketFactory: net.factory,
    random: () => 1,
    webToken: async () => 'tok123',
    defaultServerUrl: async () => SERVER,
    onSignal: (s) => {
      stop = s;
    },
    ...over,
  };
}

const text = (lines: string[]) => lines.join('');
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function until(pred: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(pred()).toBe(true), { timeout: 2000, interval: 5 });
}
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof EthosError) return e.code;
    throw e;
  }
  return 'none';
}

beforeEach(async () => {
  storage = new InMemoryStorage();
  secrets = new InMemorySecretsResolver();
  out = [];
  err = [];
  stop = undefined;
  net = makeNet();
  await storage.mkdir('/work/a');
  await storage.mkdir('/work/b');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('node connect: url policy', () => {
  it('refuses cleartext to a non-loopback host before anything is stored or dialled', async () => {
    for (const url of ['ws://example.com', 'http://10.1.2.3:3000']) {
      expect(await code(runNode(['connect', url, '--root', '/work/a'], deps()))).toBe(
        'INVALID_INPUT',
      );
    }
    expect(await secrets.list()).toEqual([]);
    expect(await readNodeState(storage, STATE_DIR)).toBeNull();
    expect(net.sockets).toEqual([]);
  });
});

describe('node connect: pairing and key', () => {
  it('pairs when no key is stored, stores it at nodeKeyRef and dials with it', async () => {
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    expect(text(out)).toContain('ABCD2345');
    expect(text(out)).toContain('ethos node approve ABCD2345');
    expect(await secrets.get(nodeKeyRef(SERVER))).toBe('sk-ethos-PAIREDKEY');
    const sock = net.nodeSockets()[0];
    expect(sock?.url).toBe('ws://127.0.0.1:3000/node/ws');
    expect(sock?.headers).toEqual({ Authorization: 'Bearer sk-ethos-PAIREDKEY' });
    sock?.h.onOpen();
    const hello = decodeNodeFrame(sock?.sent[0] ?? '');
    expect(hello.ok && hello.frame.kind === 'hello' && hello.frame.name).toBe('lap');
    await stop?.();
    await expect(p).resolves.toBe(0);
  });

  it('reuses a stored key without pairing; --pair forces pairing again', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-STORED');
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    expect(net.pairSockets()).toHaveLength(0);
    expect(net.nodeSockets()[0]?.headers).toEqual({ Authorization: 'Bearer sk-ethos-STORED' });
    await stop?.();
    await p;

    net = makeNet('sk-ethos-REPAIRED');
    const p2 = runNode(['connect', SERVER, '--pair'], deps());
    await until(() => net.nodeSockets().length === 1);
    expect(net.pairSockets()).toHaveLength(1);
    expect(net.nodeSockets()[0]?.headers).toEqual({ Authorization: 'Bearer sk-ethos-REPAIRED' });
    await stop?.();
    await p2;
  });
});

describe('node connect: state', () => {
  it('saves flags through writeNodeState and a bare connect reuses them', async () => {
    const p = runNode(
      [
        'connect',
        SERVER,
        '--root',
        '/work/a',
        '--root',
        '/work/b:ro',
        '--name',
        'lap',
        '--personality',
        'coder',
        '--allow-terminal',
        '--writes',
        'auto',
      ],
      deps(),
    );
    await until(() => net.nodeSockets().length === 1);
    const saved = await readNodeState(storage, STATE_DIR);
    expect(saved).toEqual({
      server: SERVER,
      name: 'lap',
      roots: [
        { path: '/work/a', readOnly: false },
        { path: '/work/b', readOnly: true },
      ],
      personalities: ['coder'],
      allowTerminal: true,
      writes: 'auto',
      allowUnattended: false,
    });
    await stop?.();
    await p;

    net = makeNet();
    const p2 = runNode(['connect', SERVER], deps());
    await until(() => net.nodeSockets().length === 1);
    net.nodeSockets()[0]?.h.onOpen();
    const hello = decodeNodeFrame(net.nodeSockets()[0]?.sent[0] ?? '');
    if (!hello.ok || hello.frame.kind !== 'hello') throw new Error('no hello');
    expect(hello.frame.name).toBe('lap');
    expect(hello.frame.personalities).toEqual(['coder']);
    expect(hello.frame.roots).toHaveLength(2);
    expect(hello.frame.tools).toContain('terminal');
    await stop?.();
    await p2;
  });

  // Verification m1: saved allow-* flags must be revocable, and the effective policy is shown.
  it('--no-allow-terminal and --no-allow-unattended clear saved state; the policy line says so', async () => {
    const p = runNode(
      ['connect', SERVER, '--root', '/work/a', '--root', '/work/b:ro', '--name', 'lap'].concat([
        '--allow-terminal',
        '--allow-unattended',
      ]),
      deps(),
    );
    await until(() => net.nodeSockets().length === 1);
    const first = text(out);
    expect(first).toContain('policy:');
    expect(first).toContain('/work/a');
    expect(first).toContain('/work/b (read-only)');
    expect(first).toContain('writes ask');
    expect(first).toContain('terminal ON');
    expect(first).toContain('unattended ON');
    expect(first).toContain('personalities *');
    await stop?.();
    await p;

    net = makeNet();
    out.length = 0;
    const p2 = runNode(['connect', SERVER, '--no-allow-terminal', '--no-allow-unattended'], deps());
    await until(() => net.nodeSockets().length === 1);
    const saved = await readNodeState(storage, STATE_DIR);
    expect(saved).toMatchObject({ allowTerminal: false, allowUnattended: false });
    expect(text(out)).toContain('terminal off');
    expect(text(out)).toContain('unattended off');
    await stop?.();
    await p2;
  });

  it('a root that does not exist is INVALID_INPUT and nothing is dialled', async () => {
    expect(await code(runNode(['connect', SERVER, '--root', '/work/missing'], deps()))).toBe(
      'INVALID_INPUT',
    );
    expect(net.sockets).toEqual([]);
  });

  it('no root and no saved state is INVALID_INPUT', async () => {
    expect(await code(runNode(['connect', SERVER], deps()))).toBe('INVALID_INPUT');
  });
});

describe('node connect: terminal statuses and backoff', () => {
  it('unauthorized prints the re-pair line, deletes the key and exits 1', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-REVOKED');
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    net.nodeSockets()[0]?.h.onUnexpectedResponse(401);
    await expect(p).resolves.toBe(1);
    expect(text(err)).toContain(
      `key revoked or unknown — re-pair with \`ethos node connect ${SERVER} --pair\``,
    );
    expect(await secrets.get(nodeKeyRef(SERVER))).toBeNull();
  });

  it('a 4401 close (key revoked while connected) deletes the key and exits 1, no redial', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-REVOKED');
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    const s = net.nodeSockets()[0];
    s?.h.onOpen();
    s?.h.onClose(4401, 'key revoked');
    await expect(p).resolves.toBe(1);
    expect(text(err)).toContain('key revoked or unknown');
    expect(net.nodeSockets()).toHaveLength(1);
    expect(await secrets.get(nodeKeyRef(SERVER))).toBeNull();
  });

  // Live smoke 2026-11-24: the approval reader resumes stdin for the whole session and nothing
  // paused it again, so a revoked node printed its message and then the process hung.
  it('releases stdin when connect ends so the process can exit', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-REVOKED');
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps({ stdin }));
    await until(() => net.nodeSockets().length === 1);
    expect(stdin.isPaused()).toBe(false);
    net.nodeSockets()[0]?.h.onUnexpectedResponse(401);
    await expect(p).resolves.toBe(1);
    expect(stdin.isPaused()).toBe(true);
  });

  it('replaced prints the D-REPLACED sentence and exits 1', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-K');
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    const s = net.nodeSockets()[0];
    s?.h.onOpen();
    s?.h.onClose(4000, 'replaced');
    await expect(p).resolves.toBe(1);
    expect(text(err)).toContain('replaced by another connection using this key');
    expect(text(err)).toContain('ethos node revoke');
    expect(await secrets.get(nodeKeyRef(SERVER))).toBe('sk-ethos-K');
  });

  it('prints "retrying in 1s" then "retrying in 2s" after two drops', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-K');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await vi.waitFor(() => expect(net.nodeSockets()).toHaveLength(1));
    const first = net.nodeSockets()[0];
    first?.h.onOpen();
    first?.h.onClose(1006, '');
    expect(text(out)).toContain('retrying in 1s');
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.nodeSockets()).toHaveLength(2);
    net.nodeSockets()[1]?.h.onClose(1006, '');
    expect(text(out)).toContain('retrying in 2s');
    await stop?.();
    await flush();
    await expect(p).resolves.toBe(0);
  });
});

describe('node approve | list', () => {
  const okFetch = (status: number, body: unknown) =>
    vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
    );

  it('approve POSTs the code with the cookie and Origin', async () => {
    const fetch = okFetch(200, { ok: true, name: 'lap', keyId: 'k1' });
    await expect(runNode(['approve', 'ABCD2345'], deps({ fetch }))).resolves.toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init = {}] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${SERVER}/node/admin/approve`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Cookie: 'ethos_auth=tok123',
      Origin: SERVER,
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe('{"code":"ABCD2345"}');
    expect(text(out)).toContain('lap');
  });

  it('maps 404 to NOT_FOUND and 410 to INVALID_INPUT "expired"', async () => {
    expect(
      await code(
        runNode(
          ['approve', 'X'],
          deps({ fetch: okFetch(404, { ok: false, reason: 'unknown_code' }) }),
        ),
      ),
    ).toBe('NOT_FOUND');
    const expired = runNode(
      ['approve', 'X'],
      deps({ fetch: okFetch(410, { ok: false, reason: 'expired' }) }),
    );
    await expect(expired).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(expired).rejects.toThrow(/expired/);
  });

  it('a 404 without the approve-result body (nodes disabled) is NETWORK_ERROR, not NOT_FOUND', async () => {
    expect(
      await code(runNode(['approve', 'X'], deps({ fetch: okFetch(404, { error: 'x' }) }))),
    ).toBe('NETWORK_ERROR');
  });

  it('a connection error is NETWORK_ERROR naming the URL and the nodes.enabled hint', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const p = runNode(['approve', 'X', '--url', 'http://127.0.0.1:9'], deps({ fetch }));
    await expect(p).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(p).rejects.toThrow(/http:\/\/127\.0\.0\.1:9/);
    await expect(p).rejects.toThrow(/is `ethos boot` running with nodes\.enabled: true\?/);
  });

  it('list --json prints the decoded body; a malformed body is NETWORK_ERROR', async () => {
    const body = {
      nodes: [
        {
          name: 'lap',
          keyId: 'k1',
          online: true,
          roots: [{ path: '/work/a', readOnly: false }],
          tools: ['read_file'],
          personalities: ['*'],
          lastSeen: '2026-11-24T00:00:00.000Z',
        },
      ],
      pending: [],
    };
    const fetch = okFetch(200, body);
    await expect(runNode(['list', '--json'], deps({ fetch }))).resolves.toBe(0);
    expect(JSON.parse(text(out))).toEqual(body);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${SERVER}/node/admin/list`);

    const bad = runNode(['list'], deps({ fetch: okFetch(200, { nodes: 'nope' }) }));
    await expect(bad).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(bad).rejects.toThrow(`unexpected response from ${SERVER}/node/admin/list`);
  });
});

describe('node approve | list: server deployments', () => {
  const okFetch = (status: number, body: unknown) =>
    vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
    );
  const listBody = {
    nodes: [
      {
        name: 'lap\u001b[31m',
        keyId: 'k1',
        online: true,
        roots: [{ path: '/work/a\n[fake] line\u202e', readOnly: true }],
        tools: [],
        personalities: ['*'],
        lastSeen: '2026-11-24T00:00:00.000Z',
      },
    ],
    pending: [{ code: 'ABCD2345', name: 'x\ny', roots: [], expiresAt: 1 }],
  };

  // Verification M3(b): same token source as boot (WebTokenRepository with envToken).
  it('uses ETHOS_WEB_TOKEN when set instead of minting a web-token file', async () => {
    vi.stubEnv('ETHOS_WEB_TOKEN', 'e'.repeat(40));
    try {
      const fetch = okFetch(200, { nodes: [], pending: [] });
      const { webToken: _drop, ...rest } = deps({ fetch });
      await expect(runNode(['list'], rest)).resolves.toBe(0);
      expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
        Cookie: `ethos_auth=${'e'.repeat(40)}`,
      });
      expect(await storage.exists(`${STATE_DIR}/web-token`)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Verification M3(a): behind an explicit allow-list the loopback Origin is CSRF-refused.
  it('sends the first explicit allowed origin as Origin, skipping wildcards', async () => {
    vi.stubEnv(
      'ETHOS_ALLOWED_ORIGINS',
      '*.example.com, https://ethos.example.com ,https://b.example',
    );
    try {
      const fetch = okFetch(200, { ok: true, name: 'lap', keyId: 'k1' });
      await runNode(['approve', 'ABCD2345'], deps({ fetch }));
      expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
        Origin: 'https://ethos.example.com',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the loopback Origin when no explicit allow-list is set', async () => {
    vi.stubEnv('ETHOS_ALLOWED_ORIGINS', '');
    try {
      const fetch = okFetch(200, { nodes: [], pending: [] });
      await runNode(['list'], deps({ fetch }));
      expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Origin: SERVER });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('maps 401 and 403 to UNAUTHORIZED carrying the server message', async () => {
    for (const status of [401, 403]) {
      const p = runNode(
        ['approve', 'X'],
        deps({
          fetch: okFetch(status, {
            ok: false,
            code: 'UNAUTHORIZED',
            error: 'Cross-origin request from http://127.0.0.1:3000 blocked',
          }),
        }),
      );
      await expect(p).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(p).rejects.toThrow(/Cross-origin request/);
    }
    expect(await code(runNode(['list'], deps({ fetch: okFetch(401, { nothing: true }) })))).toBe(
      'UNAUTHORIZED',
    );
  });

  it('approve reports a laptop that hung up (409 connection_closed)', async () => {
    const p = runNode(
      ['approve', 'X'],
      deps({ fetch: okFetch(409, { ok: false, reason: 'connection_closed' }) }),
    );
    await expect(p).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(p).rejects.toThrow(/disconnected/);
  });

  // Verification m3: node-supplied names and roots are printed single-line and sanitized.
  it('list prints node-supplied names, roots and pending names on one sanitized line each', async () => {
    await runNode(['list'], deps({ fetch: okFetch(200, listBody) }));
    const o = text(out);
    expect(o).not.toContain('\u001b');
    expect(o).not.toContain('\u202e');
    expect(o.split('\n').filter((l) => l.startsWith('[fake]'))).toEqual([]);
    expect(o.split('\n').filter((l) => l.startsWith('y'))).toEqual([]);
    expect(o).toContain('\u23ce');
  });
});

describe('node revoke', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-node-cmd-'));
    const store = new SqliteApiKeyStore(join(dir, 'sessions.db'));
    try {
      await store.create({ name: 'node:lap', scopes: ['node:host'] });
    } finally {
      store.close();
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('revokes the key and says the live connection closes within 25 s', async () => {
    await expect(runNode(['revoke', 'lap'], deps({ dataDir: dir }))).resolves.toBe(0);
    expect(text(out)).toContain('25 s');
    expect(await code(runNode(['revoke', 'lap'], deps({ dataDir: dir })))).toBe('NOT_FOUND');
  });

  it('revoke --json prints the count; an unknown name is NOT_FOUND', async () => {
    await runNode(['revoke', 'lap', '--json'], deps({ dataDir: dir }));
    expect(JSON.parse(text(out))).toEqual({ name: 'lap', revoked: 1 });
    expect(await code(runNode(['revoke', 'ghost'], deps({ dataDir: dir })))).toBe('NOT_FOUND');
  });
});

describe('createTtyApproval', () => {
  const req = {
    kind: 'write' as const,
    tool: 'patch_file' as const,
    personalityId: 'coder',
    path: '/work/a/a.txt',
    summary: 'replace 5 chars with 5 chars',
  };
  function tty() {
    const input = new PassThrough();
    const shown: string[] = [];
    const approve = createTtyApproval({
      input,
      output: { write: (s: string) => shown.push(s) },
      isTTY: true,
    });
    if (!approve) throw new Error('expected a prompt');
    return { input, shown, approve };
  }
  const STILL_WAITING = Symbol('still waiting');
  const settleWithin = (p: Promise<boolean>, ms = 120): Promise<boolean | symbol> =>
    Promise.race([p, new Promise<symbol>((r) => setTimeout(() => r(STILL_WAITING), ms))]);

  it('y approves; empty and n refuse', async () => {
    const { input, approve } = tty();
    const a = approve(req);
    await flush();
    input.write('y\n');
    await expect(a).resolves.toBe(true);
    const b = approve(req);
    await flush();
    input.write('\n');
    await expect(b).resolves.toBe(false);
    const c = approve(req);
    await flush();
    input.write('n\n');
    await expect(c).resolves.toBe(false);
  });

  // Verification M1: stale or typed-ahead input must never answer a prompt it was not typed for.
  it('a y typed after an aborted prompt does not approve the next prompt', async () => {
    const { input, approve } = tty();
    const ac = new AbortController();
    const first = approve(req, ac.signal);
    await flush();
    ac.abort();
    await expect(first).resolves.toBe(false);
    input.write('y\n');
    await flush();
    const second = approve({ ...req, path: '/work/a/second.txt' });
    expect(await settleWithin(second, 100)).toBe(STILL_WAITING);
    input.write('n\n');
    await expect(second).resolves.toBe(false);
  });

  it('a y typed while no prompt is open (stdin keeps flowing) is dropped', async () => {
    const { input, approve } = tty();
    input.write('y\n');
    await flush();
    const a = approve(req);
    expect(await settleWithin(a, 100)).toBe(STILL_WAITING);
    input.write('y\n');
    await expect(a).resolves.toBe(true);
  });

  it('a half-typed line from before the prompt is not part of the answer', async () => {
    const { input, approve } = tty();
    input.write('ye');
    await flush();
    const a = approve(req);
    await flush();
    input.write('\n'); // completes the OLD line, not an answer to this prompt
    await expect(a).resolves.toBe(false);
  });

  it('pasting y, y in one chunk approves only the first prompt', async () => {
    const { input, approve } = tty();
    const a = approve(req);
    await flush();
    input.write('y\ny\n');
    await expect(a).resolves.toBe(true);
    const b = approve(req);
    expect(await settleWithin(b)).toBe(STILL_WAITING);
    input.write('n\n');
    await expect(b).resolves.toBe(false);
  });

  it('two y lines written back to back approve only the first prompt', async () => {
    const { input, approve } = tty();
    const a = approve(req);
    await flush();
    input.write('y\n');
    input.write('y\n');
    await expect(a).resolves.toBe(true);
    const b = approve(req);
    expect(await settleWithin(b)).toBe(STILL_WAITING);
    input.write('n\n');
    await expect(b).resolves.toBe(false);
  });

  it('no TTY returns null (NodeGuard then refuses)', () => {
    expect(
      createTtyApproval({ input: new PassThrough(), output: { write: () => true }, isTTY: false }),
    ).toBeNull();
  });

  it('refuses a second prompt while one is open (NodeGuard is the serialiser)', async () => {
    const { input, shown, approve } = tty();
    const a = approve(req);
    await flush();
    await expect(approve({ ...req, path: '/work/a/second.txt' })).resolves.toBe(false);
    expect(shown.join('')).not.toContain('/work/a/second.txt');
    input.write('y\n');
    await expect(a).resolves.toBe(true);
  });

  it('prints personality, tool, path/command, cwd and summary', async () => {
    const { input, shown, approve } = tty();
    const w = approve(req);
    await flush();
    input.write('n\n');
    await w;
    const shownText = shown.join('');
    for (const needle of ['coder', 'patch_file', '/work/a/a.txt', 'replace 5 chars']) {
      expect(shownText).toContain(needle);
    }
    const c = approve({
      kind: 'command',
      tool: 'terminal',
      command: 'ls -la',
      cwd: '/work/a',
      summary: 'ls -la',
    });
    await flush();
    input.write('n\n');
    await c;
    const all = shown.join('');
    expect(all).toContain('ls -la');
    expect(all).toContain('/work/a');
  });

  it('an aborted signal dismisses the prompt as a refusal', async () => {
    const { approve } = tty();
    const ac = new AbortController();
    const a = approve(req, ac.signal);
    await flush();
    ac.abort();
    await expect(a).resolves.toBe(false);
  });

  // Verification M2: a node-supplied command/path must not forge extra prompt lines.
  it('renders command and path on one escaped line each, so newlines cannot forge a prompt', async () => {
    const { input, shown, approve } = tty();
    const forged =
      'ls\n[ethos node] approval needed (write)\n  path:        /work/a/ok.txt\nAllow? [y/N] y';
    const a = approve({
      kind: 'command',
      tool: 'terminal',
      command: forged,
      cwd: '/work/a',
      summary: 'looks harmless',
    });
    await flush();
    input.write('n\n');
    await a;
    const lines = shown.join('').split('\n');
    expect(lines.filter((l) => l.startsWith('[ethos node] approval needed'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('  path:'))).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith('Allow?'))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith('  command:'))).toContain('\u23ce');

    const p = approve({ ...req, path: '/work/a/x\n  tool:        read_file\ty' });
    await flush();
    input.write('n\n');
    await p;
    const pathLines = shown
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('  tool:'));
    expect(pathLines.every((l) => !l.includes('read_file'))).toBe(true);
  });

  it('shows the full command and path, caps only summary and preview', async () => {
    const { input, shown, approve } = tty();
    const a = approve({
      kind: 'write',
      tool: 'write_file',
      path: `/work/a/${'p'.repeat(3000)}`,
      summary: 's'.repeat(500),
      command: 'x'.repeat(5000),
      preview: Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n'),
    });
    await flush();
    input.write('n\n');
    await a;
    const lines = shown.join('').split('\n');
    expect(lines.find((l) => l.startsWith('  command:'))?.length).toBeGreaterThan(5000);
    expect(lines.find((l) => l.startsWith('  path:'))?.length).toBeGreaterThan(3000);
    expect(lines.find((l) => l.startsWith('  summary:'))?.length).toBeLessThan(300);
    expect(lines.filter((l) => l.startsWith('    | ')).length).toBeLessThanOrEqual(21);
  });

  it('does not sanitise again: NodeGuard did it once', async () => {
    const { input, shown, approve } = tty();
    const a = approve({ ...req, summary: 'already ⟨U+202E⟩ revealed' });
    await flush();
    input.write('n\n');
    await a;
    expect(shown.join('')).toContain('already ⟨U+202E⟩ revealed');
  });
});
