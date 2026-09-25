import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type NetworkPolicy, safeFetch } from '@ethosagent/safety-network';
import { afterEach, describe, expect, it } from 'vitest';
import { webExtractTool } from '../index';

// web_extract's request goes through `ctx.scopedFetch`, which production wires
// to `ScopedFetchImpl` → `safeFetch` with NO `fetchImpl`
// (packages/core/src/capability-resolver.ts `resolveCapabilities`,
// packages/wiring/src/build-infrastructure.ts `capabilityBackends.safeFetch`), so
// the socket is pinned by `pinnedFetch` to the addresses `validateUrl` accepted.
// The `checkSsrf` lookup in ../ssrf.ts is only an early refusal — its answer is
// never what the connection uses. These tests drive the tool end to end over
// real loopback servers with a rebinding resolver: any second resolution would
// answer the cloud-metadata IP, so a response from the loopback server proves
// the validated address is the one connected to, on every redirect hop.
//
// Hostnames are under `.invalid` (RFC 6761): the system resolver cannot answer
// them, so `checkSsrf`'s own lookup fails (and lets the call through), and only
// the injected resolver can place the host. Loopback servers need
// `allow_private_urls`; that path still resolves once per hop and pins.

/** Mirrors `ScopedFetchImpl.fetch` minus the host allowlist: real `safeFetch`,
 *  real `pinnedFetch` (no `fetchImpl`), injected resolver only. */
function pinnedScopedFetch(
  policy: NetworkPolicy,
  resolveHost: (hostname: string) => Promise<string[]>,
) {
  return {
    fetch: async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const { redirect: _redirect, ...rest } = init ?? {};
      const result = await safeFetch(String(url), { policy, resolveHost, init: rest });
      if (!result.ok) throw new Error(`HOST_NOT_ALLOWED: ${result.reason}`);
      return result.response;
    },
  };
}

function ctxWith(scopedFetch: ReturnType<typeof pinnedScopedFetch>) {
  return {
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    secretsResolver: { get: async (_ref: string) => 'unused' },
    scopedFetch,
  };
}

describe('web_extract — connection pinning (DNS rebinding)', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((srv) => new Promise((r) => srv.close(r))));
  });

  async function listen(
    handler: (host: string | undefined) => {
      status: number;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{ port: number; seen: string[] }> {
    const seen: string[] = [];
    const srv = createServer((req, res) => {
      seen.push(`${req.headers.host}${req.url}`);
      const out = handler(req.headers.host);
      res.writeHead(out.status, out.headers);
      res.end(out.body ?? '');
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { port: (srv.address() as AddressInfo).port, seen };
  }

  /** First answer per host is the validated loopback; any later one rebinds. */
  function rebindingResolver() {
    const calls: string[] = [];
    const resolveHost = async (host: string): Promise<string[]> => {
      calls.push(host);
      return calls.filter((h) => h === host).length === 1 ? ['127.0.0.1'] : ['169.254.169.254'];
    };
    return { calls, resolveHost };
  }

  it('connects to the validated address, never a rebound one', async () => {
    const { port, seen } = await listen((host) => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: `served to ${host}`,
    }));
    const { calls, resolveHost } = rebindingResolver();

    const result = await webExtractTool.execute(
      { url: `http://rebind.invalid:${port}/page` },
      ctxWith(pinnedScopedFetch({ allow_private_urls: true }, resolveHost)),
    );

    expect(result).toEqual({
      ok: true,
      value: `[http://rebind.invalid:${port}/page]\n\nserved to rebind.invalid:${port}`,
    });
    expect(seen).toEqual([`rebind.invalid:${port}/page`]);
    expect(calls).toEqual(['rebind.invalid']);
  });

  it('re-validates and re-pins on every redirect hop', async () => {
    const second = await listen((host) => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: `final ${host}`,
    }));
    const first = await listen(() => ({
      status: 302,
      headers: { location: `http://hop2.invalid:${second.port}/end` },
    }));
    const { calls, resolveHost } = rebindingResolver();

    const result = await webExtractTool.execute(
      { url: `http://hop1.invalid:${first.port}/start` },
      ctxWith(pinnedScopedFetch({ allow_private_urls: true }, resolveHost)),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain(`final hop2.invalid:${second.port}`);
    expect(first.seen).toEqual([`hop1.invalid:${first.port}/start`]);
    expect(second.seen).toEqual([`hop2.invalid:${second.port}/end`]);
    expect(calls).toEqual(['hop1.invalid', 'hop2.invalid']);
  });

  it('refuses a redirect hop whose validated answer is the metadata IP', async () => {
    const first = await listen(() => ({
      status: 302,
      headers: { location: 'http://evil.invalid/latest/meta-data/' },
    }));
    const resolveHost = async (host: string): Promise<string[]> =>
      host === 'evil.invalid' ? ['169.254.169.254'] : ['127.0.0.1'];

    const result = await webExtractTool.execute(
      { url: `http://hop1.invalid:${first.port}/start` },
      ctxWith(pinnedScopedFetch({ allow_private_urls: true }, resolveHost)),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/HOST_NOT_ALLOWED: .*cloud-metadata/);
    }
  });
});
