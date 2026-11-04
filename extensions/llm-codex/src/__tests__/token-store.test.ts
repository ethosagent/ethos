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
    // `home` is injected so a developer's own ~/.codex cannot change the result.
    const store = new CodexTokenStore(new InMemorySecretsResolver(), { home: tmpHome });
    expect(await store.load()).toBeNull();
  });

  async function writeExternal(dir: '.codex' | '.hermes', creds = nestedFile()): Promise<void> {
    await mkdir(join(tmpHome, dir), { recursive: true });
    await writeFile(join(tmpHome, dir, 'auth.json'), JSON.stringify(creds), 'utf-8');
  }

  function nestedFile(withRefresh = true) {
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    return {
      tokens: {
        access_token: jwtWithExp(exp),
        ...(withRefresh ? { refresh_token: 'ext-refresh' } : {}),
        id_token: jwtWithExp(exp),
        account_id: 'acct-ext',
      },
    };
  }

  it('load() does not import ~/.codex/auth.json or ~/.hermes/auth.json', async () => {
    await writeExternal('.codex');
    await writeExternal('.hermes');
    const secrets = new InMemorySecretsResolver();
    const store = new CodexTokenStore(secrets, { home: tmpHome });
    expect(await store.load()).toBeNull();
    expect(await secrets.get('providers/codex/tokens')).toBeNull();
  });

  it('load() still folds the legacy ~/.ethos tokens.json (injected home)', async () => {
    const legacyDir = join(tmpHome, '.ethos', 'secrets', 'codex');
    await mkdir(legacyDir, { recursive: true });
    const creds = makeCreds(3_600);
    await writeFile(join(legacyDir, 'tokens.json'), JSON.stringify(creds), 'utf-8');
    const store = new CodexTokenStore(new InMemorySecretsResolver(), { home: tmpHome });
    expect(await store.load()).toEqual(creds);
    await expect(access(join(legacyDir, 'tokens.json'))).rejects.toThrow();
  });

  it("importExternal('codex-cli') saves to providers/codex/tokens only when called", async () => {
    await writeExternal('.codex');
    const secrets = new InMemorySecretsResolver();
    const store = new CodexTokenStore(secrets, { home: tmpHome });
    expect(await secrets.get('providers/codex/tokens')).toBeNull();
    expect(await store.importExternal('codex-cli')).toEqual({ ok: true });
    expect((await store.load())?.refreshToken).toBe('ext-refresh');
  });

  it("importExternal('hermes') reads ~/.hermes/auth.json", async () => {
    await writeExternal('.hermes');
    const store = new CodexTokenStore(new InMemorySecretsResolver(), { home: tmpHome });
    expect(await store.importExternal('hermes')).toEqual({ ok: true });
    expect((await store.load())?.accountId).toBe('acct-ext');
  });

  it('importExternal returns absent for a missing file and writes nothing', async () => {
    const secrets = new InMemorySecretsResolver();
    const store = new CodexTokenStore(secrets, { home: tmpHome });
    expect(await store.importExternal('codex-cli')).toEqual({ ok: false, reason: 'absent' });
    expect(await secrets.get('providers/codex/tokens')).toBeNull();
  });

  it('importExternal returns invalid_shape for a file missing a token and writes nothing', async () => {
    await writeExternal('.codex', nestedFile(false));
    const secrets = new InMemorySecretsResolver();
    const store = new CodexTokenStore(secrets, { home: tmpHome });
    expect(await store.importExternal('codex-cli')).toEqual({
      ok: false,
      reason: 'invalid_shape',
    });
    expect(await secrets.get('providers/codex/tokens')).toBeNull();
  });

  it('peek() reads the vault without migrating or importing', async () => {
    await writeExternal('.codex');
    const legacyDir = join(tmpHome, '.ethos', 'secrets', 'codex');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'tokens.json'), JSON.stringify(makeCreds(3_600)), 'utf-8');
    const secrets = new InMemorySecretsResolver();
    const store = new CodexTokenStore(secrets, { home: tmpHome });
    expect(await store.peek()).toBeNull();
    // legacy file untouched, nothing saved
    await expect(access(join(legacyDir, 'tokens.json'))).resolves.toBeUndefined();
    expect(await secrets.get('providers/codex/tokens')).toBeNull();
    const creds = makeCreds(3_600);
    await store.save(creds);
    expect(await store.peek()).toEqual(creds);
  });

  it('peek() returns null for a corrupt vault entry', async () => {
    const secrets = new InMemorySecretsResolver();
    const store = new CodexTokenStore(secrets, { home: tmpHome });
    await secrets.set('providers/codex/tokens', '{not json');
    expect(await store.peek()).toBeNull();
    await secrets.set('providers/codex/tokens', JSON.stringify({ accessToken: 1 }));
    expect(await store.peek()).toBeNull();
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

  it('two concurrent callers make one refresh', async () => {
    const store = new CodexTokenStore(new InMemorySecretsResolver());
    await store.save(makeCreds(-60)); // already expired

    const freshAccess = jwtWithExp(Math.floor(Date.now() / 1_000) + 3_600);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn(async () => {
      await gate; // hold the refresh open until both callers are waiting on it
      return {
        ok: true,
        json: async () => ({
          access_token: freshAccess,
          refresh_token: 'new-refresh',
          id_token: 'a.b.c',
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    const first = store.ensureValid(fetchFn);
    const second = store.ensureValid(fetchFn);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe(freshAccess);
    expect(b.accessToken).toBe(freshAccess);
    expect((await store.load())?.refreshToken).toBe('new-refresh');

    // The token is fresh now: a later caller neither refreshes nor waits.
    await store.ensureValid(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a failed shared refresh rejects every caller, saves nothing, and the next call retries', async () => {
    const store = new CodexTokenStore(new InMemorySecretsResolver());
    const expired = makeCreds(-60);
    await store.save(expired);

    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    })) as unknown as typeof globalThis.fetch;

    const results = await Promise.allSettled([
      store.ensureValid(fetchFn),
      store.ensureValid(fetchFn),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect(String(r.reason)).toMatch(/Token refresh failed \(400\)/);
    }
    // Nothing was saved over the stored credentials.
    expect(await store.load()).toEqual(expired);

    // The in-flight slot was cleared: a later call makes its own attempt.
    await expect(store.ensureValid(fetchFn)).rejects.toThrow(/Token refresh failed/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
