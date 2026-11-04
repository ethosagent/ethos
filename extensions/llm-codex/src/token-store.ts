import { access, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SecretsResolver } from '@ethosagent/types';
import { z } from 'zod';
import { type CodexCredentials, importFromFile, isTokenExpiringSoon, refreshTokens } from './auth';

export type ExternalLoginSource = 'codex-cli' | 'hermes';
export type ImportExternalResult = { ok: true } | { ok: false; reason: 'absent' | 'invalid_shape' };

const EXTERNAL_PATHS: Record<ExternalLoginSource, readonly [string, string]> = {
  'codex-cli': ['.codex', 'auth.json'],
  hermes: ['.hermes', 'auth.json'],
};

const TOKENS_REF = 'providers/codex/tokens';

const StoredCredentialsSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  idToken: z.string(),
  accountId: z.string(),
  expiresAt: z.string(),
  updatedAt: z.string(),
});

/** Parse a stored credentials blob; corrupt or wrong-shaped input yields null. */
function parseStored(raw: string): CodexCredentials | null {
  try {
    const parsed = StoredCredentialsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Routes Codex OAuth credentials through the injected SecretsResolver instead
 * of a raw-fs credential file. The stored value is `JSON.stringify(creds)`.
 */
export class CodexTokenStore {
  /**
   * The refresh in flight, shared by every concurrent `ensureValid` caller so
   * an expiring token is refreshed once rather than once per caller (a
   * refresh token can be single-use, so a second request can fail or revoke
   * the first). Cleared when it settles, success or failure. Pinned by
   * `__tests__/token-store.test.ts` "two concurrent callers make one refresh".
   */
  private refreshing: Promise<CodexCredentials> | null = null;

  private readonly home: string;

  /** `home` is injectable so tests are hermetic; default is the OS home. */
  constructor(
    private readonly secrets: SecretsResolver,
    opts: { home?: string } = {},
  ) {
    this.home = opts.home ?? homedir();
  }

  /** Absolute path of an external login file (detection only reads it). */
  externalPath(source: ExternalLoginSource): string {
    return join(this.home, ...EXTERNAL_PATHS[source]);
  }

  /** Non-migrating read of the vault entry: no legacy fold, no external import. */
  async peek(): Promise<CodexCredentials | null> {
    const raw = await this.secrets.get(TOKENS_REF);
    return raw != null ? parseStored(raw) : null;
  }

  /**
   * Copy an external Codex CLI / Hermes login into `providers/codex/tokens`.
   * Callers must have obtained explicit consent first (plan D3); `load()` never
   * does this (pinned by `__tests__/token-store.test.ts` "load() does not import").
   * Token values are never returned or logged.
   */
  async importExternal(source: ExternalLoginSource): Promise<ImportExternalResult> {
    const path = this.externalPath(source);
    try {
      await access(path);
    } catch {
      return { ok: false, reason: 'absent' };
    }
    const creds = await importFromFile(path);
    if (!creds) return { ok: false, reason: 'invalid_shape' };
    await this.save(creds);
    return { ok: true };
  }

  async load(): Promise<CodexCredentials | null> {
    const raw = await this.secrets.get(TOKENS_REF);
    if (raw != null) return parseStored(raw);

    // Nothing in the secret store yet — try a one-time migration / import.
    await this.migrate();
    const migrated = await this.secrets.get(TOKENS_REF);
    return migrated != null ? parseStored(migrated) : null;
  }

  async save(creds: CodexCredentials): Promise<void> {
    await this.secrets.set(TOKENS_REF, JSON.stringify(creds));
  }

  async ensureValid(fetchFn: typeof globalThis.fetch): Promise<CodexCredentials> {
    const creds = await this.load();
    if (!creds) {
      throw new Error('No Codex credentials found. Run the device auth flow first.');
    }
    if (!isTokenExpiringSoon(creds)) return creds;

    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          // Only a successful refresh is saved — a thrown refresh leaves the
          // stored credentials untouched.
          const refreshed = await refreshTokens(fetchFn, creds.refreshToken);
          await this.save(refreshed);
          return refreshed;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  private async migrate(): Promise<void> {
    // -------------------------------------------------------------------
    // One-time legacy migration shim — the ONLY tolerated raw-fs path here.
    // The old credential store wrote ~/.ethos/secrets/codex/tokens.json as a
    // plain file. Read it once, fold it into the secret store, then delete
    // the legacy file. Do NOT turn this into a permanent raw-fs read.
    // -------------------------------------------------------------------
    const legacyPath = join(this.home, '.ethos', 'secrets', 'codex', 'tokens.json');
    try {
      const raw = await readFile(legacyPath, 'utf-8');
      const creds = parseStored(raw);
      if (!creds) return;
      await this.save(creds);
      try {
        await unlink(legacyPath);
      } catch {
        // Ignore unlink errors — the secret is already persisted.
      }
      return;
    } catch {
      // Absence is normal. External logins are NOT imported here (see importExternal).
    }
  }
}
