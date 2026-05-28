// Ch.7c — Per-personality network policy.
//
// Three knobs:
//   - allow:  exact hosts or `*.domain` globs. Non-empty list = allowlist
//             mode (only listed hosts reachable). Empty list = open
//             (deny rules + private-network rules still apply).
//   - deny:   hard-deny in addition to the always-deny / private-net block.
//   - allow_private_urls: opt-in escape hatch for RFC1918 / loopback /
//             link-local. The cloud-metadata block in 7b STILL applies
//             even when this is true — those hosts have no override.
/**
 * Match `hostname` against `pattern`. Patterns are either an exact host or a
 * single leading `*.` glob (e.g. `*.anthropic.com` matches `api.anthropic.com`
 * AND `anthropic.com`). Matching is case-insensitive.
 */
export function hostnameMatches(hostname, pattern) {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  return h === p;
}
export function checkAllowDeny(hostname, policy) {
  const deny = policy.deny ?? [];
  for (const pat of deny) {
    if (hostnameMatches(hostname, pat)) {
      return {
        allowed: false,
        reason: `host '${hostname}' is on the deny list (matched '${pat}')`,
      };
    }
  }
  const allow = policy.allow ?? [];
  if (allow.length > 0) {
    const matched = allow.some((pat) => hostnameMatches(hostname, pat));
    if (!matched) {
      return {
        allowed: false,
        reason: `host '${hostname}' is not on the personality allowlist`,
      };
    }
  }
  return { allowed: true };
}
