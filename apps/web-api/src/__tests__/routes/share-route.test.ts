import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { SqliteShareLinkStore } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../index';
import { WebSessionStore } from '../../repositories/web-session.store';
import { WebTokenRepository } from '../../repositories/web-token.repository';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// plan share-links §4 (Lane E1): GET /share/<token>, the public page. Driven through
// createWebApi so the global middleware (requestId, csp, cors) is in the chain.

const XSS = '</script><img src=x onerror=alert(1)>';
const ON = 'shareLinks.enabled: true\n';

describe('GET /share/<token>', () => {
  let dir: string;
  let sessions: SQLiteSessionStore;
  let store: SqliteShareLinkStore;
  let app: ReturnType<typeof createWebApi>['app'];

  const configure = (yaml: string) => writeFile(join(dir, 'config.yaml'), yaml);
  const mint = (over: { snapshot?: string; expiresAt?: Date } = {}) =>
    store.create({
      sessionId: 's1',
      personalityId: 'engineer',
      title: 'T',
      options: '{}',
      snapshot:
        over.snapshot ??
        JSON.stringify({
          v: 1,
          title: 'Fix retry',
          personalityId: 'engineer',
          createdAt: '2026-11-26T14:20:00.000Z',
          turns: [
            { role: 'user', text: `${XSS} "q" 'a' & b` },
            { role: 'assistant', text: 'ok', tools: [{ name: 'grep', isError: true }] },
          ],
        }),
      expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000),
      actor: 'cli',
    });
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers });
  const stripVolatile = (res: Response) =>
    [...res.headers.entries()].filter(([k]) => k !== 'x-request-id').sort();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-share-route-'));
    await configure(ON);
    sessions = new SQLiteSessionStore(':memory:');
    store = new SqliteShareLinkStore(':memory:');
    ({ app } = createWebApi({
      dataDir: dir,
      sessionStore: sessions,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'm', provider: 'p' },
      shareLinks: { store, bind: { host: '127.0.0.1', port: 3000 } },
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    sessions.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the snapshot with 200', async () => {
    const { token } = mint();
    const res = await get(`/share/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain('Fix retry');
    expect(html).toContain('Read-only snapshot. Redacted at creation.');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('&#10007; grep');
  });

  it('headers: exact CSP with a fresh nonce matching the <style>, robots, referrer, cache', async () => {
    const { token } = mint();
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await get(`/share/${token}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      const nonce = /style-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
      expect(nonce.length).toBeGreaterThanOrEqual(16);
      expect(csp).toBe(
        `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox`,
      );
      expect(await res.text()).toContain(`<style nonce="${nonce}">`);
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      seen.push(nonce);
    }
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('keeps the handler-set policy: the global cspMiddleware does not overwrite it', async () => {
    const { token } = mint();
    const csp = (await get(`/share/${token}`)).headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain("default-src 'self'");
    expect(csp.startsWith("default-src 'none'")).toBe(true);
  });

  it('renders the XSS payload and "\'&<> inert', async () => {
    const { token } = mint();
    const html = await (await get(`/share/${token}`)).text();
    expect(html).not.toContain('<img');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;q&quot; &#39;a&#39; &amp; b');
  });

  describe('uniform 404', () => {
    it('is byte-identical, with identical headers, for every kind of miss', async () => {
      const live = mint();
      const revoked = mint();
      store.revoke(revoked.record.id, 'cli');
      const expired = mint({ expiresAt: new Date(Date.now() - 1000) });
      const corrupt = mint({ snapshot: '{not json' });
      const misses = [
        '/share/short',
        `/share/${'A'.repeat(43)}`,
        `/share/${'A'.repeat(44)}`,
        `/share/${live.token}%2F..`,
        '/share',
        '/share/',
        `/share/${revoked.token}`,
        `/share/${expired.token}`,
        `/share/${corrupt.token}`,
      ];
      const responses = await Promise.all(misses.map((p) => get(p)));
      // Feature off: the live link now misses too.
      await configure('shareLinks.enabled: false\n');
      responses.push(await get(`/share/${live.token}`));
      const bodies = await Promise.all(responses.map((r) => r.text()));
      for (const r of responses) expect(r.status).toBe(404);
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toContain("This link doesn't exist or has expired.");
      const headers = responses.map((r) => JSON.stringify(stripVolatile(r)));
      expect(new Set(headers).size).toBe(1);
      expect(responses[0]?.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    });

    it('a non-GET method gets the same 404', async () => {
      const miss = await get('/share/short');
      const post = await app.request('/share/short', { method: 'POST' });
      expect(post.status).toBe(404);
      expect(await post.text()).toBe(await miss.text());
    });
  });

  it('live switch: turning shareLinks.enabled off 404s a served link at once, and on restores it', async () => {
    const { token } = mint();
    expect((await get(`/share/${token}`)).status).toBe(200);
    await configure('shareLinks.enabled: false\n');
    expect((await get(`/share/${token}`)).status).toBe(404);
    await configure(ON);
    expect((await get(`/share/${token}`)).status).toBe(200);
    await rm(join(dir, 'config.yaml'));
    expect((await get(`/share/${token}`)).status).toBe(404);
  });

  it('no cookie: no set-cookie on 200 or 404, and verifyCookie is never reached', async () => {
    const matches = vi.spyOn(WebTokenRepository.prototype, 'matches');
    const has = vi.spyOn(WebSessionStore.prototype, 'has');
    const { token } = mint();
    const cookie = { cookie: 'ethos_auth=anything' };
    const ok = await get(`/share/${token}`, cookie);
    const miss = await get('/share/nope', cookie);
    expect(ok.status).toBe(200);
    expect(miss.status).toBe(404);
    expect(ok.headers.get('set-cookie')).toBeNull();
    expect(miss.headers.get('set-cookie')).toBeNull();
    expect(matches).not.toHaveBeenCalled();
    expect(has).not.toHaveBeenCalled();
    // Control: the spy does see the cookie check on an authenticated surface.
    await app.request('/rpc/shares/list', { method: 'POST', headers: cookie });
    expect(matches.mock.calls.length + has.mock.calls.length).toBeGreaterThan(0);
  });

  it('view count: a 200 counts one view, a miss counts none', async () => {
    const { token, record } = mint();
    const viewsOf = () => store.list({ activeOnly: false }).find((r) => r.id === record.id);
    expect(viewsOf()?.viewCount).toBe(0);
    await get(`/share/${token}`);
    await get(`/share/${token}`);
    await get('/share/nope');
    expect(viewsOf()?.viewCount).toBe(2);
    expect(viewsOf()?.lastViewedAt).not.toBeNull();
  });

  it('rate limit: 30 requests pass, the 31st is 429 with Retry-After, and a hit link is locked out too', async () => {
    const { token } = mint();
    for (let i = 0; i < 30; i++) expect((await get('/share/nope')).status).toBe(404);
    const limited = await get(`/share/${token}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('600');
    expect(limited.headers.get('set-cookie')).toBeNull();
    expect(await limited.json()).toMatchObject({ code: 'rate_limited' });
    expect((await get(`/share/${token}`)).status).toBe(429);
  });

  it('429 carries the same share headers as every other /share response', async () => {
    for (let i = 0; i < 30; i++) await get('/share/nope');
    const limited = await get('/share/nope');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(limited.headers.get('referrer-policy')).toBe('no-referrer');
    expect(limited.headers.get('retry-after')).toBe('600');
  });

  it('a store failure in findLive is the uniform 404, not a 500', async () => {
    const miss = await get('/share/short');
    const { token } = mint();
    vi.spyOn(store, 'findLive').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const res = await get(`/share/${token}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await miss.text());
  });

  it('HEAD serves the page headers but does not count a view; GET still does', async () => {
    const { token, record } = mint();
    const viewsOf = () => store.list({ activeOnly: false }).find((r) => r.id === record.id);
    const head = await app.request(`/share/${token}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(viewsOf()?.viewCount).toBe(0);
    await get(`/share/${token}`);
    expect(viewsOf()?.viewCount).toBe(1);
  });
});
