import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import argon2 from 'argon2';
import { requireStorage } from './require-storage';

// File-backed store for the single web-UI admin account (web-auth-bootstrap
// D3). The record lives at `<dataDir>/web-admin.json` chmod 600 — same
// posture as `<dataDir>/web-token`. A SINGLE admin record, not a map: D15
// keeps multi-user additive later.
//
// Password storage is an argon2id PHC string. The cost profile matches
// storage-crypto's key derivation (extensions/storage-crypto/src/
// crypto-storage.ts `deriveKey`): timeCost 3, memoryCost 65536 (64 MiB),
// parallelism 1 — the two must stay in step deliberately, so a cost review
// covers both.

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  timeCost: 3,
  memoryCost: 65536,
  parallelism: 1,
} as const;

/**
 * A real argon2id hash (of a throwaway string, same cost profile) verified
 * against when the instance is unclaimed or the username does not match, so a
 * failed login costs the same wall-clock whether the username exists or not
 * (D14: uniform-time failures).
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$XNPnYrM2slgRu48/AvV9ug$qQ96YyU8mCOU/AchepUlYQmkoOt8VvcmT8xpUfX6pdE';

export interface WebAdminRecord {
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebAdminCredentials {
  username: string;
  password: string;
}

export interface WebAdminRepositoryOptions {
  /** Where `~/.ethos` lives. The record file is `<dataDir>/web-admin.json`. */
  dataDir: string;
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
}

export class WebAdminRepository {
  private readonly storage: Storage;
  private readonly path: string;
  private readonly dir: string;

  constructor(opts: WebAdminRepositoryOptions) {
    this.storage = requireStorage(opts.storage, 'WebAdminRepository');
    this.dir = opts.dataDir;
    this.path = join(opts.dataDir, 'web-admin.json');
  }

  /** True once an admin record exists — the instance is "claimed" (D10). */
  async isClaimed(): Promise<boolean> {
    return (await this.read()) !== null;
  }

  /**
   * First-time claim: hash the password and write the record. Refuses when a
   * record already exists — re-claiming goes through `reset` (token-gated at
   * the route), never through the wizard path.
   */
  async claim(creds: WebAdminCredentials): Promise<void> {
    if (await this.isClaimed()) {
      throw new Error('web-admin.json already exists — use reset to re-claim');
    }
    const now = new Date().toISOString();
    await this.persist({
      username: creds.username,
      passwordHash: await argon2.hash(creds.password, ARGON2_OPTIONS),
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Verify a username + password pair. Uniform-time on failure: when the
   * instance is unclaimed or the username does not match, an argon2 verify
   * still runs against `DUMMY_HASH`, so wrong-user and wrong-password cost
   * the same and the response cannot distinguish them.
   */
  async verify(creds: WebAdminCredentials): Promise<boolean> {
    const record = await this.read();
    if (record && record.username === creds.username) {
      return argon2.verify(record.passwordHash, creds.password).catch(() => false);
    }
    await argon2.verify(DUMMY_HASH, creds.password).catch(() => false);
    return false;
  }

  /**
   * Re-claim with fresh credentials (D6). Overwrites the record whether or
   * not one exists; the original `createdAt` is preserved when it does.
   * Session invalidation is the caller's job — the repository owns only the
   * credential record.
   */
  async reset(creds: WebAdminCredentials): Promise<void> {
    const existing = await this.read();
    const now = new Date().toISOString();
    await this.persist({
      username: creds.username,
      passwordHash: await argon2.hash(creds.password, ARGON2_OPTIONS),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private async read(): Promise<WebAdminRecord | null> {
    const raw = await this.storage.read(this.path);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<WebAdminRecord>;
      if (typeof parsed.username !== 'string' || typeof parsed.passwordHash !== 'string') {
        return null;
      }
      return {
        username: parsed.username,
        passwordHash: parsed.passwordHash,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      };
    } catch {
      return null;
    }
  }

  private async persist(record: WebAdminRecord): Promise<void> {
    await this.storage.mkdir(this.dir);
    // writeAtomic = tmp + rename, mode applied before rename — the record is
    // 0600 from the moment it exists (same posture as web-token).
    await this.storage.writeAtomic(this.path, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
