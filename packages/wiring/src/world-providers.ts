import type { WorldGraphProviderFactory, WorldGraphProviderRegistry } from '@ethosagent/types';

/**
 * Look up the factory for a `world.yaml` backend name. An unknown name throws
 * with the registered names, matching the memory-provider lookup in
 * build-agent-loop.ts. Pinned by __tests__/world-providers.test.ts
 * ('unknown backend name in world.yaml fails with the list of registered names').
 */
export function resolveWorldProvider(
  registry: WorldGraphProviderRegistry,
  name: string,
): WorldGraphProviderFactory {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `World graph provider "${name}" is not registered. Available: ${registry.list().join(', ')}`,
    );
  }
  return factory;
}
