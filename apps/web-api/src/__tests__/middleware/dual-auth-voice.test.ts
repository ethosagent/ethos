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

// Mobile-app Phase 3 — the `voice` namespace in SCOPE_MAP. The call screen's
// methods take `voice:talk`; deployment config and the phone-call log are
// cookie-only. Nested routers resolve through the real URL shape
// (`/rpc/voice/calls/list` → `voice` + `calls.list`).

describe('dualAuth — voice namespace', () => {
  let store: SqliteApiKeyStore;
  let app: Hono;

  async function key(scopes: string[]): Promise<string> {
    return (await store.create({ name: 'phone', scopes })).secret;
  }

  function call(path: string, secret: string) {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({}),
    });
  }

  beforeEach(() => {
    store = new SqliteApiKeyStore(':memory:');
    app = new Hono();
    app.onError(errorHandler);
    const dir = mkdtempSync(join(tmpdir(), 'ethos-voice-scope-'));
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    app.use('/rpc/*', dualAuth({ tokens, apiKeys: store, scopeForPath: resolveScope }));
    for (const path of [
      '/rpc/voice/transcribe',
      '/rpc/voice/laneMode/get',
      '/rpc/voice/laneMode/set',
      '/rpc/voice/calls/list',
    ]) {
      app.post(path, (c) => c.json({ ok: true }));
    }
  });

  afterEach(() => store.close());

  it('refuses voice.transcribe without voice:talk, naming the scope', async () => {
    const res = await call('/rpc/voice/transcribe', await key(['chat:send']));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('voice:talk');
  });

  it('allows voice.transcribe with voice:talk', async () => {
    const res = await call('/rpc/voice/transcribe', await key(['voice:talk']));
    expect(res.status).toBe(200);
  });

  it('resolves a nested method by its router-qualified key', async () => {
    const secret = await key(['voice:talk']);
    expect(resolveScope('voice.laneMode.get')).toBe('voice:talk');
    expect((await call('/rpc/voice/laneMode/get', secret)).status).toBe(200);
  });

  it('refuses the cookie-only voice methods to a bearer, even with voice:talk', async () => {
    const secret = await key(['voice:talk']);
    for (const path of ['/rpc/voice/calls/list', '/rpc/voice/laneMode/set']) {
      const res = await call(path, secret);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('requires cookie authentication');
    }
  });
});
