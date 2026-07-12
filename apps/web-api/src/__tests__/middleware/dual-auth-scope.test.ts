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

// WEB-001 — bearer scope enforcement must FAIL CLOSED for unmapped methods in a
// mapped namespace, and every legitimately-mapped method must work with a key
// that holds the mapped scope.

describe('dualAuth scope enforcement (WEB-001)', () => {
  let store: SqliteApiKeyStore;
  let app: Hono;

  async function key(scopes: string[]): Promise<string> {
    const created = await store.create({ name: `k-${scopes.join(',')}`, scopes });
    return created.secret;
  }

  function call(path: string, secret: string, method: 'POST' | 'GET' = 'POST') {
    return app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
    });
  }

  beforeEach(async () => {
    store = new SqliteApiKeyStore(':memory:');
    app = new Hono();
    app.onError(errorHandler);
    const dir = mkdtempSync(join(tmpdir(), 'ethos-scope-'));
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const dual = dualAuth({ tokens, apiKeys: store, scopeForPath: resolveScope });
    app.use('/rpc/*', dual);
    app.use('/sse/*', dual);
    // Stub handlers — reachable only if middleware passes.
    app.post('/rpc/sessions/export', (c) => c.json({ ok: true }));
    app.post('/rpc/sessions/pin', (c) => c.json({ ok: true }));
    app.post('/rpc/chat/steer', (c) => c.json({ ok: true }));
    app.post('/rpc/personalities/create', (c) => c.json({ ok: true }));
    app.get('/sse/sessions/abc123', (c) => c.json({ ok: true }));
  });

  afterEach(() => {
    store.close();
  });

  it('sessions.export works with a sessions:read key (newly mapped)', async () => {
    const res = await call('/rpc/sessions/export', await key(['sessions:read']));
    expect(res.status).toBe(200);
  });

  it('sessions.export is REJECTED for a key without sessions:read (was fail-open)', async () => {
    const res = await call('/rpc/sessions/export', await key(['personalities:read']));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('FORBIDDEN');
    expect(body.error).toMatch(/scope "sessions:read"/);
  });

  it('sessions.pin requires sessions:write', async () => {
    expect((await call('/rpc/sessions/pin', await key(['sessions:write']))).status).toBe(200);
    expect((await call('/rpc/sessions/pin', await key(['sessions:read']))).status).toBe(403);
  });

  it('chat.steer works with chat:send (newly mapped)', async () => {
    expect((await call('/rpc/chat/steer', await key(['chat:send']))).status).toBe(200);
    expect((await call('/rpc/chat/steer', await key(['sessions:read']))).status).toBe(403);
  });

  it('personalities.create is cookie-only — rejected for any bearer key', async () => {
    const res = await call('/rpc/personalities/create', await key(['personalities:read']));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('FORBIDDEN');
    expect(body.error).toMatch(/cookie authentication/i);
  });

  it('SSE /sse/sessions/:id requires sessions:read', async () => {
    expect((await call('/sse/sessions/abc123', await key(['sessions:read']), 'GET')).status).toBe(
      200,
    );
    const denied = await call('/sse/sessions/abc123', await key(['chat:send']), 'GET');
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { code: string; error: string };
    expect(body.error).toMatch(/scope "sessions:read"/);
  });
});
