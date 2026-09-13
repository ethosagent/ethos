// M-T6 — the personality export over Streamable HTTP, on B-T3's per-session
// helper (plan/phases/trust-before-reach.md, Part 3).
//
// Three properties that do not hold for the operator console's `serveHttp`:
// HTTP requires `auth: 'bearer'`, the key is re-verified on every REQUEST (not
// only at initialize), and each session id is bound to the key that opened it.
// Loopback binding and DNS-rebinding protection are the helper's, and the last
// test here is the regression guard that this server still gets them.

import { request } from 'node:http';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import type { PersonalityConfig } from '@ethosagent/types';
import { resolveMcpExportScope } from '@ethosagent/wiring';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type McpExportAuditEntry, PersonalityExportServer } from '../export-server';

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const registry = {
  getAvailable: () => [{ name: 'read_file' }, { name: 'terminal' }],
  toolNamesForPersonality: (p: PersonalityConfig) => new Set(p.toolset ?? []),
};

const stubLoop = {
  run: (): AsyncGenerator<AgentEvent> =>
    (async function* () {
      yield { type: 'done' as const, text: 'ok', turnCount: 1 };
    })(),
} as unknown as AgentLoop;

function personality(auth: 'localhost' | 'bearer'): PersonalityConfig {
  return {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews things.',
    toolset: ['read_file'],
    mcp_export: { enabled: true, expose_tools: ['read_file'], auth },
  } as PersonalityConfig;
}

/** Two distinct live keys, plus one that can be revoked mid-test. */
const KEYS: Record<string, { clientId: string; keyId: string; keyPrefix: string }> = {
  'sk-ethos-aaaa1111': {
    clientId: 'key-sk-ethos-aaaa1111',
    keyId: 'k-a',
    keyPrefix: 'sk-ethos-aaaa1111',
  },
  'sk-ethos-bbbb2222': {
    clientId: 'key-sk-ethos-bbbb2222',
    keyId: 'k-b',
    keyPrefix: 'sk-ethos-bbbb2222',
  },
};

function authenticator(revoked: Set<string>) {
  return {
    requiredScope: 'mcp:reviewer',
    verify: async (secret: string | undefined) => {
      if (secret === undefined || secret === '')
        return { ok: false as const, reason: 'missing_key' as const };
      const record = KEYS[secret];
      if (!record || revoked.has(secret))
        return { ok: false as const, reason: 'invalid_key' as const };
      return { ok: true as const, ...record, keyName: 'desktop' };
    },
  };
}

interface Harness {
  server: PersonalityExportServer;
  audit: McpExportAuditEntry[];
  revoked: Set<string>;
}

function makeServer(auth: 'localhost' | 'bearer' = 'bearer'): Harness {
  const audit: McpExportAuditEntry[] = [];
  const revoked = new Set<string>();
  const server = new PersonalityExportServer({
    personalityId: 'reviewer',
    loop: stubLoop,
    personalities: { get: () => personality(auth) },
    refreshPersonalities: async () => {},
    toolRegistry: registry,
    resolveScope: resolveMcpExportScope,
    logger: noopLogger,
    authenticator: authenticator(revoked),
    audit: { record: (e) => audit.push(e) },
  });
  open.push(server);
  return { server, audit, revoked };
}

