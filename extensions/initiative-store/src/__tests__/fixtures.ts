import type { InitiativeRow } from '@ethosagent/types';

export function initiative(overrides: Partial<InitiativeRow> = {}): InitiativeRow {
  return {
    id: 'ini-1',
    personalityId: 'ada',
    origin: 'human',
    parentId: null,
    state: 'active',
    configPath: 'initiatives/ini-1.yaml',
    configHash: 'h1',
    version: 1,
    ...overrides,
  };
}

/** The raw handle, the way the other stores' durability tests reach it. */
export function rawDb(store: unknown): {
  pragma(s: string): unknown;
  prepare(s: string): { all(): Array<Record<string, unknown>> };
} {
  return (store as { db: ReturnType<typeof rawDb> }).db;
}
