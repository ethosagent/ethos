import { EthosError, type SecretsResolver } from '@ethosagent/types';

// Global named-secrets vault manager (Phase 2, web-search-provider-selection).
//
// A named secret is stored at `providers/<provider>/<name>` in the secrets
// vault — the same namespace `web_search`'s capability prefix grant
// (`providers/{exa,tavily,brave}/*`) allows. A personality only ever stores
// the secret NAME (a reference); the VALUE lives here and NEVER round-trips
// back to the client — reads are masked previews only.
//
// v1 scopes named secrets to the three web_search provider namespaces (the sole
// consumer). Everything is provider-scoped: kind `web-search` ⟺ provider ∈
// {exa, tavily, brave}.

/** Provider namespaces a `web-search` named secret may live under. */
const WEB_SEARCH_PROVIDERS = ['exa', 'tavily', 'brave'] as const;
export type NamedSecretProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export interface NamedSecretView {
  provider: NamedSecretProvider;
  name: string;
  /** Masked preview — e.g. `sk-…abc1`. Never the raw value. */
  preview: string;
  /** Category the SecretPicker filters by. Always `'web-search'` in v1. */
  kind: 'web-search';
}

export interface NamedSecretsServiceOptions {
  secrets: SecretsResolver;
}

export class NamedSecretsService {
  constructor(private readonly opts: NamedSecretsServiceOptions) {}

  /** List every named secret across the web_search provider namespaces, with
   *  MASKED previews only. The raw value never crosses this boundary. */
  async list(): Promise<{ secrets: NamedSecretView[] }> {
    const out: NamedSecretView[] = [];
    for (const provider of WEB_SEARCH_PROVIDERS) {
      const prefix = `providers/${provider}/`;
      const refs = await this.opts.secrets.list(prefix);
      for (const ref of refs) {
        const name = ref.slice(prefix.length);
        // Only flat `<name>` entries — no nested paths under a provider.
        if (!name || name.includes('/')) continue;
        const value = await this.opts.secrets.get(ref);
        out.push({ provider, name, preview: redactSecret(value), kind: 'web-search' });
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
   *  works. The raw key travels provider-ward only, never back to the client. */
  async testKey(input: {
    provider: string;
    name: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const provider = this.assertProvider(input.provider);
    const name = this.assertName(input.name);
    const value = await this.opts.secrets.get(`providers/${provider}/${name}`);
    if (!value) return { ok: false, error: 'Secret not found.' };
    try {
      return await probeProvider(provider, value);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private assertProvider(provider: string): NamedSecretProvider {
    if ((WEB_SEARCH_PROVIDERS as readonly string[]).includes(provider)) {
      return provider as NamedSecretProvider;
    }
    throw invalid(
      `Unknown provider "${provider}".`,
      `Use one of: ${WEB_SEARCH_PROVIDERS.join(', ')}.`,
    );
  }

  private assertName(name: string): string {
    if (!NAME_RE.test(name)) {
      throw invalid(
        `Invalid secret name "${name}".`,
        'Use letters, digits, hyphens, and underscores only.',
      );
    }
    return name;
  }
}

/**
 * Mask a secret value for display. Same shape as the config redactor:
 *   • `sk-…abc1` — first 3 + last 4 (10+ chars)
 *   • `…abc1`    — last 4 (6-9 chars)
 *   • `<set>`    — shorter (present but too short to preview safely)
 *   • `<unset>`  — absent/empty
 */
export function redactSecret(value: string | null | undefined): string {
  if (!value) return '<unset>';
  if (value.length >= 10) return `${value.slice(0, 3)}…${value.slice(-4)}`;
  if (value.length >= 6) return `…${value.slice(-4)}`;
  return '<set>';
}

// ---------------------------------------------------------------------------
// Per-provider key probes. Each makes a single minimal authenticated request
// and treats a 2xx (or a non-auth error) as "the key is accepted".
// ---------------------------------------------------------------------------

async function probeProvider(
  provider: NamedSecretProvider,
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    if (provider === 'exa') {
      const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ query: 'ethos key check', numResults: 1 }),
        signal: controller.signal,
      });
      return interpret(res.status);
    }
    if (provider === 'tavily') {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: key, query: 'ethos key check', max_results: 1 }),
        signal: controller.signal,
      });
      return interpret(res.status);
    }
    // brave
    const res = await fetch(
      'https://api.search.brave.com/res/v1/web/search?q=ethos%20key%20check&count=1',
      {
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
        signal: controller.signal,
      },
    );
    return interpret(res.status);
  } finally {
    clearTimeout(timeout);
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
