import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { WebAdminRepository } from '../../repositories/web-admin.repository';

// web-auth-bootstrap D3 — the single admin record behind the setup wizard.
// argon2id hashing at the storage-crypto cost profile is deliberately slow,
// so this file keeps the number of hash/verify calls small.

const DIR = '/data';

describe('WebAdminRepository', () => {
  let storage: InMemoryStorage;
  let repo: WebAdminRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    repo = new WebAdminRepository({ dataDir: DIR, storage });
  });

  it('is unclaimed until claim() writes the record', async () => {
    expect(await repo.isClaimed()).toBe(false);
    await repo.claim({ username: 'admin', password: 'correct-horse-battery' });
    expect(await repo.isClaimed()).toBe(true);
    const raw = await storage.read(`${DIR}/web-admin.json`);
    expect(raw).toBeTruthy();
    const record = JSON.parse(raw as string) as { username: string; passwordHash: string };
    expect(record.username).toBe('admin');
    // argon2id PHC string, never a plaintext or SHA-256 (D14).
    expect(record.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  });

  it('verify accepts the claimed credentials and rejects everything else', async () => {
    await repo.claim({ username: 'admin', password: 'correct-horse-battery' });
    expect(await repo.verify({ username: 'admin', password: 'correct-horse-battery' })).toBe(true);
    // Wrong password and unknown username both return plain false — the
    // unknown-username path still runs a dummy argon2 verify (uniform-time).
    expect(await repo.verify({ username: 'admin', password: 'wrong-password-xx' })).toBe(false);
    expect(await repo.verify({ username: 'nobody', password: 'correct-horse-battery' })).toBe(
      false,
    );
  });

  it('verify on an unclaimed instance returns false (no throw)', async () => {
    expect(await repo.verify({ username: 'admin', password: 'anything-at-all' })).toBe(false);
  });

  it('claim refuses a second claim — re-claiming goes through reset', async () => {
    await repo.claim({ username: 'admin', password: 'correct-horse-battery' });
    await expect(repo.claim({ username: 'evil', password: 'attacker-password' })).rejects.toThrow(
      /already exists/,
    );
  });

  it('reset replaces the credentials and preserves createdAt', async () => {
    await repo.claim({ username: 'admin', password: 'correct-horse-battery' });
    const before = JSON.parse((await storage.read(`${DIR}/web-admin.json`)) as string) as {
      createdAt: string;
    };
    await repo.reset({ username: 'admin2', password: 'fresh-password-123' });
    const after = JSON.parse((await storage.read(`${DIR}/web-admin.json`)) as string) as {
      username: string;
      createdAt: string;
    };
    expect(after.username).toBe('admin2');
    expect(after.createdAt).toBe(before.createdAt);
    expect(await repo.verify({ username: 'admin2', password: 'fresh-password-123' })).toBe(true);
    expect(await repo.verify({ username: 'admin', password: 'correct-horse-battery' })).toBe(false);
  });
});