const open: PersonalityExportServer[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

const connect = async (port: number, secret: string, name = 'c'): Promise<Client> => {
  const client = new Client({ name, version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  return client;
};

/** A raw POST, so the Host and Authorization headers can be anything. */
function post(
  port: number,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += String(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1' },
  },
};

// ---------------------------------------------------------------------------

describe('PersonalityExportServer.serveHttp', () => {
  it('refuses to serve a localhost export over HTTP at all', async () => {
    const { server } = makeServer('localhost');
    await expect(server.serveHttp({ port: 0 })).rejects.toThrow(/stdio only/);
  });

  it('refuses a non-loopback bind', async () => {
    const { server } = makeServer();
    await expect(server.serveHttp({ port: 0, host: '0.0.0.0' })).rejects.toThrow('loopback');
  });

  it('two sequential export sessions both initialize', async () => {
    const { server } = makeServer();
    const handle = await server.serveHttp({ port: 0 });

    const first = await connect(handle.port, 'sk-ethos-aaaa1111', 'first');
    expect((await first.listTools()).tools.map((t) => t.name)).toEqual(['ask']);
    await first.close();

    // Before B-T3 this threw `Already connected to a transport`.
    const second = await connect(handle.port, 'sk-ethos-aaaa1111', 'second');
    expect((await second.listTools()).tools.map((t) => t.name)).toEqual(['ask']);
    await second.close();
  });

  it('answers 401 with an mcp.export.auth denial when no key is presented', async () => {
    const { server, audit } = makeServer();
    const handle = await server.serveHttp({ port: 0 });

    const res = await post(handle.port, { Host: `127.0.0.1:${handle.port}` }, initializeBody);
    expect(res.status).toBe(401);
    expect(audit).toContainEqual(
      expect.objectContaining({
        kind: 'auth',
        decision: 'denied',
        reason: 'missing_key',
        personalityId: 'reviewer',
      }),
    );
  });

  it('answers 401 with an mcp.export.auth denial for an unknown key', async () => {
    const { server, audit } = makeServer();
    const handle = await server.serveHttp({ port: 0 });

    const res = await post(
      handle.port,
      { Host: `127.0.0.1:${handle.port}`, Authorization: 'Bearer sk-ethos-nope0000' },
      initializeBody,
    );
    expect(res.status).toBe(401);
    expect(audit.at(-1)).toMatchObject({ kind: 'auth', decision: 'denied', reason: 'invalid_key' });
  });

  it('verifies the key on every request, so a revocation lands mid-session', async () => {
    const { server, revoked } = makeServer();
    const handle = await server.serveHttp({ port: 0 });

    const client = await connect(handle.port, 'sk-ethos-aaaa1111');
    expect((await client.listTools()).tools).toHaveLength(1);

    // The session is already initialized — only a PER-REQUEST check can see this.
    revoked.add('sk-ethos-aaaa1111');
    await expect(client.listTools()).rejects.toThrow();
    await client.close().catch(() => {});
  });

  it('binds a session id to the key that opened it', async () => {
    const { server, audit } = makeServer();
    const handle = await server.serveHttp({ port: 0 });

    // Open a session with key A and learn its id from the response header.
    const sessionId = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Host: `127.0.0.1:${handle.port}`,
            Authorization: 'Bearer sk-ethos-aaaa1111',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          res.resume();
          const id = res.headers['mcp-session-id'];
          res.on('end', () => (typeof id === 'string' ? resolve(id) : reject(new Error('no id'))));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(initializeBody));
    });
    expect(sessionId).toBeTruthy();

    // Key B is perfectly valid — and still may not resume A's session.
    const stolen = await post(
      handle.port,
      {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: 'Bearer sk-ethos-bbbb2222',
        'mcp-session-id': sessionId,
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    );
    expect(stolen.status).toBe(403);
    expect(audit.at(-1)).toMatchObject({
      kind: 'auth',
      decision: 'denied',
      reason: 'session_key_mismatch',
      clientId: 'key-sk-ethos-bbbb2222',
    });
  });

  it('answers 403 to a rebound Host header, before it ever reaches the key check', async () => {
    const { server, audit } = makeServer();
    const handle = await server.serveHttp({ port: 0 });

    const rebound = await post(
      handle.port,
      { Host: 'evil.example', Authorization: 'Bearer sk-ethos-aaaa1111' },
      initializeBody,
    );
    expect(rebound.status).toBe(403);
    expect(rebound.body).toContain('Invalid Host header');
    // The Host check runs first, so no auth decision was recorded at all.
    expect(audit).toEqual([]);

    const allowed = await post(
      handle.port,
      { Host: `127.0.0.1:${handle.port}`, Authorization: 'Bearer sk-ethos-aaaa1111' },
      initializeBody,
    );
    expect(allowed.status).toBe(200);
  });

  it('keys an exported turn on the calling key, not the client name', async () => {
    const runs: Array<{ sessionKey?: string }> = [];
    const capturing = {
      run: (_prompt: string, options?: { sessionKey?: string }): AsyncGenerator<AgentEvent> => {
        runs.push({ ...(options?.sessionKey ? { sessionKey: options.sessionKey } : {}) });
        return (async function* () {
          yield { type: 'done' as const, text: 'ok', turnCount: 1 };
        })();
      },
    } as unknown as AgentLoop;
    const server = new PersonalityExportServer({
      personalityId: 'reviewer',
      loop: capturing,
      personalities: { get: () => personality('bearer') },
      refreshPersonalities: async () => {},
      toolRegistry: registry,
      resolveScope: resolveMcpExportScope,
      logger: noopLogger,
      authenticator: authenticator(new Set()),
    });
    open.push(server);
    const handle = await server.serveHttp({ port: 0 });
    const client = await connect(handle.port, 'sk-ethos-bbbb2222', 'claude-desktop');
    const result = (await client.callTool({ name: 'ask', arguments: { prompt: 'hi' } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(runs[0]?.sessionKey).toMatch(/^mcp:reviewer:key-sk-ethos-bbbb2222:[A-Za-z0-9_-]+$/);
    await client.close();
  });
});
