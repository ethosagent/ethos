import type { ScopedSecretsResolver, SecretRef } from '@ethosagent/types';

export type SecretsBackend = (ref: SecretRef) => Promise<string>;

export class ScopedSecretsImpl implements ScopedSecretsResolver {
  constructor(
    private readonly declaredRefs: Set<string>,
    private readonly backend: SecretsBackend,
  ) {}

  async get(ref: SecretRef): Promise<string> {
    if (!this.isDeclared(ref)) {
      // Generic message only — the raw ref must NOT reach the assistant-visible
      // error, or a prompt-injection surface learns the vault layout. The token
      // `SECRET_NOT_DECLARED` is kept for callers/tests that match on it.
      throw new Error('SECRET_NOT_DECLARED: requested secret is not permitted for this tool');
    }
    return this.backend(ref);
  }

  /**
   * A ref is declared if it matches a declared entry exactly, OR falls under a
   * declared prefix glob. A prefix glob is a declared entry ending in `/*`
   * (e.g. `providers/exa/*`), which matches any ref whose leading path segments
   * equal the declared prefix's segments (`providers` / `exa`). This keeps a
   * tool's grant scoped to the namespaces it declared — exact-ref entries never
   * widen — while letting a tool like `web_search` bind any named secret inside
   * its own provider namespaces without a per-binding runtime grant.
   *
   * The comparison is SEGMENT-wise, never a raw `startsWith`: a ref such as
   * `providers/exa/../../channels/telegram/default/botToken` literally starts
   * with `providers/exa/` but must be denied. Any ref carrying a traversal
   * (`..`), current-dir (`.`), or empty (`//`) segment is rejected outright —
   * these can never be a legitimate named-secret ref and they are exactly the
   * shapes that defeat a prefix match.
   */
  private isDeclared(ref: string): boolean {
    if (this.declaredRefs.has(ref)) return true;

    const refSegments = ref.split('/');
    if (refSegments.some((s) => s === '' || s === '.' || s === '..')) return false;

    for (const decl of this.declaredRefs) {
      if (!decl.endsWith('/*')) continue;
      const declSegments = decl.slice(0, -2).split('/'); // drop trailing `/*`
      // A prefix grant matches only a strictly deeper ref (a real leaf under
      // the namespace), and every leading segment must match exactly.
      if (refSegments.length <= declSegments.length) continue;
      if (declSegments.every((seg, i) => seg === refSegments[i])) return true;
    }
    return false;
  }
}
