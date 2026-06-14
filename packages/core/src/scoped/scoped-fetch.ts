import type { NetworkPolicy } from '@ethosagent/safety-network';
import type { ScopedFetch } from '@ethosagent/types';

/**
 * Test seam — `safeFetch`'s injection points, mirrored on the wrapper so
 * tests can stub DNS + fetch hermetically. Production wiring leaves
 * these undefined; `safeFetch` defaults to `node:dns/promises#lookup`
 * and `globalThis.fetch`.
 */
export interface ScopedFetchTestSeam {
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

/** Injected `safeFetch` function type — matches the export from `@ethosagent/safety-network`. */
export type SafeFetchFn = (
  url: string,
  opts: {
    policy: NetworkPolicy;
    init?: Omit<RequestInit, 'redirect'>;
    fetchImpl?: typeof fetch;
    resolveHost?: (hostname: string) => Promise<string[]>;
    maxRedirects?: number;
  },
) => Promise<
  | { ok: true; response: Response; finalUrl: string; hops: number }
  | { ok: false; reason: string; hop: number; url: string }
>;

/**
 * Scoped network capability. Enforces two layers in order:
 *
 *  1. **Declared host allowlist** — the intersection of the tool's
 *     `capabilities.network.allowedHosts` with the personality's
 *     `safety.network.allow`, resolved at registration time.
 *  2. **Non-overridable safety floor** — `safeFetch` runs scheme +
 *     cloud-metadata + private-network + per-redirect-hop revalidation
 *     regardless of declared hosts. A tool declaring `'*'` does NOT
 *     bypass the floor; a personality permitting `169.254.169.254` is
 *     still denied at the cloud-metadata layer.
 *
 * The two layers are not redundant: the allowlist is the policy
 * surface tool authors and operators reason about; the floor catches
 * the categories an allowlist can't (SSRF via redirect, DNS rebinding
 * partial mitigation, file/data/javascript schemes).
 */
export class ScopedFetchImpl implements ScopedFetch {
  constructor(
    private readonly allowedHosts: Set<string>,
    private readonly policy: NetworkPolicy,
    private readonly safeFetchFn: SafeFetchFn,
    private readonly testSeam: ScopedFetchTestSeam = {},
  ) {}

  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    if (!this.isHostAllowed(parsed.hostname)) {
      throw new Error(`HOST_NOT_ALLOWED: ${parsed.hostname} is not in the declared allowedHosts`);
    }
    // redirect is forced to 'manual' inside safeFetch — strip it so the
    // omit-typed init shape lines up.
    const { redirect: _redirect, ...rest } = init ?? {};
    const result = await this.safeFetchFn(parsed.toString(), {
      policy: this.policy,
      init: rest,
      fetchImpl: this.testSeam.fetchImpl,
      resolveHost: this.testSeam.resolveHost,
    });
    if (!result.ok) {
      throw new Error(`HOST_NOT_ALLOWED: ${result.reason}`);
    }
    return result.response;
  }

  private isHostAllowed(hostname: string): boolean {
    if (this.allowedHosts.has('*')) return true;
    if (this.allowedHosts.has(hostname)) return true;
    // Check subdomain wildcards: '*.github.com' matches 'api.github.com'
    for (const pattern of this.allowedHosts) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1); // '.github.com'
        if (hostname.endsWith(suffix) && hostname.length > suffix.length) return true;
      }
    }
    return false;
  }
}
