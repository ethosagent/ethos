import type { ScanResult, TierPolicy, TrustTier } from './types';

const TRUSTED_REPO_PREFIXES = ['github.com/ethosagent/', 'github.com/anthropic/'];

export function deriveTier(source: string): TrustTier {
  if (source === 'builtin') return 'builtin';
  if (TRUSTED_REPO_PREFIXES.some((p) => source.startsWith(p))) return 'trusted-repo';
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

export function getTierPolicy(tier: TrustTier): TierPolicy {
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

export interface InstallDecision {
  allowed: boolean;
  blockedBy?: string;
}

/**
 * Decide whether a scan result allows install given the trust tier.
 * `force` is only respected when the tier's policy allows override.
 */
export function canInstall(
  result: ScanResult,
  tier: TrustTier,
  opts: { force?: boolean } = {},
): InstallDecision {
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
