/**
 * Trusted GitHub organizations. Matched by exact segment against the
 * first two path segments of a `github.com/<org>/<repo>` source string.
 * Prefix matching (startsWith) is NOT used — it would allow an attacker
 * slug like `github.com/ethosagent/../../evil` to pass.
 */
const TRUSTED_GITHUB_ORGS = new Set(['ethosagent', 'anthropic']);
/**
 * Extract the organization segment from a `github.com/<org>/…` source.
 * Returns `undefined` when the source is not a valid github.com path
 * with at least an org and repo segment, or when any segment contains
 * path-traversal components (`.` or `..`).
 */
function extractGitHubOrg(source) {
  if (!source.startsWith('github.com/')) return undefined;
  const rest = source.slice('github.com/'.length);
  const segments = rest.split('/');
  // Need at least org + repo (two non-empty segments).
  if (segments.length < 2) return undefined;
  const org = segments[0];
  if (!org || org === '.' || org === '..') return undefined;
  // Reject path traversal anywhere in the segments.
  if (segments.some((s) => s === '.' || s === '..')) return undefined;
  return org;
}
export function deriveTier(source) {
  if (source === 'builtin') return 'builtin';
  const org = extractGitHubOrg(source);
  if (org && TRUSTED_GITHUB_ORGS.has(org)) return 'trusted-repo';
  // community: clawhub, hermeshub, arbitrary github (not in trusted list)
  if (
    source.startsWith('clawhub/') ||
    source.startsWith('hermeshub/') ||
    source.startsWith('github.com/')
  )
    return 'community';
  // local path or raw URL
  return 'untrusted';
}
export function getTierPolicy(tier) {
  switch (tier) {
    case 'builtin':
      return { tier, canOverrideRed: true, autoAcknowledgeYellow: true };
    case 'trusted-repo':
      return { tier, canOverrideRed: true, autoAcknowledgeYellow: true };
    case 'community':
      return { tier, canOverrideRed: false, autoAcknowledgeYellow: false };
    case 'untrusted':
      return { tier, canOverrideRed: false, autoAcknowledgeYellow: false };
  }
}
/**
 * Decide whether a scan result allows install given the trust tier.
 * `force` is only respected when the tier's policy allows override.
 */
export function canInstall(result, tier, opts = {}) {
  const policy = getTierPolicy(tier);
  if (result.hasRed) {
    if (policy.canOverrideRed && opts.force) {
      return { allowed: true };
    }
    return {
      allowed: false,
      blockedBy: policy.canOverrideRed
        ? 'red findings (pass --force to override)'
        : 'red findings (community/untrusted tier — cannot override)',
    };
  }
  if (result.hasYellow && !policy.autoAcknowledgeYellow) {
    // untrusted/community requires per-finding acknowledgment — in the CLI this means
    // the user must confirm; in the API we treat unacknowledged yellow as blocking.
    if (!opts.force) {
      return {
        allowed: false,
        blockedBy: 'yellow findings require acknowledgment (untrusted source)',
      };
    }
  }
  return { allowed: true };
}
