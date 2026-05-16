export type SecretRef = string;

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
