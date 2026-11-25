// plan laptop-tool-node T9 (brief D2): `ethos node ...` — approve, list and revoke.
// Fixtures and the injected-deps setup live in ./node-command-fixtures.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNode } from '../commands/node';
import { code, deps, out, SERVER, STATE_DIR, storage, text } from './node-command-fixtures';

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
