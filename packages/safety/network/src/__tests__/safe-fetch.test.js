import { describe, expect, it } from 'vitest';
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
  it('rejects URL-encoded variants of private IPs', async () => {
    // Hex-encoded loopback (URL parser normalizes)
    expect((await validateUrl('http://0x7f.0.0.1/', {})).ok).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// safeFetch — redirect revalidation
// ---------------------------------------------------------------------------
function makeRedirectFetch(redirects) {
  return async (input, _init) => {
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
