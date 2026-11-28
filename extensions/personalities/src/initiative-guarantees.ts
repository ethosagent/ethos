/** Register rows for the two initiative guarantees; never narrowed or relaxed by a personality field. */
export const INITIATIVE_GUARANTEE_ROWS = {
  'G-INIT-RO': {
    status: 'enforced',
    detail:
      'initiative runs get a fresh read-only registry (buildReadOnlyRegistry); no personality field widens it',
  },
  'G-INIT-CFG': {
    status: 'enforced',
    detail:
      'initiatives/*.yaml is written only by InitiativeConfigService; the folder is a definition floor turns cannot write',
  },
} as const satisfies Record<'G-INIT-RO' | 'G-INIT-CFG', { status: 'enforced'; detail: string }>;
