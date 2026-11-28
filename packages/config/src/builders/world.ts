import type { EthosConfig } from '../config-types';
import type { WorldConfig } from '../section-types';
import { parseBoundedInt } from './utils';

/** The `world.<field>: <value>` config line; group 1 is the field (`proposals.cap` included). */
export const WORLD_LINE =
  /^world\.(enabled|contextMaxChars|contextHops|extraction|proposals\.cap|proposals\.ttlDays):\s*(.+)$/;

export const WORLD_CONTEXT_MAX_CHARS_DEFAULT = 2400;
export const WORLD_CONTEXT_MAX_CHARS_CEILING = 8000;
export const WORLD_PROPOSALS_CAP_DEFAULT = 500;
export const WORLD_PROPOSALS_TTL_DAYS_DEFAULT = 30;

/** What a consumer sees once the defaults are applied. */
export interface ResolvedWorldSettings {
  enabled: boolean;
  contextMaxChars: number;
  contextHops: 1 | 2;
  extraction: 'off' | 'propose';
  proposals: { cap: number; ttlDays: number };
}

/**
 * Parse `world.*` (plan world-model 4.6). `enabled` is strict: only a literal `true` or `false`
 * is read, so a typo never turns the world model on. `contextMaxChars` is clamped to
 * [0, 8000]; other bad values are dropped with a warning and the default applies. A `world.*`
 * key the parser does not model is kept verbatim by writeConfig (known-keys.ts prefix `world.`,
 * pinned by __tests__/world-config.test.ts). Returns undefined when no key is set.
 */
export function buildWorld(
  kv: Record<string, string>,
  warnings: string[],
): WorldConfig | undefined {
  const out: WorldConfig = {};
  const drop = (key: string, raw: string, expected: string) =>
    warnings.push(`world.${key}: "${raw}" is not valid. Expected ${expected}. Ignoring it.`);

  const enabled = kv.enabled?.trim();
  if (enabled === 'true') out.enabled = true;
  else if (enabled === 'false') out.enabled = false;
  else if (enabled !== undefined) drop('enabled', kv.enabled ?? '', '`true` or `false`');

  if (kv.contextMaxChars !== undefined) {
    const n = Number(kv.contextMaxChars);
    if (Number.isFinite(n)) {
      out.contextMaxChars = Math.min(WORLD_CONTEXT_MAX_CHARS_CEILING, Math.max(0, Math.floor(n)));
    } else drop('contextMaxChars', kv.contextMaxChars, 'a number');
  }

  if (kv.contextHops !== undefined) {
    const hops = kv.contextHops.trim();
    if (hops === '1') out.contextHops = 1;
    else if (hops === '2') out.contextHops = 2;
    else drop('contextHops', kv.contextHops, '1 or 2');
  }

  if (kv.extraction !== undefined) {
    const mode = kv.extraction.trim();
    if (mode === 'off' || mode === 'propose') out.extraction = mode;
    else drop('extraction', kv.extraction, '`off` or `propose`');
  }

  const proposals: { cap?: number; ttlDays?: number } = {};
  if (kv['proposals.cap'] !== undefined) {
    const n = parseBoundedInt(kv['proposals.cap'], 1, 100_000);
    if (n !== undefined) proposals.cap = n;
    else drop('proposals.cap', kv['proposals.cap'], 'an integer from 1 to 100000');
  }
  if (kv['proposals.ttlDays'] !== undefined) {
    const n = parseBoundedInt(kv['proposals.ttlDays'], 1, 3650);
    if (n !== undefined) proposals.ttlDays = n;
    else drop('proposals.ttlDays', kv['proposals.ttlDays'], 'an integer from 1 to 3650');
  }
  if (Object.keys(proposals).length > 0) out.proposals = proposals;

  return Object.keys(out).length > 0 ? out : undefined;
}

/** The world settings with defaults applied. Read this, not `config.world`. */
export function resolveWorld(config: Pick<EthosConfig, 'world'>): ResolvedWorldSettings {
  const w = config.world;
  return {
    enabled: w?.enabled === true,
    contextMaxChars: w?.contextMaxChars ?? WORLD_CONTEXT_MAX_CHARS_DEFAULT,
    contextHops: w?.contextHops ?? 2,
    extraction: w?.extraction ?? 'off',
    proposals: {
      cap: w?.proposals?.cap ?? WORLD_PROPOSALS_CAP_DEFAULT,
      ttlDays: w?.proposals?.ttlDays ?? WORLD_PROPOSALS_TTL_DAYS_DEFAULT,
    },
  };
}
