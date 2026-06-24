import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SecretsResolver } from '@ethosagent/types';
import { type CodexCredentials, importFromFile, isTokenExpiringSoon, refreshTokens } from './auth';

const TOKENS_REF = 'providers/codex/tokens';

/**
 * Routes Codex OAuth credentials through the injected SecretsResolver instead
 * of a raw-fs credential file. The stored value is `JSON.stringify(creds)`.
 */
export class CodexTokenStore {
  constructor(private readonly secrets: SecretsResolver) {}

  async load(): Promise<CodexCredentials | null> {
    const raw = await this.secrets.get(TOKENS_REF);
    if (raw != null) return JSON.parse(raw) as CodexCredentials;

    // Nothing in the secret store yet — try a one-time migration / import.
    await this.migrate();
    const migrated = await this.secrets.get(TOKENS_REF);
    return migrated != null ? (JSON.parse(migrated) as CodexCredentials) : null;
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

    const refreshed = await refreshTokens(fetchFn, creds.refreshToken);
    await this.save(refreshed);
    return refreshed;
  }

  private async migrate(): Promise<void> {
    // -------------------------------------------------------------------
    // One-time legacy migration shim — the ONLY tolerated raw-fs path here.
    // The old credential store wrote ~/.ethos/secrets/codex/tokens.json as a
    // plain file. Read it once, fold it into the secret store, then delete
    // the legacy file. Do NOT turn this into a permanent raw-fs read.
    // -------------------------------------------------------------------
    const legacyPath = join(homedir(), '.ethos', 'secrets', 'codex', 'tokens.json');
    try {
      const raw = await readFile(legacyPath, 'utf-8');
      const creds = JSON.parse(raw) as CodexCredentials;
      await this.save(creds);
      try {
        await unlink(legacyPath);
      } catch {
        // Ignore unlink errors — the secret is already persisted.
      }
      return;
    } catch {
      // Absence is normal — fall through to external imports.
    }

    // External imports from the Codex CLI and Hermes auth.json files. These
    // stay raw fs (documented exception): they are foreign credential stores,
    // not ~/.ethos/ state.
    const codexImport = await importFromFile(join(homedir(), '.codex', 'auth.json'));
    if (codexImport) {
      await this.save(codexImport);
      return;
    }

    const hermesImport = await importFromFile(join(homedir(), '.hermes', 'auth.json'));
    if (hermesImport) {
      await this.save(hermesImport);
      return;
    }
  }
}
