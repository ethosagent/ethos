import type { ScopedSecretsResolver, SecretRef } from '@ethosagent/types';

export type SecretsBackend = (ref: SecretRef) => Promise<string>;

export class ScopedSecretsImpl implements ScopedSecretsResolver {
  constructor(
    private readonly declaredRefs: Set<string>,
    private readonly backend: SecretsBackend,
  ) {}

  async get(ref: SecretRef): Promise<string> {
    if (!this.isDeclared(ref)) {
      throw new Error(`SECRET_NOT_DECLARED: ${ref} is not in the tool's declared secrets`);
    }
    return this.backend(ref);
  }

  /**
   * A ref is declared if it matches a declared entry exactly, OR falls under a
   * declared prefix glob. A prefix glob is a declared entry ending in `/*`
   * (e.g. `providers/exa/*`), which matches any ref starting with the text
   * before the `*` (`providers/exa/`). This keeps a tool's grant scoped to the
   * namespaces it declared — exact-ref entries never widen — while letting a
   * tool like `web_search` bind any named secret inside its own provider
   * namespaces without a per-binding runtime grant.
   */
  private isDeclared(ref: string): boolean {
    if (this.declaredRefs.has(ref)) return true;
    for (const decl of this.declaredRefs) {
      if (decl.endsWith('/*') && ref.startsWith(decl.slice(0, -1))) return true;
    }
    return false;
  }
}
