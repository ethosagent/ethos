import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { requireStorage } from './require-storage';

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

/** `ETHOS_WEB_TOKEN` must carry enough entropy to be a bootstrap credential. */
const ENV_TOKEN_MIN_LENGTH = 24;

/** Named startup failure for a too-weak `ETHOS_WEB_TOKEN` (D2: fail closed). */
export class WebTokenEnvError extends Error {
  override readonly name = 'WebTokenEnvError';
}

/**
 * Resolve the `ETHOS_WEB_TOKEN` env override (D2). Returns the token when the
 * variable is set, `undefined` when it is absent or empty. A set-but-short
 * value FAILS CLOSED with a named error — a weak bootstrap token silently
 * accepted would be the whole deployment's credential.
 */
export function resolveWebTokenEnv(
  value: string | undefined = process.env.ETHOS_WEB_TOKEN,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.length < ENV_TOKEN_MIN_LENGTH) {
    throw new WebTokenEnvError(
      `ETHOS_WEB_TOKEN is too short (${value.length} chars; minimum ${ENV_TOKEN_MIN_LENGTH}). ` +
        'Generate a strong token with `openssl rand -hex 32` and set it as ETHOS_WEB_TOKEN.',
    );
  }
  return value;
}

export interface WebTokenRepositoryOptions {
  /** Where `~/.ethos` lives. The token file is `<dataDir>/web-token`. */
  dataDir: string;
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
  /**
   * `ETHOS_WEB_TOKEN` override (D2), already validated via
   * `resolveWebTokenEnv`. When set, the token IS this value: the file is
   * never consulted, never created, and never rotated.
   */
  envToken?: string;
}

export class WebTokenRepository {
  private readonly storage: Storage;
  private readonly path: string;
  private readonly dir: string;
  private readonly envToken: string | undefined;

  constructor(opts: WebTokenRepositoryOptions) {
    this.storage = requireStorage(opts.storage, 'WebTokenRepository');
    this.dir = opts.dataDir;
    this.path = join(opts.dataDir, 'web-token');
    this.envToken = opts.envToken;
  }

  /** True when the token comes from `ETHOS_WEB_TOKEN` rather than the file. */
  get fromEnv(): boolean {
    return this.envToken !== undefined;
  }

  /**
   * Read the current token, generating one on first call if the file is
   * missing. Always returns a usable token string. The file is chmod 600
   * via writeAtomic's mode option so the token never touches disk with
   * default umask permissions.
   */
  async getOrCreate(): Promise<string> {
    if (this.envToken !== undefined) return this.envToken;
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
  async matches(candidate: string): Promise<boolean> {
    const stored = this.envToken !== undefined ? this.envToken : await this.read();
    if (!stored) return false;
    const a = Buffer.from(stored, 'utf-8');
    const b = Buffer.from(candidate, 'utf-8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Generate + persist a fresh token, returning the new value. No longer
   *  called by the exchange path (D7: rotation is untied from exchange); kept
   *  for explicit operator-driven rotation. Env-sourced tokens (D2) are never
   *  rotated — the operator rotates the env value. */
  async rotate(): Promise<string> {
    if (this.envToken !== undefined) return this.envToken;
    const token = generateToken();
    await this.persist(token);
    return token;
  }

  private async read(): Promise<string | null> {
    const raw = await this.storage.read(this.path);
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed || null;
  }

  private async persist(token: string): Promise<void> {
    await this.storage.mkdir(this.dir);
    // writeAtomic = tmp + rename, mode applied to tmp before rename so the
    // final file is created with 0o600 from the moment it exists.
    await this.storage.writeAtomic(this.path, `${token}\n`, { mode: 0o600 });
  }
}

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}
