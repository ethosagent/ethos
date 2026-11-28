/** Register rows for the two world guarantees; never narrowed or relaxed by a personality field. */
export const WORLD_GUARANTEE_ROWS = {
  'G-WORLD-WRITE': {
    status: 'enforced',
    detail:
      'an agent write to a shared world is a proposal and never overwrites a user fact; no personality field narrows it',
  },
  'G-WORLD-AUD': {
    status: 'enforced',
    detail:
      'an owner_only world is never visible in a shared turn, and a world needs both a grant and a mount; no personality field narrows it',
  },
} as const satisfies Record<
  'G-WORLD-WRITE' | 'G-WORLD-AUD',
  { status: 'enforced'; detail: string }
>;
