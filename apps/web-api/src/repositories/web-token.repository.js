import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';

// File-backed store for the single web-UI auth token. The token lives at
// `<dataDir>/web-token` chmod 600 — same posture as `~/.ssh/id_*`.
//
// Two scenarios this needs to handle:
//   1. First run — no file exists. Generate a 32-byte hex token, write it,
//      print the URL with `?t=<token>`. Subsequent boots reuse the same token.
//   2. URL exchange — the user opens `?t=<token>`. We compare against the
//      stored value with `timingSafeEqual`, then ROTATE (write a new token,
//      invalidating the URL one). The cookie auth issued in the same step
//      becomes the steady-state credential.
//
// Stays as a web-api-internal repository (no extension counterpart) and
// routes its disk IO through Storage.
const TOKEN_BYTES = 32;
export class WebTokenRepository {
  storage;
  path;
  dir;
  constructor(opts) {
    this.storage = opts.storage ?? new FsStorage();
    this.dir = opts.dataDir;
    this.path = join(opts.dataDir, 'web-token');
  }
  /**
   * Read the current token, generating one on first call if the file is
   * missing. Always returns a usable token string. The file is chmod 600
   * via writeAtomic's mode option so the token never touches disk with
   * default umask permissions.
   */
  async getOrCreate() {
    const existing = await this.read();
    if (existing) return existing;
    const token = generateToken();
    await this.persist(token);
    return token;
  }
  /**
   * Constant-time compare against the stored token. Returns false on
   * length mismatch or missing file (rather than throwing) so callers can
   * treat invalid attempts uniformly.
   */
  async matches(candidate) {
    const stored = await this.read();
    if (!stored) return false;
    const a = Buffer.from(stored, 'utf-8');
    const b = Buffer.from(candidate, 'utf-8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
  /** Generate + persist a fresh token, returning the new value. Used after
   *  successful URL exchange to invalidate the URL token. */
  async rotate() {
    const token = generateToken();
    await this.persist(token);
    return token;
  }
  async read() {
    const raw = await this.storage.read(this.path);
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed || null;
  }
  async persist(token) {
    await this.storage.mkdir(this.dir);
    // writeAtomic = tmp + rename, mode applied to tmp before rename so the
    // final file is created with 0o600 from the moment it exists.
    await this.storage.writeAtomic(this.path, `${token}\n`, { mode: 0o600 });
  }
}
function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}
