export function parseTemporalBound(input) {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? undefined : d;
}
export function toJournalKey(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
const DEFAULT_HALF_LIFE_MS = 604_800_000; // 7 days
export function applyTemporalDecay(results, options) {
    const halfLifeMs = options?.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    const now = options?.now ?? new Date();
    const nowMs = now.getTime();
    return results
        .map((r) => {
        const ageMs = nowMs - r.timestamp.getTime();
        const decayFactor = ageMs < 0 ? 1 : 0.5 ** (ageMs / halfLifeMs);
        return { ...r, score: r.score * decayFactor };
    })
        .sort((a, b) => b.score - a.score);
}
