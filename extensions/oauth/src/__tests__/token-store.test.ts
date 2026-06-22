import type { CredentialRef, TokenSet } from '@ethosagent/oauth-core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CredentialMeta } from '../token-store';
import { OAuthTokenStore } from '../token-store';

const TOKENS: TokenSet = {
  access_token: 'at_123',
  refresh_token: 'rt_456',
  expires_at: '2025-01-01T00:00:00Z',
  scopes: ['read', 'write'],
  token_type: 'Bearer',
};

const REF: CredentialRef = {
  personalityId: 'alice',
  providerId: 'github',
  profile: 'work',
};

describe('OAuthTokenStore', () => {
  let storage: InMemoryStorage;
  let store: OAuthTokenStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    store = new OAuthTokenStore(storage, '/tokens');
  });

  it('get() returns null for missing credential', async () => {
    const result = await store.get(REF);
    expect(result).toBeNull();
  });

  it('set() then get() round-trips a TokenSet', async () => {
    await store.set(REF, TOKENS);
    const result = await store.get(REF);
    expect(result).toEqual(TOKENS);
  });

  it('delete() removes the credential', async () => {
    await store.set(REF, TOKENS);
    await store.delete(REF);
    const result = await store.get(REF);
    expect(result).toBeNull();
  });

  it('status() returns { present: false } for missing credential', async () => {
    const result = await store.status(REF);
    expect(result).toEqual({ present: false });
  });

  it('status() returns present with expiresAt and scopes for stored credential', async () => {
    await store.set(REF, TOKENS);
    const result = await store.status(REF);
    expect(result).toEqual({
      present: true,
      expiresAt: '2025-01-01T00:00:00Z',
      scopes: ['read', 'write'],
    });
  });

  it('isolates credentials by personalityId', async () => {
    const refBob: CredentialRef = { ...REF, personalityId: 'bob' };
    await store.set(REF, TOKENS);
    await store.set(refBob, { ...TOKENS, access_token: 'at_bob' });
    const alice = await store.get(REF);
    const bob = await store.get(refBob);
    expect(alice?.access_token).toBe('at_123');
    expect(bob?.access_token).toBe('at_bob');
  });

  it('isolates credentials by providerId', async () => {
    const refSlack: CredentialRef = { ...REF, providerId: 'slack' };
    await store.set(REF, TOKENS);
    await store.set(refSlack, { ...TOKENS, access_token: 'at_slack' });
    const github = await store.get(REF);
    const slack = await store.get(refSlack);
    expect(github?.access_token).toBe('at_123');
    expect(slack?.access_token).toBe('at_slack');
  });

  it('defaults profile to "default" when omitted', async () => {
    const refNoProfile: CredentialRef = { personalityId: 'alice', providerId: 'github' };
    await store.set(refNoProfile, TOKENS);
    const result = await store.get(refNoProfile);
    expect(result).toEqual(TOKENS);
    const exists = await storage.exists('/tokens/alice/oauth/github/default.json');
    expect(exists).toBe(true);
  });

  it('throws on invalid providerId', async () => {
    const bad: CredentialRef = { ...REF, providerId: '../escape' };
    await expect(store.get(bad)).rejects.toThrow('Unsafe providerId');
  });

  it('writes token files with mode 0o600', async () => {
    await store.set(REF, TOKENS);
    const path = '/tokens/alice/oauth/github/work.json';
    const mode = storage.getMode(path);
    expect(mode).toBe(0o600);
  });

  describe('credential metadata', () => {
    const META: CredentialMeta = {
      tokenEndpoint: 'https://auth.example.com/token',
      revocationEndpoint: 'https://auth.example.com/revoke',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      clientAuth: 'client_secret_post',
    };

    it('getMeta() returns null for missing metadata', async () => {
      const result = await store.getMeta(REF);
      expect(result).toBeNull();
    });

    it('setMeta() then getMeta() round-trips CredentialMeta', async () => {
      await store.setMeta(REF, META);
      const result = await store.getMeta(REF);
      expect(result).toEqual(META);
    });

    it('deleteMeta() removes the metadata', async () => {
      await store.setMeta(REF, META);
      await store.deleteMeta(REF);
      const result = await store.getMeta(REF);
      expect(result).toBeNull();
    });

    it('stores metadata in a .meta.json file', async () => {
      await store.setMeta(REF, META);
      const exists = await storage.exists('/tokens/alice/oauth/github/work.meta.json');
      expect(exists).toBe(true);
    });

    it('writes meta files with mode 0o600', async () => {
      await store.setMeta(REF, META);
      const mode = storage.getMode('/tokens/alice/oauth/github/work.meta.json');
      expect(mode).toBe(0o600);
    });
  });
});
