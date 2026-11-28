export const worldKeys = {
  all: () => ['worlds'] as const,
  list: () => [...worldKeys.all(), 'list'] as const,
  graph: (world: string, asOf: string | null, focus: string | null, hops: number) =>
    [...worldKeys.all(), 'graph', world, asOf, focus, hops] as const,
  tree: (world: string) => [...worldKeys.all(), 'tree', world] as const,
  entity: (world: string, entityId: string) =>
    [...worldKeys.all(), 'entity', world, entityId] as const,
  changes: (world: string, since: string) => [...worldKeys.all(), 'changes', world, since] as const,
  proposals: (world: string) => [...worldKeys.all(), 'proposals', world] as const,
  schema: (world: string) => [...worldKeys.all(), 'schema', world] as const,
  config: (world: string) => [...worldKeys.all(), 'config', world] as const,
};
