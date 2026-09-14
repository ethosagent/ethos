// Which `providers.<n>` entries the default rung's LLM is built from — the one
// owner of that rule. `createLLMFromRegistry` (`./index.ts`) builds exactly
// these entries, and `resolveActiveLlmName` (`./tier-diagnostics.ts`) names
// them, so the character sheet cannot print a chain the runtime did not build.
// Agreement is pinned by `__tests__/tier-diagnostics.test.ts`.

import { deriveProviderKey, type ProviderChainEntry } from '@ethosagent/config';
import type { ModelRegistry } from '@ethosagent/types';

export interface ServingProviderEntry<E> {
  entry: E;
  /** `providers.<n>.id`, else `deriveProviderKey`'s positional default. */
  key: string;
}

/**
 * The chain entries that serve the default rung, in chain order, each with its
 * entry key. Only meaningful for a chain of two or more entries — below that
 * the runtime reads the top-level provider fields instead.
 *
 * D23b — a `failover: false` entry is a credential, not a hop. With every entry
 * opted out there is nothing to fail over between, and the default alias's own
 * entry serves alone (entry 0 when no registry default names one). Empty only
 * for an empty `providers`.
 */
export function selectServingProviderEntries<E extends ProviderChainEntry>(
  providers: readonly E[],
  modelRegistry: ModelRegistry | undefined,
): ServingProviderEntry<E>[] {
  const keyed = providers.map((entry, index) => ({ entry, key: deriveProviderKey(entry, index) }));
  const hops = keyed.filter(({ entry }) => entry.failover !== false);
  if (hops.length > 0) return hops;
  const defaultKey = modelRegistry?.default
    ? modelRegistry.entries[modelRegistry.default]?.provider
    : undefined;
  const alone = keyed.find(({ key }) => key === defaultKey) ?? keyed[0];
  return alone ? [alone] : [];
}
