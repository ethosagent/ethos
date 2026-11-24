import type { EthosConfig } from '../config-types';

/**
 * Parse `weeklyDigest.<field>` from the flat key/value map. Returns undefined when none of the
 * three keys is present. Moved verbatim out of parse.ts (size ratchet, plan laptop-tool-node).
 */
export function buildWeeklyDigest(kv: Record<string, string>): EthosConfig['weeklyDigest'] {
  return kv['weeklyDigest.enabled'] !== undefined ||
    kv['weeklyDigest.cron'] !== undefined ||
    kv['weeklyDigest.recipients'] !== undefined
    ? {
        ...(kv['weeklyDigest.enabled'] !== undefined
          ? { enabled: kv['weeklyDigest.enabled'] === 'true' }
          : {}),
        ...(kv['weeklyDigest.cron'] ? { cron: kv['weeklyDigest.cron'] } : {}),
        ...(kv['weeklyDigest.recipients']
          ? {
              recipients: kv['weeklyDigest.recipients']
                .split(/[,\s]+/)
                .map((r) => r.trim())
                .filter((r) => r.length > 0),
            }
          : {}),
      }
    : undefined;
}
