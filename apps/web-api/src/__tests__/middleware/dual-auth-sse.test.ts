import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dualAuth, resolveScope } from '../../middleware/dual-auth';
import { errorHandler } from '../../middleware/error-envelope';
import { WebTokenRepository } from '../../repositories/web-token.repository';

// mobile-app plan S2 — `SSE_SCOPES` replaces the single `isSseSessionStream`
// special case with one table covering all five feeds. Every feed gets the
// same treatment: right scope → 200, wrong scope → FORBIDDEN naming the
// scope, an unknown feed → FORBIDDEN "experimental" as before. `/sse/sessions`
// is asserted unchanged.

describe('dualAuth — SSE_SCOPES table', () => {
  let store: SqliteApiKeyStore;
  let app: Hono;

  async function key(scopes: string[], allowedOrigins?: string[]): Promise<string> {
    const created = await store.create({
      name: `k-${scopes.join(',')}`,
      scopes,
      ...(allowedOrigins ? { allowedOrigins } : {}),
    });
    return created.secret;
  }

  function get(path: string, secret: string, origin?: string) {
    return app.request(path, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${secret}`,
        ...(origin ? { origin } : {}),
      },
    });
  }

  beforeEach(async () => {
    store = new SqliteApiKeyStore(':memory:');
    app = new Hono();
    app.onError(errorHandler);
    const dir = mkdtempSync(join(tmpdir(), 'ethos-sse-scopes-'));
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const dual = dualAuth({ tokens, apiKeys: store, scopeForPath: resolveScope });
    app.use('/sse/*', dual);
    // Stub handlers — reachable only if middleware passes.
    app.get('/sse/sessions/abc123', (c) => c.json({ ok: true }));
    app.get('/sse/activity', (c) => c.json({ ok: true }));
    app.get('/sse/system', (c) => c.json({ ok: true }));
    app.get('/sse/kanban/marketing', (c) => c.json({ ok: true }));
    app.get('/sse/goals/goal-1', (c) => c.json({ ok: true }));
    app.get('/sse/x', (c) => c.json({ ok: true }));
  });

  afterEach(() => {
    store.close();
  });

  it('/sse/sessions/:id — unchanged: sessions:read ok, wrong scope FORBIDDEN', async () => {
    expect((await get('/sse/sessions/abc123', await key(['sessions:read']))).status).toBe(200);
    const denied = await get('/sse/sessions/abc123', await key(['chat:send']));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/scope "sessions:read"/);
  });

  it('/sse/activity — requires activity:read', async () => {
    expect((await get('/sse/activity', await key(['activity:read']))).status).toBe(200);
    const denied = await get('/sse/activity', await key(['sessions:read']));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/scope "activity:read"/);
  });

  it('/sse/system — requires events:subscribe', async () => {
    expect((await get('/sse/system', await key(['events:subscribe']))).status).toBe(200);
    const denied = await get('/sse/system', await key(['sessions:read']));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/scope "events:subscribe"/);
  });

  it('/sse/kanban/:team — requires kanban:read', async () => {
    expect((await get('/sse/kanban/marketing', await key(['kanban:read']))).status).toBe(200);
    const denied = await get('/sse/kanban/marketing', await key(['sessions:read']));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/scope "kanban:read"/);
  });

  it('/sse/goals/:id — requires library:read', async () => {
    expect((await get('/sse/goals/goal-1', await key(['library:read']))).status).toBe(200);
    const denied = await get('/sse/goals/goal-1', await key(['sessions:read']));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/scope "library:read"/);
  });

  it('an unknown feed stays FORBIDDEN "experimental"', async () => {
    const res = await get('/sse/x', await key(['sessions:read', 'activity:read']));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('FORBIDDEN');
    expect(body.error).toMatch(/experimental/);
  });

  it('empty allowedOrigins + no Origin header → allowed (.min(0), mandatory for RN)', async () => {
    const secret = await key(['activity:read'], []);
    const res = await get('/sse/activity', secret);
    expect(res.status).toBe(200);
  });
});
