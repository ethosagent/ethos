import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CredentialRef, TokenSet } from '@ethosagent/oauth-core';
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
});
