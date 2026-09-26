// ---------------------------------------------------------------------------
// Stored logins for `browser_fill_credential` (plan reach-and-containment §4.2)
// ---------------------------------------------------------------------------
//
// A credential named `<name>` is four vault refs under `credentials/<name>/`:
//
//   username   the login name
//   password   the password
//   totp       optional — a base32 seed or an otpauth://totp/ URI (D4-7)
//   policy     JSON `{ origins, personalities, unattended }` (D4-2)
//
// `policy` is operator metadata, not a secret, but it lives in the vault so the
// grant sits beside what it grants and cannot be edited from a personality
// directory. The namespace is `credentials/`, not `providers/` (D4-9), so a
// login never appears in the named-secret picker and `NamedSecretsService`
// cannot write a half-formed one.
//
// This module is the ONE place both store surfaces — `ethos secrets credential`
// (apps/ethos) and `CredentialsService` (apps/web-api) — validate and write a
// login, and the one place the tool parses a policy back. It imports nothing
// but `@ethosagent/types` and `./totp`, so re-exporting it through
// `@ethosagent/wiring` pulls no Playwright into either app.

import { isValidSecretName, redactSecretValue, type SecretsResolver } from '@ethosagent/types';
import { parseTotpSeed, TotpSeedError } from './totp';

export const CREDENTIALS_PREFIX = 'credentials/';

export type CredentialField = 'username' | 'password' | 'totp' | 'policy';

export const CREDENTIAL_FIELDS: readonly CredentialField[] = [
  'username',
  'password',
  'totp',
  'policy',
];

export interface CredentialPolicy {
  /** Full origins (`https://github.com`), compared with `===` against `URL.origin` (D4-3). */
  origins: string[];
  /** Personality ids allowed to use this login. Empty → usable by nobody (D4-2). */
  personalities: string[];
  /** Allow fills from background jobs / surfaces with no presenter (D4-5). */
  unattended: boolean;
}

/** Upper bound on one stored field — a DoS guard, same as `NamedSecretsService`. */
const MAX_FIELD_BYTES = 8 * 1024;

/** Personality ids are directory names; this admits every id the registry can load. */
const PERSONALITY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class CredentialValidationError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CredentialValidationError';
  }
}

export function credentialRef(name: string, field: CredentialField): string {
  return `${CREDENTIALS_PREFIX}${name}/${field}`;
}

/**
 * True when `origin` may be bound: `https:`, or `http:` on a loopback host so
 * a local dev server and the live smoke work (D4-3). Takes an already-parsed
 * `URL.origin`, so `http://localhost.evil.io` has hostname `localhost.evil.io`
 * and is refused.
 */
export function isBindableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Normalise an operator-typed origin to `URL.origin` and refuse anything that
 * is not a bare origin: a path beyond `/`, a query, a fragment or credentials
 * would read as a narrower binding than the tool enforces, so they are errors
 * rather than silently dropped.
 */
export function normalizeOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CredentialValidationError(
      `"${input}" is not a valid origin.`,
      'Use a full origin such as https://github.com.',
    );
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new CredentialValidationError(
      `"${input}" is not a bare origin.`,
      'Drop the path, query and fragment — a login is bound to a whole origin.',
    );
  }
  if (url.username || url.password) {
    throw new CredentialValidationError(`"${input}" must not carry userinfo.`);
  }
  if (!isBindableOrigin(url.origin)) {
    throw new CredentialValidationError(
      `"${input}" is not an https origin.`,
      'Only https:// origins can be bound (http:// is allowed for localhost, 127.0.0.1 and [::1]).',
    );
  }
  return url.origin;
}

export function assertCredentialName(name: string): string {
  if (!isValidSecretName(name)) {
    throw new CredentialValidationError(
      `Invalid credential name "${name}".`,
      'Use letters, digits, hyphens, and underscores only.',
    );
  }
  return name;
}

function assertPersonalityId(id: string): string {
  if (!PERSONALITY_ID_RE.test(id)) {
    throw new CredentialValidationError(`Invalid personality id "${id}".`);
  }
  return id;
}

function assertFieldValue(label: string, value: string): string {
  if (value.length === 0) throw new CredentialValidationError(`${label} must not be empty.`);
  if (Buffer.byteLength(value, 'utf8') > MAX_FIELD_BYTES) {
    throw new CredentialValidationError(`${label} is too large.`);
  }
  return value;
}

/** Validate a TOTP seed without echoing it. Returns the trimmed seed. */
export function assertTotpSeed(seed: string): string {
  const trimmed = seed.trim();
  assertFieldValue('TOTP seed', trimmed);
  try {
    parseTotpSeed(trimmed);
  } catch (err) {
    if (err instanceof TotpSeedError) throw new CredentialValidationError(err.message);
    throw new CredentialValidationError('TOTP seed could not be parsed.');
  }
  return trimmed;
}

/** Validate and normalise a policy; de-duplicates, keeps first-seen order. */
export function validateCredentialPolicy(input: {
  origins: readonly string[];
  personalities: readonly string[];
  unattended?: boolean;
}): CredentialPolicy {
  const origins = [...new Set(input.origins.map(normalizeOrigin))];
  if (origins.length === 0) {
    throw new CredentialValidationError(
      'A credential needs at least one origin.',
      'Pass --origin https://example.com (repeatable).',
    );
  }
  const personalities = [...new Set(input.personalities.map((p) => assertPersonalityId(p.trim())))];
  return { origins, personalities, unattended: input.unattended === true };
}

/**
 * Parse a stored policy. Returns `null` for anything that is not exactly the
 * shape both surfaces write — the tool treats `null` as "no credential" and
 * refuses (browser-fill-credential.ts step 3). An origin that is no longer
 * bindable (hand-edited to `http://example.com`) invalidates the whole policy
 * rather than being skipped, so a tampered file fails closed.
 */
