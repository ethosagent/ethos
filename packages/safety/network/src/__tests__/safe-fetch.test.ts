import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { safeFetch, validateUrl } from '../safe-fetch';

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------

describe('validateUrl', () => {
  it('rejects non-http schemes at gate-zero', async () => {
    const r = await validateUrl('file:///etc/passwd', {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/URL_SCHEME_REJECTED/);
  });

  it('rejects cloud-metadata IP literals always (even with allow_private_urls)', async () => {
    const r = await validateUrl('http://169.254.169.254/', { allow_private_urls: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cloud-metadata/);
  });

  it('rejects cloud-metadata DNS hosts always', async () => {
    const r = await validateUrl('http://metadata.google.internal/', { allow_private_urls: true });
    expect(r.ok).toBe(false);
  });

  it('rejects RFC1918 literals by default', async () => {
    expect((await validateUrl('http://10.0.0.1/', {})).ok).toBe(false);
    expect((await validateUrl('http://192.168.1.1/', {})).ok).toBe(false);
    expect((await validateUrl('http://127.0.0.1/', {})).ok).toBe(false);
  });

  it('accepts RFC1918 when allow_private_urls is true', async () => {
    expect((await validateUrl('http://10.0.0.1/', { allow_private_urls: true })).ok).toBe(true);
  });

  it('rejects IPv6 link-local + ULA', async () => {
    expect((await validateUrl('http://[fe80::1]/', {})).ok).toBe(false);
    expect((await validateUrl('http://[fc00::1]/', {})).ok).toBe(false);
    expect((await validateUrl('http://[::1]/', {})).ok).toBe(false);
  });

  it('rejects DNS rebinding to private IP', async () => {
    const resolveHost = async () => ['10.0.0.5'];
    const r = await validateUrl('http://attacker.example.com/', {}, resolveHost);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/private IP/);
  });

  it('rejects DNS rebinding to cloud-metadata even with allow_private_urls', async () => {
    const resolveHost = async () => ['169.254.169.254'];
    const r = await validateUrl(
      'http://attacker.example.com/',
      { allow_private_urls: true },
      resolveHost,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cloud-metadata/);
  });

  it('honours per-personality allow / deny', async () => {
    const policy = { allow: ['api.github.com'], deny: ['evil.example.com'] };
    const resolveHost = async () => ['1.1.1.1']; // public-looking
    expect((await validateUrl('http://api.github.com/', policy, resolveHost)).ok).toBe(true);
    expect((await validateUrl('http://other.com/', policy, resolveHost)).ok).toBe(false);
  });

  it("allow: ['*'] admits a public host but never widens the floor", async () => {
    const policy = { allow: ['*'] };
    const publicHost = async () => ['1.1.1.1'];
    expect((await validateUrl('https://example.com/', policy, publicHost)).ok).toBe(true);
    // Private range, rebinding, and cloud-metadata are refused regardless.
    expect((await validateUrl('http://10.0.0.1/', policy)).ok).toBe(false);
    expect((await validateUrl('http://a.example.com/', policy, async () => ['10.0.0.5'])).ok).toBe(
      false,
    );
    expect((await validateUrl('http://169.254.169.254/', policy)).ok).toBe(false);
    // The deny list still wins over a wildcard allow.
    const r = await validateUrl(
      'https://evil.example.com/',
      { allow: ['*'], deny: ['evil.example.com'] },
      publicHost,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/deny list/);
  });

  it('rejects URL-encoded variants of private IPs', async () => {
    // Hex-encoded loopback (URL parser normalizes)
    expect((await validateUrl('http://0x7f.0.0.1/', {})).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safeFetch — redirect revalidation
// ---------------------------------------------------------------------------

function makeRedirectFetch(redirects: Map<string, { status: number; location?: string }>) {
  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const entry = redirects.get(url);
    if (!entry) {
      return new Response('terminal', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const headers = new Headers();
    if (entry.location) headers.set('location', entry.location);
    return new Response(null, { status: entry.status, headers });
  };
}

describe('safeFetch — manual redirect revalidation', () => {
  it('revalidates the redirect target — 302 to cloud metadata is rejected at hop 1', async () => {
    const redirects = new Map([
      [
        'http://safe.example.com/r',
        { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
      ],
    ]);
    const result = await safeFetch('http://safe.example.com/r', {
      policy: {},
      fetchImpl: makeRedirectFetch(redirects),
      resolveHost: async () => ['1.1.1.1'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hop).toBe(1);
      expect(result.reason).toMatch(/cloud-metadata/);
    }
  });

  it('revalidates the redirect target — 302 to private network rejected at hop 1', async () => {
    const redirects = new Map([
      ['http://safe.example.com/', { status: 302, location: 'http://10.0.0.5:6379/' }],
    ]);
    const result = await safeFetch('http://safe.example.com/', {
      policy: {},
      fetchImpl: makeRedirectFetch(redirects),
      resolveHost: async () => ['1.1.1.1'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/private/);
  });

  it('caps redirect chain at 5 hops', async () => {
    // 6 hops: a → b → c → d → e → f
    const redirects = new Map([
      ['http://a.example.com/', { status: 302, location: 'http://b.example.com/' }],
      ['http://b.example.com/', { status: 302, location: 'http://c.example.com/' }],
      ['http://c.example.com/', { status: 302, location: 'http://d.example.com/' }],
      ['http://d.example.com/', { status: 302, location: 'http://e.example.com/' }],
      ['http://e.example.com/', { status: 302, location: 'http://f.example.com/' }],
    ]);
    const result = await safeFetch('http://a.example.com/', {
      policy: {},
      fetchImpl: makeRedirectFetch(redirects),
      resolveHost: async () => ['1.1.1.1'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/redirect hops/);
  });

  it('follows benign redirects up to the cap and returns the final response', async () => {
    const redirects = new Map([
      ['http://a.example.com/', { status: 302, location: 'http://b.example.com/' }],
      ['http://b.example.com/', { status: 302, location: 'http://c.example.com/' }],
    ]);
    const result = await safeFetch('http://a.example.com/', {
      policy: {},
      fetchImpl: makeRedirectFetch(redirects),
      resolveHost: async () => ['1.1.1.1'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalUrl).toBe('http://c.example.com/');
      expect(result.hops).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// safeFetch — connection pinning (Item 9, openclaw-advisory-fixes D6/D18)
// ---------------------------------------------------------------------------
//
// Real local HTTP servers, reached through hostnames under `.invalid` (RFC
// 6761: never resolvable). The system resolver cannot answer them, so a
// request that lands proves the connection used the address `resolveHost`
// returned and validation accepted — never a second, system lookup. Loopback
// servers need `allow_private_urls`; that path still resolves once and pins.

describe('safeFetch — connection pinning', () => {
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

  it('(a) connects to the validated address; the hostname still drives the Host header', async () => {
    const { port, seen } = await listen((host) => ({ status: 200, body: `hello ${host}` }));
    const calls: string[] = [];
    const result = await safeFetch(`http://pinned.invalid:${port}/x`, {
      policy: { allow_private_urls: true },
      resolveHost: async (h) => {
        calls.push(h);
        // A rebinding resolver: only the FIRST answer is the validated one. Any
        // second lookup (the race pinning closes) would get the metadata IP.
        return calls.length === 1 ? ['127.0.0.1'] : ['169.254.169.254'];
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await result.response.text()).toBe(`hello pinned.invalid:${port}`);
    expect(seen).toEqual([`pinned.invalid:${port}/x`]);
    expect(calls).toEqual(['pinned.invalid']);
  });

  it('(a) fails closed when validation resolved nothing — no fallback to the system resolver', async () => {
    const { port, seen } = await listen(() => ({ status: 200 }));
    const result = await safeFetch(`http://pinned.invalid:${port}/`, {
      policy: { allow_private_urls: true },
      resolveHost: async () => {
        throw new Error('resolver down');
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/fetch failed/);
    expect(seen).toEqual([]);
  });

  it('(b) a redirect hop to a new host re-resolves, re-validates and re-pins', async () => {
    const second = await listen((host) => ({ status: 200, body: `final ${host}` }));
    const first = await listen(() => ({
      status: 302,
      headers: { location: `http://second.invalid:${second.port}/final` },
    }));
    const calls: string[] = [];
    const result = await safeFetch(`http://first.invalid:${first.port}/r`, {
      policy: { allow_private_urls: true },
      resolveHost: async (h) => {
        calls.push(h);
        return ['127.0.0.1'];
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hops).toBe(1);
    expect(await result.response.text()).toBe(`final second.invalid:${second.port}`);
    expect(calls).toEqual(['first.invalid', 'second.invalid']);
    expect(first.seen).toEqual([`first.invalid:${first.port}/r`]);
    expect(second.seen).toEqual([`second.invalid:${second.port}/final`]);
  });

  it("(b) hop 1's pin is not reused: a redirect target with no validated address does not connect", async () => {
    const second = await listen(() => ({ status: 200 }));
    const first = await listen(() => ({
      status: 302,
      headers: { location: `http://second.invalid:${second.port}/final` },
    }));
    const result = await safeFetch(`http://first.invalid:${first.port}/r`, {
      policy: { allow_private_urls: true },
      resolveHost: async (h) => {
        if (h === 'second.invalid') throw new Error('NXDOMAIN');
        return ['127.0.0.1'];
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hop).toBe(1);
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toEqual([]);
  });
});
