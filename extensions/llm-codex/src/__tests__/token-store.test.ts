import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexCredentials } from '../auth';
import { CodexTokenStore } from '../token-store';

/** Build a 3-part JWT whose payload carries the given `exp` (epoch seconds). */
function jwtWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp, sub: 'acct-123' })).toString('base64url');
  return `x.${payload}.x`;
}

function makeCreds(expiresInSeconds: number): CodexCredentials {
  const exp = Math.floor(Date.now() / 1_000) + expiresInSeconds;
  return {
    accessToken: jwtWithExp(exp),
    refreshToken: 'refresh-token',
    idToken: jwtWithExp(exp),
    accountId: 'acct-123',
    expiresAt: new Date(exp * 1_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('CodexTokenStore', () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  // Point HOME at an empty tmp dir so migrate() never reads the real
  // ~/.ethos, ~/.codex, or ~/.hermes during the absence/round-trip tests.
  beforeEach(async () => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    tmpHome = await mkdtemp(join(tmpdir(), 'codex-token-store-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('round-trips save → load', async () => {
    const store = new CodexTokenStore(new InMemorySecretsResolver());
    const creds = makeCreds(3_600);
    await store.save(creds);
    expect(await store.load()).toEqual(creds);
  });

  it('returns null when no credentials exist', async () => {
    const store = new CodexTokenStore(new InMemorySecretsResolver());
    expect(await store.load()).toBeNull();
  });

  it('refreshes and persists an expiring token via ensureValid', async () => {
    const store = new CodexTokenStore(new InMemorySecretsResolver());
    await store.save(makeCreds(-60)); // already expired

    const freshAccess = jwtWithExp(Math.floor(Date.now() / 1_000) + 3_600);
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: freshAccess,
        refresh_token: 'new-refresh',
        id_token: 'a.b.c',
      }),
    })) as unknown as typeof globalThis.fetch;

    const refreshed = await store.ensureValid(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(refreshed.accessToken).toBe(freshAccess);
    expect(refreshed.refreshToken).toBe('new-refresh');

    // The refreshed token was saved — a fresh load returns it.
    const reloaded = await store.load();
    expect(reloaded?.accessToken).toBe(freshAccess);
  });

  it('migrates a legacy ~/.ethos tokens.json file then deletes it', async () => {
    const legacyDir = join(tmpHome, '.ethos', 'secrets', 'codex');
    const legacyPath = join(legacyDir, 'tokens.json');
    await mkdir(legacyDir, { recursive: true });
    const creds = makeCreds(3_600);
    await writeFile(legacyPath, JSON.stringify(creds), 'utf-8');

    const store = new CodexTokenStore(new InMemorySecretsResolver());
    expect(await store.load()).toEqual(creds);

    // Legacy file is removed after migration.
    await expect(access(legacyPath)).rejects.toThrow();

    // A second load (now from the secret store) still returns the creds.
    expect(await store.load()).toEqual(creds);
  });
});
