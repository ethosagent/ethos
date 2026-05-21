import type { SecretRef, SecretsResolver } from '@ethosagent/types';

export class PersonalityScopedSecrets implements SecretsResolver {
  constructor(
    private readonly inner: SecretsResolver,
    private readonly personalityId: string,
  ) {}

  private scope(ref: SecretRef): SecretRef {
    return `personalities/${this.personalityId}/${ref}`;
  }

  get(ref: SecretRef) {
    return this.inner.get(this.scope(ref));
  }

  set(ref: SecretRef, value: string) {
    return this.inner.set(this.scope(ref), value);
  }

  delete(ref: SecretRef) {
    return this.inner.delete(this.scope(ref));
  }

  async list(prefix?: string): Promise<SecretRef[]> {
    const scopedPrefix = this.scope(prefix ?? '');
    const all = await this.inner.list(scopedPrefix);
    const base = `personalities/${this.personalityId}/`;
    return all.map((r) => r.slice(base.length));
  }
}
