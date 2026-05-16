import type { TeamMemberStats } from './index';

export type AutonomyTier = 'probationary' | 'standard' | 'trusted';

export interface TrustPolicy {
  mode: 'flat' | 'tiered';
  demotion?: 'gradual' | 'strict';
  thresholds?: {
    standard_min_completed?: number;
    standard_min_ratio?: number;
    trusted_min_completed?: number;
    trusted_min_ratio?: number;
  };
}

const DEFAULTS = {
  standard_min_completed: 10,
  standard_min_ratio: 0.5,
  trusted_min_completed: 30,
  trusted_min_ratio: 0.9,
} as const;

export function autonomyTier(
  stats: Pick<TeamMemberStats, 'ticketsCompleted' | 'ticketsFailed' | 'ticketsOrphaned'>,
  policy?: TrustPolicy,
): AutonomyTier {
  if (!policy || policy.mode === 'flat') return 'standard';

  const t = { ...DEFAULTS, ...policy.thresholds };
  const total = stats.ticketsCompleted + stats.ticketsFailed + stats.ticketsOrphaned;
  if (total === 0) return 'probationary';

  const ratio = stats.ticketsCompleted / total;

  if (stats.ticketsCompleted >= t.trusted_min_completed && ratio >= t.trusted_min_ratio) {
    return 'trusted';
  }
  if (stats.ticketsCompleted >= t.standard_min_completed && ratio >= t.standard_min_ratio) {
    return 'standard';
  }
  return 'probationary';
}

const TIER_MAX_RETRIES: Record<AutonomyTier, number> = {
  probationary: 1,
  standard: 3,
  trusted: 5,
};

export function tierMaxRetries(tier: AutonomyTier): number {
  return TIER_MAX_RETRIES[tier];
}
