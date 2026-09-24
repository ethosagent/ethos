import { EthosError, type SecretsResolver } from '@ethosagent/types';
import {
  CredentialValidationError,
  type CredentialView,
  deleteCredential,
  listCredentials,
  setCredential,
} from '@ethosagent/wiring';

// Stored logins for `browser_fill_credential` (plan reach-and-containment
// §4.2) — the "Logins" section of Settings › Security.
//
// A login is four vault refs under `credentials/<name>/` (username, password,
// optional TOTP seed, policy). Values are WRITE-ONLY from the client's side:
// `list` returns the masked username preview (`redactSecretValue`) and
// presence flags, never a value, and `set` echoes nothing back. Validation —
// name shape, bare https origins (http on loopback only), personality ids,
// TOTP seeds the generator can honour — and the vault layout live in
// `extensions/tools-browser/src/credential-vault.ts`, reached through
// `@ethosagent/wiring`: the same code the CLI writes through and the tool
// reads back. This service only translates its errors into `EthosError`.
//
// Deliberately separate from `NamedSecretsService` (D4-9): a login is not a
// provider key, and `credentials/*` is not a `providers/<segment>/*` prefix,
// so it never enters the named-secret picker.

export interface CredentialsServiceOptions {
  secrets: SecretsResolver;
}

export interface CredentialSetInput {
  name: string;
  /** Required for a new credential; absent keeps the stored value. */
  username?: string;
  /** Required for a new credential; absent keeps the stored value. */
  password?: string;
  /** Absent keeps the stored seed; `null` or `''` removes it. */
  totp?: string | null;
  origins: string[];
  personalities: string[];
  unattended: boolean;
}

export class CredentialsService {
  constructor(private readonly opts: CredentialsServiceOptions) {}

  async list(): Promise<{ credentials: CredentialView[] }> {
    return { credentials: await listCredentials(this.opts.secrets) };
  }

  async set(input: CredentialSetInput): Promise<{ ok: true }> {
    try {
      await setCredential(this.opts.secrets, {
        name: input.name,
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.password !== undefined ? { password: input.password } : {}),
        ...(input.totp !== undefined ? { totp: input.totp } : {}),
        origins: input.origins,
        personalities: input.personalities,
        unattended: input.unattended,
      });
    } catch (err) {
      throw translate(err);
    }
    return { ok: true };
  }

  async delete(input: { name: string }): Promise<{ ok: true }> {
    try {
      await deleteCredential(this.opts.secrets, input.name);
    } catch (err) {
      throw translate(err);
    }
    return { ok: true };
  }
}

function translate(err: unknown): unknown {
  if (err instanceof CredentialValidationError) {
    return new EthosError({
      code: 'INVALID_INPUT',
      cause: err.message,
      action: err.hint ?? 'Correct the field and save again.',
    });
  }
  return err;
}
