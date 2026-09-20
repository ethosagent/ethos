// Activity chips filter the SERVER query, never a loaded array (D7, the
// CallRow rule). `activity.history` filters by agent only today, so the chips
// are the agents; the plan's kind chips (Cron · Runs · Teams · Mesh) wait on a
// `kind` input to `activity.history`.

export type ActivityChip = { kind: 'all' } | { kind: 'agent'; personalityId: string };

export const HISTORY_PAGE = 50;

export function historyInput(chip: ActivityChip): { personalityId?: string; limit: number } {
  return chip.kind === 'agent'
    ? { personalityId: chip.personalityId, limit: HISTORY_PAGE }
    : { limit: HISTORY_PAGE };
}

export function chipKey(chip: ActivityChip): string {
  return chip.kind === 'agent' ? `agent:${chip.personalityId}` : 'all';
}
