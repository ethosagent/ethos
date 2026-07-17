export type SecretRef = string;

/**
 * The single allowed shape for a named-secret identifier — the trailing
 * `<name>` segment of a `providers/<provider>/<name>` ref. Enforced at every
 * boundary that accepts an untrusted secret name (the vault service, the
 * per-tool settings writer, and the personality `tools.yaml` parser) so a
 * marketplace personality cannot smuggle a path-traversal segment (`..`, `/`)
 * into a ref and escape a tool's capability prefix grant.
 */
export const SECRET_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** True when `name` is a safe named-secret identifier (see `SECRET_NAME_RE`). */
export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export interface SecretsResolver {
  get(ref: SecretRef): Promise<string | null>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  list(prefix?: string): Promise<SecretRef[]>;
}

export class SecretNotFoundError extends Error {
  readonly code = 'SECRET_NOT_FOUND';
  constructor(public readonly ref: SecretRef) {
    super(`Secret not found: ${ref}`);
  }
}
