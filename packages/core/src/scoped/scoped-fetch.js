import { safeFetch } from '@ethosagent/safety-network';
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
export class ScopedFetchImpl {
  allowedHosts;
  policy;
  testSeam;
  constructor(allowedHosts, policy, testSeam = {}) {
    this.allowedHosts = allowedHosts;
    this.policy = policy;
    this.testSeam = testSeam;
  }
  async fetch(url, init) {
    const parsed = new URL(url);
    if (!this.isHostAllowed(parsed.hostname)) {
      throw new Error(`HOST_NOT_ALLOWED: ${parsed.hostname} is not in the declared allowedHosts`);
    }
    // redirect is forced to 'manual' inside safeFetch — strip it so the
    // omit-typed init shape lines up.
    const { redirect: _redirect, ...rest } = init ?? {};
    const result = await safeFetch(parsed.toString(), {
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
  isHostAllowed(hostname) {
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
