import { assertSafeId } from '@ethosagent/types';
import type { EthosConfig } from '../config-types';
import type { ShareLinksConfig } from '../section-types';

/** The `shareLinks.<field>: <value>` config line; group 1 is the field. */
export const SHARE_LINKS_LINE = /^shareLinks\.(enabled|excludePersonalities):\s*(.+)$/;

/** What a consumer sees once the defaults are applied: off, nothing excluded. */
export interface ResolvedShareLinks {
  enabled: boolean;
  excludePersonalities: string[];
}

/**
 * Parse `shareLinks.enabled` / `shareLinks.excludePersonalities` (plan share-links D11).
 *
 * `enabled` is strict: only a literal `true` or `false` is taken. Anything else is dropped with a
 * warning and the feature stays off, so a typo never turns publishing on. Warnings reach the
 * operator via `configParseNotices` (printed by `ethos doctor` / `ethos serve`).
 * Each excluded id must pass `assertSafeId` (packages/types/src/id-validation.ts); an invalid id
 * is dropped with a warning and the rest are kept. Returns undefined when neither key is set.
 */
export function buildShareLinks(
  kv: Record<string, string>,
  warnings: string[],
): ShareLinksConfig | undefined {
  const out: ShareLinksConfig = {};
  const enabled = kv.enabled?.trim();
  if (enabled === 'true') out.enabled = true;
  else if (enabled === 'false') out.enabled = false;
  else if (enabled !== undefined) {
    warnings.push(
      `shareLinks.enabled: "${kv.enabled}" is not a boolean. Expected \`true\` or \`false\`. ` +
        'Ignoring it; share links stay off.',
    );
  }
  if (kv.excludePersonalities !== undefined) {
    const ids: string[] = [];
    for (const raw of kv.excludePersonalities.split(',')) {
      const id = raw.trim();
      if (id === '') continue;
      try {
        assertSafeId(id, 'personality id');
        ids.push(id);
      } catch {
        warnings.push(
          `shareLinks.excludePersonalities: "${id}" is not a valid personality id ` +
            '(lowercase letters, digits, `_` and `-`). Ignoring it.',
        );
      }
    }
    out.excludePersonalities = ids;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The share-link settings with defaults applied. Read this, not `config.shareLinks`. */
export function resolveShareLinks(config: Pick<EthosConfig, 'shareLinks'>): ResolvedShareLinks {
  return {
    enabled: config.shareLinks?.enabled === true,
    excludePersonalities: config.shareLinks?.excludePersonalities ?? [],
  };
}
