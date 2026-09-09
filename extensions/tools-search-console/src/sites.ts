import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { getAccessToken, readServiceAccount } from './auth';
import {
  API_BASE,
  type CreateSearchConsoleToolOptions,
  GSC_CAPABILITIES,
  GSC_SETTINGS_SCHEMA,
  MAX_RESULT_CHARS,
  NO_KEY_MESSAGE,
  SETTINGS_KEY,
  selectGscSecretRef,
} from './constants';
import { describeGscApiError, describeThrownGscError } from './errors';

// ---------------------------------------------------------------------------
// gsc_sites — `sites.list`. Also the diagnostic that tells an operator whether
// their Search Console grant landed, without leaving chat (§7.1).
// ---------------------------------------------------------------------------

interface SiteEntry {
  siteUrl?: string;
  permissionLevel?: string;
}

interface SitesListResponse {
  siteEntry?: SiteEntry[];
}

/** The single most common `gsc_queries` failure is passing a reshaped siteUrl,
 *  and it surfaces as a 403 rather than a 404 — so the exact strings are stated
 *  here, next to the values the model is about to copy. */
const SITE_URL_FORMS_NOTE =
  'Pass a siteUrl to gsc_queries exactly as printed above — a domain property is "sc-domain:example.com"; a URL-prefix property is "https://www.example.com/" WITH the trailing slash.';

export function createGscSitesTool(opts: CreateSearchConsoleToolOptions = {}): Tool {
  return {
    name: 'gsc_sites',
    description:
      "List the Google Search Console properties this service account can read, with each one's permission level. Run this first: gsc_queries needs the exact siteUrl string this returns. Requires a Google Search Console service-account credential.",
    toolset: 'web',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: GSC_CAPABILITIES,
    outputIsUntrusted: true,
    settingsKey: SETTINGS_KEY,
    settingsSchema: GSC_SETTINGS_SCHEMA,
    // Always registered — the credential arrives from the named-secrets vault,
    // which isAvailable() cannot see (no ToolContext at filter time). execute()
    // surfaces a clear "no credential configured" error instead. Same reasoning
    // as youtube_search / engine_ask (I4).
    isAvailable() {
      return true;
    },
    schema: { type: 'object', properties: {} },
    async execute(_args, ctx: ToolContext): Promise<ToolResult> {
      const secrets = ctx.secretsResolver;
      const net = ctx.scopedFetch;
      if (!secrets || !net) {
        return { ok: false, error: 'Capability backends not configured', code: 'not_available' };
      }

      try {
        const sa = await readServiceAccount(secrets, selectGscSecretRef(ctx, opts));
        if (!sa) return { ok: false, error: NO_KEY_MESSAGE, code: 'not_available' };

        const token = await getAccessToken(
          sa,
          (url, init) => net.fetch(url, init),
          ctx.abortSignal,
        );
        const response = await net.fetch(`${API_BASE}/sites`, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        });
        if (!response.ok) {
          return describeGscApiError(response, { clientEmail: sa.clientEmail });
        }

        const data = (await response.json()) as SitesListResponse;
        const entries = (data.siteEntry ?? []).filter(
          (e): e is SiteEntry & { siteUrl: string } => typeof e.siteUrl === 'string' && !!e.siteUrl,
        );

        // Not an error: an empty roster is the answer to "did the grant work",
        // and naming the account is what an operator needs to fix it (§7.1).
        if (entries.length === 0) {
          return {
            ok: true,
            value:
              `No Search Console properties are visible to this service account (${sa.clientEmail}) yet.\n\n` +
              'A verified owner of the property must add that email as a user in Search Console → Settings → Users and permissions. ' +
              'Restricted is enough to read Search Analytics; Full is recommended.',
          };
        }

        const lines = entries.map(
          (e, i) => `${i + 1}. ${e.siteUrl}  (${e.permissionLevel ?? 'unknown permission'})`,
        );
        return {
          ok: true,
          value: `Search Console properties visible to ${sa.clientEmail}:\n\n${lines.join('\n')}\n\n${SITE_URL_FORMS_NOTE}`,
        };
      } catch (err) {
        return describeThrownGscError(err);
      }
    },
  };
}
