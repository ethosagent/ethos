import { resolveToolSecretRef } from '@ethosagent/core';
import type { ToolCapabilities, ToolContext, ToolSettingsSchema } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Shared constants for gsc_sites / gsc_queries — one module so the hosts a
// tool declares, the hosts its HOST_NOT_ALLOWED message names, and the vault
// namespace its capability grant covers can never disagree.
// See plan/phases/search-console.md §5-§8.
// ---------------------------------------------------------------------------

/** Search Analytics + sites.list. */
export const API_HOST = 'searchconsole.googleapis.com';
export const API_BASE = `https://${API_HOST}/webmasters/v3`;

/** The service-account token mint. A DIFFERENT host from API_HOST, and both
 *  are required: a personality that allows one and not the other gets a tool
 *  that can query but cannot authenticate (plan §18). */
export const TOKEN_HOST = 'oauth2.googleapis.com';
export const DEFAULT_TOKEN_URI = `https://${TOKEN_HOST}/token`;

export const ALLOWED_HOSTS = [API_HOST, TOKEN_HOST] as const;

/** Read-only. The read-write sibling `.../auth/webmasters` is never requested,
 *  so a leaked credential cannot mutate a property (D11). */
export const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/** A separate namespace from `providers/google/*` (the YouTube Data API key)
 *  for the same reason the codebase separates `providers/google/*` from
 *  `providers/gemini/*`: different credential, different quota, different
 *  failure modes (D3). */
export const SECRET_PREFIX = 'providers/google-search-console/';
export const DEFAULT_SECRET_REF = `${SECRET_PREFIX}serviceAccount`;

export const NO_KEY_MESSAGE =
  'No Google Search Console credential configured — add a "Google Search Console (service account)" secret in Settings → Security → Named Secrets (paste the whole service-account JSON key), then bind it to search_console in the personality\'s tool settings.';

/** One credential, two tools: the settings UI groups by this key and renders a
 *  single form covering `gsc_sites` and `gsc_queries`, and the binding is
 *  stored under `search_console` in both stores (D24). */
export const SETTINGS_KEY = 'search_console';

/** Between youtube_search's 15,000 and engine_ask's 30,000 (D18). The renderer
 *  fits rows to this itself rather than letting the registry's silent post-trim
 *  drop them (D29). */
export const MAX_RESULT_CHARS = 20_000;

/**
 * A resolved per-personality `search_console` binding. `secret` is a NAME only
 * (e.g. `clientAcme`) — never a value — that resolves to
 * `providers/google-search-console/<name>` in the vault. Absent →
 * `providers/google-search-console/serviceAccount`. Shared by both tools: one
 * service account, one grant, one Cloud project.
 */
export interface SearchConsoleToolSetting {
  secret?: string;
}

export interface CreateSearchConsoleToolOptions {
  /** Personality-owned binding (source of truth), resolved by personalityId. */
  resolvePersonalitySetting?: (personalityId: string) => SearchConsoleToolSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`. */
  toolSettings?: Record<string, { search_console?: SearchConsoleToolSetting } | undefined>;
}

/** Same resolution order as `youtube_search` / `engine_ask`: personality
 *  tools.yaml → global toolSettings[pid] → global toolSettings._default → the
 *  default-named key. A rung whose name is blank or fails `isValidSecretName`
 *  falls through to the next one — see `resolveToolSecretRef`
 *  (packages/core/src/tool-secret-ref.ts). */
export function selectGscSecretRef(ctx: ToolContext, opts: CreateSearchConsoleToolOptions): string {
  const pid = ctx.personalityId;
  return resolveToolSecretRef({
    rungs: [
      pid ? opts.resolvePersonalitySetting?.(pid) : undefined,
      pid ? opts.toolSettings?.[pid]?.search_console : undefined,
      opts.toolSettings?._default?.search_console,
    ],
    prefix: SECRET_PREFIX,
    defaultRef: DEFAULT_SECRET_REF,
  });
}

/** The `capabilities` block both tools declare. A prefix grant over the
 *  namespace, so any bound name resolves without a per-binding runtime grant
 *  (D13). */
export const GSC_CAPABILITIES: ToolCapabilities = {
  network: { allowedHosts: [...ALLOWED_HOSTS] },
  secrets: [`${SECRET_PREFIX}*`],
};

/** The one-field credential form both tools share (D6). */
export const GSC_SETTINGS_SCHEMA: ToolSettingsSchema = {
  fields: [
    {
      kind: 'secret-binding' as const,
      key: 'secret',
      label: 'Google Search Console service account',
      secretKind: 'gsc-service-account',
      providerLabel: 'Google Search Console (service account)',
      getKeyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
      // `DEFAULT_SECRET_REF` above, minus the prefix. The only shipped tool
      // whose default is not `apiKey`, and the reason the field exists (D4).
      defaultSecretName: 'serviceAccount',
      helpText:
        "Paste the whole service-account JSON key. The account's client_email must be added as a user on the property by a verified owner (Search Console → Settings → Users and permissions).",
    },
  ],
};
