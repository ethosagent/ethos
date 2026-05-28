const DEFAULTS = {
    standard_min_completed: 10,
    standard_min_ratio: 0.5,
    trusted_min_completed: 30,
    trusted_min_ratio: 0.9,
};
export function autonomyTier(stats, policy) {
    if (!policy || policy.mode === 'flat')
        return 'standard';
    const t = { ...DEFAULTS, ...policy.thresholds };
    const total = stats.ticketsCompleted + stats.ticketsFailed + stats.ticketsOrphaned;
    if (total === 0)
        return 'probationary';
    const ratio = stats.ticketsCompleted / total;
    if (stats.ticketsCompleted >= t.trusted_min_completed && ratio >= t.trusted_min_ratio) {
        return 'trusted';
    }
    if (stats.ticketsCompleted >= t.standard_min_completed && ratio >= t.standard_min_ratio) {
        return 'standard';
    }
    return 'probationary';
}
const TIER_MAX_RETRIES = {
    probationary: 1,
    standard: 3,
    trusted: 5,
};
export function tierMaxRetries(tier) {
    return TIER_MAX_RETRIES[tier];
}
