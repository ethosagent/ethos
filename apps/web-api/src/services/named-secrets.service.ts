import { probeServiceAccountKey } from '@ethosagent/tools-search-console';
import {
  EthosError,
  isValidSecretName,
  type SecretsResolver,
  type ToolRegistry,
} from '@ethosagent/types';
import {
  type DerivedProviderRoster,
  deriveProviderRoster,
  NAMED_SECRET_SEED_PROVIDERS,
} from './derive-provider-roster';

// Global named-secrets vault manager (Phase 2, web-search-provider-selection).
//
// A named secret is stored at `providers/<provider>/<name>` in the secrets
// vault — the same namespace a consuming tool's capability prefix grant
// (`providers/{exa,tavily,brave}/*` for `web_search`, `providers/xai/*` for
// `x_search`, `providers/openai/*` for `engine_ask`) allows. A personality only ever stores the secret NAME (a
// reference); the VALUE lives here and NEVER round-trips back to the client —
// reads are masked previews only.
//
// WHICH provider namespaces exist is not stated here: it is derived from those
// same capability grants by `deriveProviderRoster`, so registering a tool
// registers its credential surface (plan/phases/tool-credential-surface.md D1).
// With no registry wired the roster is `NAMED_SECRET_SEED_PROVIDERS` alone —
// a degraded path, recorded in that plan's §15.

/** Upper bound on a stored secret value. Real provider API keys are well under
 *  1 KiB; the cap is a DoS guard so a client cannot fill the vault dir. */
const MAX_VALUE_BYTES = 8 * 1024;

export interface NamedSecretView {
  provider: string;
  name: string;
  /** Masked preview — e.g. `sk-…abc1`. Never the raw value. */
  preview: string;
  /** Category the SecretPicker filters by — the provider's alphabetically-first
   *  `secretKind` (`kinds` is sorted in `deriveProviderRoster`). A provider with
   *  several is resolved through the roster's `kinds`, not through this field. */
  kind: string;
}

export interface NamedSecretsServiceOptions {
  secrets: SecretsResolver;
  /** Source of the provider roster. Absent → the seed only. */
  toolRegistry?: Pick<ToolRegistry, 'getAvailable'>;
}

export class NamedSecretsService {
  constructor(private readonly opts: NamedSecretsServiceOptions) {}

  /** The provider namespaces an operator may write a credential into, plus the
   *  declarations that were ignored getting there. Recomputed per call: the
   *  registry is live and a plugin can register a tool after boot. */
  providers(): DerivedProviderRoster {
    return deriveProviderRoster(this.opts.toolRegistry, NAMED_SECRET_SEED_PROVIDERS);
  }

  /** List every named secret across all provider namespaces, with MASKED
   *  previews only. The raw value never crosses this boundary. */
  async list(): Promise<{ secrets: NamedSecretView[] }> {
    const out: NamedSecretView[] = [];
    for (const { provider, kinds } of this.providers().providers) {
      const prefix = `providers/${provider}/`;
      const refs = await this.opts.secrets.list(prefix);
      for (const ref of refs) {
        const name = ref.slice(prefix.length);
        // Only flat `<name>` entries — no nested paths under a provider.
        if (!name || name.includes('/')) continue;
        const value = await this.opts.secrets.get(ref);
        out.push({ provider, name, preview: redactSecret(value), kind: kinds[0] ?? '' });
      }
    }
    out.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    return { secrets: out };
  }

  /** Create / overwrite a named secret. The raw value is written to the vault
   *  and is NOT echoed back — the caller receives only a masked preview. */
  async create(input: {
    provider: string;
    name: string;
    value: string;
  }): Promise<{ ok: true; preview: string }> {
    const provider = this.assertProvider(input.provider);
    const name = this.assertName(input.name);
    if (input.value.length === 0) {
      throw invalid('Secret value must not be empty.', 'Enter the API key value.');
    }
    if (Buffer.byteLength(input.value, 'utf8') > MAX_VALUE_BYTES) {
      throw invalid('Secret value is too large.', 'API keys are short — paste only the key.');
    }
    await this.opts.secrets.set(`providers/${provider}/${name}`, input.value);
    return { ok: true, preview: redactSecret(input.value) };
  }

