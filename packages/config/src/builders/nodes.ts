import type { EthosConfig } from '../config-types';

/**
 * Parse `nodes.<field>` (plan laptop-tool-node D18). Strict: only a literal `true` or `false`
 * is read; anything else leaves the block unset, so a typo can neither arm nor pretend to
 * disarm laptop nodes. Pinned by __tests__/config-nodes.test.ts.
 */
export function buildNodes(kv: Record<string, string>): EthosConfig['nodes'] | undefined {
  if (kv.enabled === 'true') return { enabled: true };
  if (kv.enabled === 'false') return { enabled: false };
  return undefined;
}