export function parseCredentialPolicy(raw: string | null): CredentialPolicy | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const { origins, personalities, unattended } = rec;
  if (!Array.isArray(origins) || !origins.every((o) => typeof o === 'string')) return null;
  if (!Array.isArray(personalities) || !personalities.every((p) => typeof p === 'string')) {
    return null;
  }
  if (unattended !== undefined && typeof unattended !== 'boolean') return null;
  if (!origins.every((o) => isBindableOrigin(o))) return null;
  return {
    origins: [...origins],
    personalities: [...personalities],
    unattended: unattended === true,
  };
}

export function serializeCredentialPolicy(policy: CredentialPolicy): string {
  return JSON.stringify({
    origins: policy.origins,
    personalities: policy.personalities,
    unattended: policy.unattended,
  });
}

export interface CredentialView {
  name: string;
  origins: string[];
  personalities: string[];
  unattended: boolean;
  /** Masked via `redactSecretValue` — never the raw username. */
  usernamePreview: string;
  hasPassword: boolean;
  hasTotp: boolean;
  /** False when the policy is missing or unparseable — the tool will refuse it. */
  policyValid: boolean;
}

/** Every stored credential with masked previews only. Values never leave. */
export async function listCredentials(secrets: SecretsResolver): Promise<CredentialView[]> {
  const refs = await secrets.list(CREDENTIALS_PREFIX);
  const names = new Set<string>();
  for (const ref of refs) {
    const rest = ref.slice(CREDENTIALS_PREFIX.length);
    const [name, field, ...extra] = rest.split('/');
    if (!name || !field || extra.length > 0 || !isValidSecretName(name)) continue;
    names.add(name);
  }
  const out: CredentialView[] = [];
  for (const name of [...names].sort()) {
    const policy = parseCredentialPolicy(await secrets.get(credentialRef(name, 'policy')));
    const username = await secrets.get(credentialRef(name, 'username'));
    out.push({
      name,
      origins: policy?.origins ?? [],
      personalities: policy?.personalities ?? [],
      unattended: policy?.unattended ?? false,
      usernamePreview: redactSecretValue(username),
      hasPassword: Boolean(await secrets.get(credentialRef(name, 'password'))),
      hasTotp: Boolean(await secrets.get(credentialRef(name, 'totp'))),
      policyValid: policy !== null,
    });
  }
  return out;
}

export async function credentialExists(secrets: SecretsResolver, name: string): Promise<boolean> {
  assertCredentialName(name);
  const refs = await secrets.list(`${CREDENTIALS_PREFIX}${name}/`);
  return refs.length > 0;
}

export interface SetCredentialInput {
  name: string;
  /** Required when the credential does not exist yet; absent → keep the stored one. */
  username?: string;
  /** Required when the credential does not exist yet; absent → keep the stored one. */
  password?: string;
  /** `undefined` keeps the stored seed, `null` or `''` removes it, a string replaces it. */
  totp?: string | null;
  origins: readonly string[];
  personalities: readonly string[];
  unattended?: boolean;
}

/**
 * Create or update a login. Every field is validated BEFORE the first write,
 * so a bad TOTP seed or origin leaves the vault untouched. The policy is
 * written last: a credential with values but no policy is refused by the tool,
 * so an interrupted create fails closed.
 */
export async function setCredential(
  secrets: SecretsResolver,
  input: SetCredentialInput,
): Promise<{ policy: CredentialPolicy }> {
  const name = assertCredentialName(input.name);
  const policy = validateCredentialPolicy(input);
  const exists = await credentialExists(secrets, name);
  const username =
    input.username !== undefined ? assertFieldValue('Username', input.username) : undefined;
  const password =
    input.password !== undefined ? assertFieldValue('Password', input.password) : undefined;
  if (!exists && (username === undefined || password === undefined)) {
    throw new CredentialValidationError('A new credential needs a username and a password.');
  }
  const totp =
    input.totp === undefined
      ? undefined
      : input.totp === null || input.totp.trim() === ''
        ? null
        : assertTotpSeed(input.totp);

  if (username !== undefined) await secrets.set(credentialRef(name, 'username'), username);
  if (password !== undefined) await secrets.set(credentialRef(name, 'password'), password);
  if (totp === null) await secrets.delete(credentialRef(name, 'totp'));
  else if (totp !== undefined) await secrets.set(credentialRef(name, 'totp'), totp);
  await secrets.set(credentialRef(name, 'policy'), serializeCredentialPolicy(policy));
  return { policy };
}

/** Remove all four refs. Idempotent. */
export async function deleteCredential(secrets: SecretsResolver, name: string): Promise<void> {
  assertCredentialName(name);
  for (const field of CREDENTIAL_FIELDS) await secrets.delete(credentialRef(name, field));
}

/**
 * Edit the policy only (grant / revoke). Throws when the credential has no
 * readable policy — there is nothing to amend, and inventing one would bind
 * the login to origins nobody chose.
 */
export async function updateCredentialPolicy(
  secrets: SecretsResolver,
  name: string,
  mutate: (policy: CredentialPolicy) => CredentialPolicy,
): Promise<CredentialPolicy> {
  assertCredentialName(name);
  const current = parseCredentialPolicy(await secrets.get(credentialRef(name, 'policy')));
  if (!current) {
    throw new CredentialValidationError(
      `Credential "${name}" not found or has no valid policy.`,
      'Create it with `ethos secrets credential add`.',
    );
  }
  const next = validateCredentialPolicy(mutate(current));
  await secrets.set(credentialRef(name, 'policy'), serializeCredentialPolicy(next));
  return next;
}