  /** Delete a named secret. Idempotent — a missing secret is already gone. */
  async delete(input: { provider: string; name: string }): Promise<{ ok: true }> {
    const provider = this.assertProvider(input.provider);
    const name = this.assertName(input.name);
    await this.opts.secrets.delete(`providers/${provider}/${name}`);
    return { ok: true };
  }

  /** Optional probe — resolves the stored value and makes one lightweight
   *  authenticated request to the provider so the user can confirm the key
   *  works. The raw key travels provider-ward only, never back to the client.
   *  A provider with no probe branch (`x` — every search call is billable, and
   *  any derived provider nothing here knows about) is reported as
   *  `tested: false`: the secret exists, its validity is unknown. */
  async testKey(input: {
    provider: string;
    name: string;
  }): Promise<{ ok: boolean; error?: string; tested?: boolean }> {
    const provider = this.assertProvider(input.provider);
    const name = this.assertName(input.name);
    const value = await this.opts.secrets.get(`providers/${provider}/${name}`);
    if (!value) return { ok: false, error: 'Secret not found.' };
    try {
      return await probeProvider(provider, value);
    } catch (err) {
      // This path handled the raw API key in fetch headers — never echo the
      // caught error verbatim (it can carry the URL, headers, or key). Collapse
      // to a fixed category the client can render safely.
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        error: aborted ? 'Key check timed out.' : 'Key check could not be completed.',
      };
    }
  }

  private assertProvider(provider: string): string {
    const roster = this.providers().providers;
    if (roster.some((p) => p.provider === provider)) return provider;
    throw invalid(
      `Unknown provider "${provider}".`,
      roster.length === 0
        ? 'No tool declaring a credential namespace is registered yet — start a chat so the tool registry boots, or set the key with `ethos secrets set`.'
        : `Use one of: ${roster.map((p) => p.provider).join(', ')}.`,
    );
  }

  private assertName(name: string): string {
    if (!isValidSecretName(name)) {
      throw invalid(
        `Invalid secret name "${name}".`,
        'Use letters, digits, hyphens, and underscores only.',
      );
    }
    return name;
  }
}

/**
 * Mask a secret value for display:
 *   • `sk-…abc1` — first 3 + last 4 (10+ chars)
 *   • `<set>`    — present but shorter than 10 (too short to preview without
 *                 over-exposing a real key — e.g. a 6-char key showing 4 chars)
 *   • `<unset>`  — absent/empty
 */
export function redactSecret(value: string | null | undefined): string {
  if (!value) return '<unset>';
  if (value.length >= 10) return `${value.slice(0, 3)}…${value.slice(-4)}`;
  return '<set>';
}

// ---------------------------------------------------------------------------
// Per-provider key probes. Each makes a single minimal authenticated request
// and treats a 2xx (or a non-auth error) as "the key is accepted".
// ---------------------------------------------------------------------------

/**
 * A well-formed, real YouTube video id used purely to shape a minimal
 * `videos.list` probe request — the key check depends only on whether the
 * API accepts the key, not on the video existing.
 */
const GOOGLE_PROBE_VIDEO_ID = 'dQw4w9WgXcQ';

/**
 * The providers `probeProvider` has a live branch for. Exported so a test can
 * assert every derived in-tree provider is here or on `PROBE_EXEMPT_PROVIDERS`
 * — the replacement for the `never` exhaustiveness guard the derived roster
 * removed, since a `string` provider has nothing to narrow (§7.3). It catches
 * the in-tree case, which is the one that regresses; a plugin's tool could
 * never have had a compile-forced branch anyway.
 */
export const PROBED_PROVIDERS: readonly string[] = [
  'brave',
  'exa',
  'google',
  'google-search-console',
  'openai',
  'tavily',
  'xai',
];

