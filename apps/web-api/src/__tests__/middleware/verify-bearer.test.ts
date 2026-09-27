import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANY_KEY, COOKIE_ONLY, verifyBearer } from '../../middleware/dual-auth';

// `verifyBearer` is the one bearer enforcer behind `dualAuth` and the voice
// socket upgrade. These pin each refusal's code — UNAUTHORIZED for a bad
// credential, FORBIDDEN for a good one used where it is not allowed.

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
    const { secret, record } = await key(['voice:talk']);
    const got = await verify(`Bearer ${secret}`, 'voice:talk');
    expect(got.id).toBe(record.id);
  });

  it('refuses a non-Bearer scheme and a non sk-ethos- secret as UNAUTHORIZED', async () => {
    const { secret } = await key(['voice:talk']);
    expect(await codeOf(verify(`Basic ${secret}`, 'voice:talk'))).toBe('UNAUTHORIZED');
    expect(await codeOf(verify('Bearer nope', 'voice:talk'))).toBe('UNAUTHORIZED');
  });

  it('refuses an unknown or revoked key as UNAUTHORIZED', async () => {
    expect(await codeOf(verify('Bearer sk-ethos-unknown', 'voice:talk'))).toBe('UNAUTHORIZED');
    const { secret, record } = await key(['voice:talk']);
    await store.revoke(record.prefix);
    expect(await codeOf(verify(`Bearer ${secret}`, 'voice:talk'))).toBe('UNAUTHORIZED');
  });

  it('refuses a revoked row even from a store that returns one', async () => {
    const { secret, record } = await key(['voice:talk']);
    const leaky = {
      findByHash: async () => ({ ...record, revokedAt: new Date() }),
      touchLastUsed: async () => {},
    };
    const p = verifyBearer({
      header: `Bearer ${secret}`,
      origin: undefined,
      apiKeys: leaky,
      requiredScope: 'voice:talk',
      lastTouchAt: new Map(),
    });
    expect(await codeOf(p)).toBe('UNAUTHORIZED');
  });

  it("enforces the key's allowedOrigins as FORBIDDEN", async () => {
    const { secret } = await key(['voice:talk'], ['https://mc.example']);
    expect(await codeOf(verify(`Bearer ${secret}`, 'voice:talk'))).toBe('FORBIDDEN');
    expect(await codeOf(verify(`Bearer ${secret}`, 'voice:talk', 'https://evil.example'))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(verify(`Bearer ${secret}`, 'voice:talk', 'https://mc.example'))).toBe('ok');
  });

  it('refuses a missing scope and COOKIE_ONLY as FORBIDDEN; ANY_KEY needs no scope', async () => {
    const { secret } = await key([]);
    await expect(verify(`Bearer ${secret}`, 'voice:talk')).rejects.toThrow(/voice:talk/);
    expect(await codeOf(verify(`Bearer ${secret}`, COOKIE_ONLY))).toBe('FORBIDDEN');
    expect(await codeOf(verify(`Bearer ${secret}`, ANY_KEY))).toBe('ok');
  });

  it('resolves a scope thunk only after the key checks out', async () => {
    const thunk = vi.fn(() => 'voice:talk');
    expect(await codeOf(verify('Bearer sk-ethos-unknown', thunk))).toBe('UNAUTHORIZED');
    expect(thunk).not.toHaveBeenCalled();
    const { secret } = await key(['voice:talk']);
    expect(await codeOf(verify(`Bearer ${secret}`, thunk))).toBe('ok');
    expect(thunk).toHaveBeenCalledOnce();
  });

  it('throttles touchLastUsed per key through the caller-owned map', async () => {
    const { secret } = await key(['voice:talk']);
    const touch = vi.spyOn(store, 'touchLastUsed');
    const lastTouchAt = new Map<string, number>();
    await verify(`Bearer ${secret}`, 'voice:talk', undefined, lastTouchAt);
    await verify(`Bearer ${secret}`, 'voice:talk', undefined, lastTouchAt);
    expect(touch).toHaveBeenCalledOnce();
  });
});
