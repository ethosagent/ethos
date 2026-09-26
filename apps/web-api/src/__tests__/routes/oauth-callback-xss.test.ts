import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// S2 (plan openclaw-2026.9.6-gaps). `GET /oauth/callback` reflects `state`,
// `error` and `error_description` from the query into an inline <script>.
// `JSON.stringify` does not escape `</script>`, so a crafted link closed the
// block and ran attacker script on the API origin — with the `ethos_auth`
// cookie. The handler now embeds the message via `jsonForInlineScript`
// (routes/index.ts) and `cspMiddleware` (middleware/csp.ts) puts a nonce-only
// script policy on the response. The SPA shell is exempt from the strict policy
// (its index.html carries an inline bootstrap script and its srcdoc iframes
// inherit the parent's policy) — pinned by the last describe below.

const PAYLOAD = '</script><script>window.__x=1</script>';

describe('GET /oauth/callback — reflected XSS + CSP (S2)', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-oauth-xss-'));
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'm', provider: 'p' },
    }).app;
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const callback = (query: string) => app.request(`/oauth/callback?${query}`);

  it('does not let a query parameter close the inline script block', async () => {
    const res = await callback(
      `error=${encodeURIComponent(PAYLOAD)}&error_description=${encodeURIComponent(PAYLOAD)}` +
        `&state=${encodeURIComponent(PAYLOAD)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Exactly one `</script>` — the handler's own closing tag.
    expect(body.match(/<\/script/gi) ?? []).toHaveLength(1);
    expect(body).not.toContain('<script>window.__x');
  });

  it('escapes U+2028 / U+2029 and `&`, and the message still round-trips', async () => {
    const detail = 'a b c&<!--d';
    const res = await callback(`error=x&error_description=${encodeURIComponent(detail)}`);
    const body = await res.text();
    expect(body).not.toContain(' ');
    expect(body).not.toContain(' ');
    expect(body).not.toContain('<!--');
    const literal = /var msg = (.*);\n/.exec(body)?.[1] ?? '';
    const msg = JSON.parse(literal) as { detail: string; code: string };
    expect(msg.code).toBe('x');
    expect(msg.detail).toBe(`x: ${detail}`);
  });

  it('carries a nonce-based Content-Security-Policy that matches its own script', async () => {
    const res = await callback('error=access_denied');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(await res.text()).toContain(`<script nonce="${nonce}">`);
    // No blanket inline allowance — the nonce is the only way in.
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it('mints a fresh nonce per response', async () => {
    const a = (await callback('error=x')).headers.get('content-security-policy');
    const b = (await callback('error=x')).headers.get('content-security-policy');
    expect(a).not.toBe(b);
  });

  it('applies the strict policy to API responses too', async () => {
    const res = await app.request('/healthz');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('SPA shell under the policy (S2)', () => {
  let dir: string;
  let dist: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-oauth-xss-spa-'));
    dist = join(dir, 'web-dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    // The real SPA shell, inline bootstrap script included — the policy must
    // not block what production actually serves.
    const spaIndex = await readFile(
      join(import.meta.dirname, '..', '..', '..', '..', 'web', 'index.html'),
      'utf-8',
    );
    await writeFile(join(dist, 'index.html'), spaIndex, 'utf-8');
    await writeFile(join(dist, 'assets', 'main.js'), 'export {};', 'utf-8');
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'm', provider: 'p' },
      webDist: dist,
    }).app;
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  for (const path of ['/', '/chat', '/assets/main.js']) {
    it(`${path} loads, and its policy restricts framing only`, async () => {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toBe("frame-ancestors 'none'");
    });
  }

  it('the shell still carries its inline bootstrap script, which the policy does not block', async () => {
    const res = await app.request('/');
    const body = await res.text();
    expect(body).toContain('ethos:mcp_oauth_callback');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).not.toMatch(/script-src|default-src/);
  });
});
