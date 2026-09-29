import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CookieVerifier, createCookieVerifier } from '../../middleware/cookie-verifier';
import { WebSessionStore } from '../../repositories/web-session.store';
import { WebTokenRepository } from '../../repositories/web-token.repository';

// web-auth-bootstrap D4 — THE dual-accept: a cookie value authenticates when
// it is a live session id OR the raw bootstrap token. This is the enforcer of
// record for that guarantee (D14): every HTTP auth middleware and all three
// WebSocket lanes route through `createCookieVerifier`.

const DIR = '/data';

describe('createCookieVerifier (D4 dual-accept)', () => {
  let verify: CookieVerifier;
  let sessions: WebSessionStore;
  let tokens: WebTokenRepository;

  beforeEach(() => {
    const storage = new InMemoryStorage();
    tokens = new WebTokenRepository({ dataDir: DIR, storage });
    sessions = new WebSessionStore({ dataDir: DIR, storage });
    verify = createCookieVerifier({ tokens, sessions });
  });

  it('accepts a live session id', async () => {
    const id = await sessions.create();
    expect(await verify(id)).toBe(true);
  });

  it('accepts the raw bootstrap token (machine clients, plan §1.2)', async () => {
    const token = await tokens.getOrCreate();
    expect(await verify(token)).toBe(true);
  });

  it('rejects garbage, an invalidated session, and the empty string', async () => {
    await tokens.getOrCreate();
    const id = await sessions.create();
    expect(await verify('deadbeef'.repeat(8))).toBe(false);
    expect(await verify('')).toBe(false);
    await sessions.invalidateAll();
    expect(await verify(id)).toBe(false);
  });
});
