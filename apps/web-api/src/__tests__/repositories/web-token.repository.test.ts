import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveWebTokenEnv,
  WebTokenEnvError,
  WebTokenRepository,
} from '../../repositories/web-token.repository';

describe('WebTokenRepository', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-web-token-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('getOrCreate generates a 64-char hex token on first call and reuses it after', async () => {
    const repo = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const a = await repo.getOrCreate();
    const b = await repo.getOrCreate();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('matches uses constant-time compare and accepts the stored token', async () => {
    const repo = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const token = await repo.getOrCreate();
    expect(await repo.matches(token)).toBe(true);
    expect(await repo.matches(`${token}!`)).toBe(false);
    expect(await repo.matches('')).toBe(false);
  });

  it('rotate invalidates the previous token', async () => {
    const repo = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const original = await repo.getOrCreate();
    const fresh = await repo.rotate();
    expect(fresh).not.toBe(original);
    expect(await repo.matches(original)).toBe(false);
    expect(await repo.matches(fresh)).toBe(true);
  });

  it('writes the token file with mode 600', async () => {
    const repo = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    await repo.getOrCreate();
    const stats = await stat(join(dir, 'web-token'));
    // Mask off type bits, keep permission bits
    const perms = stats.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});

// web-auth-bootstrap D2 — the ETHOS_WEB_TOKEN override.
describe('resolveWebTokenEnv (D2)', () => {
  it('returns undefined when unset or empty', () => {
    expect(resolveWebTokenEnv(undefined)).toBeUndefined();
    expect(resolveWebTokenEnv('')).toBeUndefined();
  });

  it('FAILS CLOSED on a token under 24 chars, naming openssl rand', () => {
    expect(() => resolveWebTokenEnv('short-token')).toThrow(WebTokenEnvError);
    expect(() => resolveWebTokenEnv('short-token')).toThrow(/openssl rand -hex 32/);
  });

  it('returns a sufficiently long token unchanged', () => {
    const value = 'a'.repeat(24);
    expect(resolveWebTokenEnv(value)).toBe(value);
  });
});

describe('WebTokenRepository with envToken (D2)', () => {
  const ENV_TOKEN = 'env-token-0123456789abcdef0123456789abcdef';

  it('the env value IS the token: matched, returned, never written to disk', async () => {
    const storage = new InMemoryStorage();
    const repo = new WebTokenRepository({ dataDir: '/data', storage, envToken: ENV_TOKEN });
    expect(repo.fromEnv).toBe(true);
    expect(await repo.getOrCreate()).toBe(ENV_TOKEN);
    expect(await repo.matches(ENV_TOKEN)).toBe(true);
    expect(await repo.matches('something-else')).toBe(false);
    // The file is never consulted or created.
    expect(await storage.read('/data/web-token')).toBeNull();
  });

  it('rotate is a no-op under env sourcing — the operator rotates the env value', async () => {
    const storage = new InMemoryStorage();
    const repo = new WebTokenRepository({ dataDir: '/data', storage, envToken: ENV_TOKEN });
    expect(await repo.rotate()).toBe(ENV_TOKEN);
    expect(await storage.read('/data/web-token')).toBeNull();
  });

  it('an existing token FILE is ignored when the env override is set', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/data');
    await storage.write('/data/web-token', 'file-token-abcdefabcdefabcdef\n');
    const repo = new WebTokenRepository({ dataDir: '/data', storage, envToken: ENV_TOKEN });
    expect(await repo.getOrCreate()).toBe(ENV_TOKEN);
    expect(await repo.matches('file-token-abcdefabcdefabcdef')).toBe(false);
  });
});
