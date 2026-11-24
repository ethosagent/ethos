import { hashApiKey, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_ONLY, hashBearerHeader, verifyBearer } from '../../middleware/dual-auth';

// `verifyBearer` is the one bearer enforcer behind `dualAuth` and the node
// socket upgrade. These pin each refusal's code — UNAUTHORIZED for a bad
// credential, FORBIDDEN for a good one used where it is not allowed.
// Ported from the unmerged mobile-app branch (7d15b6df) minus its ANY_KEY cases.

describe('verifyBearer', () => {
  let store: SqliteApiKeyStore;

  beforeEach(() => {
    store = new SqliteApiKeyStore(':memory:');
  });
  afterEach(() => store.close());

  async function key(scopes: string[], allowedOrigins?: string[]) {
    return store.create({
      name: 'k',
      scopes,
      ...(allowedOrigins ? { allowedOrigins } : {}),
    });
  }

  function verify(
    header: string,
    requiredScope: string | (() => string),
    origin?: string,
    lastTouchAt = new Map<string, number>(),
  ) {
    return verifyBearer({ header, origin, apiKeys: store, requiredScope, lastTouchAt });
  }

  async function codeOf(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'ok';
    } catch (err) {
      expect(err).toBeInstanceOf(EthosError);
      return (err as EthosError).code;
    }
  }

  it('returns the key row for a scoped key', async () => {
    const { secret, record } = await key(['sessions:read']);
    const got = await verify(`Bearer ${secret}`, 'sessions:read');
    expect(got.id).toBe(record.id);
  });

  it('resolves a node:host-only key on node:host and refuses it on sessions:read', async () => {
    const { secret, record } = await key(['node:host']);
    expect((await verify(`Bearer ${secret}`, 'node:host')).id).toBe(record.id);
    expect(await codeOf(verify(`Bearer ${secret}`, 'sessions:read'))).toBe('FORBIDDEN');
  });

  it('refuses a non-Bearer scheme and a non sk-ethos- secret as UNAUTHORIZED', async () => {
    const { secret } = await key(['node:host']);
    expect(await codeOf(verify(`Basic ${secret}`, 'node:host'))).toBe('UNAUTHORIZED');
    expect(await codeOf(verify('Bearer nope', 'node:host'))).toBe('UNAUTHORIZED');
  });

  it('refuses an unknown or revoked key as UNAUTHORIZED', async () => {
    expect(await codeOf(verify('Bearer sk-ethos-unknown', 'node:host'))).toBe('UNAUTHORIZED');
    const { secret, record } = await key(['node:host']);
    await store.revoke(record.prefix);
    expect(await codeOf(verify(`Bearer ${secret}`, 'node:host'))).toBe('UNAUTHORIZED');
  });

  it('refuses a revoked row even from a store that returns one', async () => {
    const { secret, record } = await key(['node:host']);
    const leaky = {
      findByHash: async () => ({ ...record, revokedAt: new Date() }),
      touchLastUsed: async () => {},
    };
    const p = verifyBearer({
      header: `Bearer ${secret}`,
      origin: undefined,
      apiKeys: leaky,
      requiredScope: 'node:host',
      lastTouchAt: new Map(),
    });
    expect(await codeOf(p)).toBe('UNAUTHORIZED');
  });

  it("enforces the key's allowedOrigins as FORBIDDEN", async () => {
    const { secret } = await key(['node:host'], ['https://mc.example']);
    expect(await codeOf(verify(`Bearer ${secret}`, 'node:host'))).toBe('FORBIDDEN');
    expect(await codeOf(verify(`Bearer ${secret}`, 'node:host', 'https://evil.example'))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(verify(`Bearer ${secret}`, 'node:host', 'https://mc.example'))).toBe('ok');
  });

  it('refuses a missing scope and COOKIE_ONLY as FORBIDDEN', async () => {
    const { secret } = await key([]);
    await expect(verify(`Bearer ${secret}`, 'node:host')).rejects.toThrow(/node:host/);
    expect(await codeOf(verify(`Bearer ${secret}`, COOKIE_ONLY))).toBe('FORBIDDEN');
  });

  it('resolves a scope thunk only after the key checks out', async () => {
    const thunk = vi.fn(() => 'node:host');
    expect(await codeOf(verify('Bearer sk-ethos-unknown', thunk))).toBe('UNAUTHORIZED');
    expect(thunk).not.toHaveBeenCalled();
    const { secret } = await key(['node:host']);
    expect(await codeOf(verify(`Bearer ${secret}`, thunk))).toBe('ok');
    expect(thunk).toHaveBeenCalledOnce();
  });

  it('throttles touchLastUsed per key through the caller-owned map', async () => {
    const { secret } = await key(['node:host']);
    const touch = vi.spyOn(store, 'touchLastUsed');
    const lastTouchAt = new Map<string, number>();
    await verify(`Bearer ${secret}`, 'node:host', undefined, lastTouchAt);
    await verify(`Bearer ${secret}`, 'node:host', undefined, lastTouchAt);
    expect(touch).toHaveBeenCalledOnce();
  });
});

describe('hashBearerHeader', () => {
  it('hashes the secret exactly as hashApiKey does (the hash findByHash reads)', () => {
    expect(hashBearerHeader('Bearer sk-ethos-abc')).toBe(hashApiKey('sk-ethos-abc'));
  });

  it('returns null for a non-Bearer scheme or a non sk-ethos- secret', () => {
    expect(hashBearerHeader('Basic sk-ethos-abc')).toBeNull();
    expect(hashBearerHeader('Bearer nope')).toBeNull();
    expect(hashBearerHeader('')).toBeNull();
  });
});