/** Derived providers deliberately left without a probe. `x` short-circuited at
 *  the same `{ ok: true, tested: false }` before the roster was derived: every
 *  X search call is billable, so there is no free request to make. */
export const PROBE_EXEMPT_PROVIDERS: readonly string[] = ['x'];

async function probeProvider(
  provider: string,
  key: string,
): Promise<{ ok: boolean; error?: string; tested?: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    if (provider === 'xai') {
      const res = await fetch('https://api.x.ai/v1/models', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      return interpret(res.status);
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      return interpret(res.status);
    } else if (provider === 'exa') {
      const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ query: 'ethos key check', numResults: 1 }),
        signal: controller.signal,
      });
      return interpret(res.status);
    } else if (provider === 'tavily') {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: key, query: 'ethos key check', max_results: 1 }),
        signal: controller.signal,
      });
      return interpret(res.status);
    } else if (provider === 'google') {
      // YouTube Data API v3 keys travel on the query string, not a header.
      // Unlike every other provider here, YouTube reports keyInvalid,
      // quotaExceeded and accessNotConfigured all as HTTP 403 — `interpret()`
      // would flatten all three to one generic "Key rejected" message, which
      // is wrong for quotaExceeded (the key IS valid) and for
      // accessNotConfigured (a per-project setting, not the key). Read
      // `error.errors[0].reason` from the body first and only fall back to
      // `interpret()` when the reason is absent or unrecognized.
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=id&id=${GOOGLE_PROBE_VIDEO_ID}&key=${encodeURIComponent(key)}`,
        { headers: { Accept: 'application/json' }, signal: controller.signal },
      );
      if (res.status === 403) {
        const reason = await readGoogleErrorReason(res);
        if (reason === 'quotaExceeded') {
          return {
            ok: true,
            error: 'Key accepted — the YouTube Data API daily quota is currently exhausted.',
          };
        }
        if (reason === 'accessNotConfigured') {
          return {
            ok: false,
            error:
              'Key rejected — the YouTube Data API v3 is not enabled for this Google Cloud project.',
          };
        }
      }
      return interpret(res.status);
    } else if (provider === 'google-search-console') {
      // The only credential here that is not a bearer string: a service-account
      // JSON whose private key has to be RS256-signed into a JWT assertion and
      // exchanged for an access token before anything can be called. That
      // crypto — and the two error mappers that make a failure actionable —
      // live in the extension that already owns them, so the Keys pane and the
      // tools can never disagree about what went wrong (plan D19, §18). The
      // apps → extensions edge is the direction the layer model allows and is
      // already precedented by `@ethosagent/tools-mcp` / `tools-ui` /
      // `tools-voice` above.
      return await probeServiceAccountKey(key, { signal: controller.signal });
    } else if (provider === 'brave') {
      const res = await fetch(
        'https://api.search.brave.com/res/v1/web/search?q=ethos%20key%20check&count=1',
        {
          headers: { Accept: 'application/json', 'X-Subscription-Token': key },
          signal: controller.signal,
        },
      );
      return interpret(res.status);
    } else {
      // No branch for this provider — the honest answer, and the same one `x`
      // has always given: the secret exists, its validity is unknown. The
      // roster is derived, so `provider` is a `string` and there is nothing a
      // `never` could narrow; `PROBED_PROVIDERS` plus a test replaces the
      // compile-forced branch for in-tree tools (§7.3).
      return { ok: true, tested: false };
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function readGoogleErrorReason(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { errors?: Array<{ reason?: string }> } };
    return body.error?.errors?.[0]?.reason;
  } catch {
    return undefined;
  }
}

function interpret(status: number): { ok: boolean; error?: string } {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, error: 'Key rejected (unauthorized).' };
  if (status === 429) return { ok: true }; // rate-limited but authenticated
  return { ok: false, error: `Provider returned HTTP ${status}.` };
}

function invalid(cause: string, action: string): EthosError {
  return new EthosError({ code: 'INVALID_INPUT', cause, action });
}
