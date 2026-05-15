import type { ScopedSecretsResolver, SecretRef } from '@ethosagent/types';

export type SecretsBackend = (ref: SecretRef) => Promise<string>;

export class ScopedSecretsImpl implements ScopedSecretsResolver {
  constructor(
    private readonly declaredRefs: Set<string>,
    private readonly backend: SecretsBackend,
  ) {}

  async get(ref: SecretRef): Promise<string> {
    if (!this.declaredRefs.has(ref)) {
      throw new Error(`SECRET_NOT_DECLARED: ${ref} is not in the tool's declared secrets`);
    }
    return this.backend(ref);
  }
}
