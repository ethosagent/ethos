import type { Tool, ToolSettingsField, ToolSettingsSecretBindingField } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  deriveProviderRoster,
  NAMED_SECRET_SEED_PROVIDERS,
} from '../../services/derive-provider-roster';
import { PROBE_EXEMPT_PROVIDERS, PROBED_PROVIDERS } from '../../services/named-secrets.service';

// ---------------------------------------------------------------------------
// The provider roster, derived from the registered tools' capability grants
// (plan/phases/tool-credential-surface.md D1–D2). This file replaces
// `packages/web-contracts/src/__tests__/named-secret-provider-kinds.test.ts`,
// which pinned the hand-maintained enum this derivation deletes; both of its
// provider→kind pins are preserved below over the derived roster instead.
// ---------------------------------------------------------------------------

function tool(name: string, secrets: string[], fields: ToolSettingsField[] = []): Tool {
  return {
    name,
    description: name,
    schema: { type: 'object' },
    capabilities: { secrets },
    ...(fields.length > 0 ? { settingsSchema: { fields } } : {}),
    execute: async () => ({ ok: true, value: '' }),
  };
}

function registryOf(...tools: Tool[]) {
  return { getAvailable: () => tools };
}

function binding(
  secretKind: string,
  extra: Omit<ToolSettingsSecretBindingField, 'kind' | 'key' | 'label' | 'secretKind'> = {},
): ToolSettingsSecretBindingField {
  return { kind: 'secret-binding', key: 'secret', label: 'Key', secretKind, ...extra };
}

/**
 * The shipped `capabilities.secrets` declarations, restated (§7.4). A fixture
 * rather than the real tool modules because `apps/web-api` depends on exactly
 * one tool package (`@ethosagent/tools-search-console`) and adding four more
 * for a test would be a real dependency edge bought for an assertion. It pins
 * the plan's table: a tool changing its declaration must be reflected here.
 *
 *   extensions/tools-web/src/index.ts              web_search, fetch_url
 *   extensions/tools-answer-engines/src/index.ts   engine_ask
 *   extensions/tools-social-search/src/youtube/    youtube_search, youtube_comments
 *   extensions/tools-social-search/src/site/       linkedin/quora/reddit web search
 *   extensions/tools-search-console/src/constants  gsc_sites, gsc_queries
 *   extensions/tools-x-search/src/index.ts         x_search
 *   extensions/tools-reddit/src/index.ts           reddit_*
 *   extensions/tools-image/src/index.ts            image_generate
 */
function inTreeRegistry() {
  const webSearchProviders = ['providers/exa/*', 'providers/tavily/*', 'providers/brave/*'];
  return registryOf(
    tool('web_search', webSearchProviders, [
      {
        kind: 'enum',
        key: 'provider',
        label: 'Provider',
        options: [
          { value: 'exa', label: 'Exa', getKeyUrl: 'https://exa.ai/' },
          { value: 'tavily', label: 'Tavily', getKeyUrl: 'https://tavily.com/' },
          {
            value: 'brave',
            label: 'Brave Search',
            getKeyUrl: 'https://brave.com/search/api/',
          },
        ],
      },
      binding('web-search'),
    ]),
    tool('fetch_url', ['providers/exa/apiKey']),
    tool(
      'engine_ask',
      ['providers/openai/*', 'providers/perplexity/apiKey'],
      [
        binding('answer-engine', {
          providerLabel: 'OpenAI (ChatGPT answer engine)',
          getKeyUrl: 'https://platform.openai.com/api-keys',
        }),
      ],
    ),
    tool(
      'youtube_search',
      ['providers/google/*'],
      [binding('youtube-api-key', { providerLabel: 'Google (YouTube Data API)' })],
    ),
    tool(
      'youtube_comments',
      ['providers/google/*'],
      [binding('youtube-api-key', { providerLabel: 'Google (YouTube Data API)' })],
    ),
    tool('linkedin_search', webSearchProviders),
    tool('quora_search', webSearchProviders),
    tool('reddit_web_search', webSearchProviders),
    tool(
      'gsc_sites',
      ['providers/google-search-console/*'],
      [
        binding('gsc-service-account', {
          providerLabel: 'Google Search Console (service account)',
          defaultSecretName: 'serviceAccount',
        }),
      ],
    ),
    tool(
      'x_search',
      ['providers/xai/*'],
      [binding('x-search', { providerLabel: 'xAI (Grok, X search)' })],
    ),
    tool('reddit_search', ['providers/reddit/client_id', 'providers/reddit/client_secret']),
    tool('image_generate', ['providers/openai/apiKey', 'providers/replicate/apiToken']),
  );
}

describe('deriveProviderRoster', () => {
  it('derives a provider from a tool that declares providers/<segment>/*', () => {
    const { providers, diagnostics } = deriveProviderRoster(
      registryOf(
        tool(
          'serp_lookup',
          ['providers/dataforseo/*'],
          [
            binding('serp-data', {
              providerLabel: 'DataForSEO',
              getKeyUrl: 'https://dataforseo.com/',
            }),
          ],
        ),
      ),
    );
    expect(diagnostics).toEqual([]);
    expect(providers).toEqual([
      {
        provider: 'dataforseo',
        kinds: ['serp-data'],
        label: 'DataForSEO',
        getKeyUrl: 'https://dataforseo.com/',
      },
    ]);
  });

  it('falls back to the provider segment when the tool supplies no label', () => {
    const { providers } = deriveProviderRoster(
      registryOf(tool('serp_lookup', ['providers/dataforseo/*'], [binding('serp-data')])),
    );
    expect(providers.map((p) => [p.provider, p.label])).toEqual([['dataforseo', 'dataforseo']]);
  });

  // D2: the gate on MANAGEMENT. A malformed declaration contributes no
  // namespace and is reported — never thrown, because a tool is registered
  // during composition and one bad declaration must not take the process down.
  it.each([
    'providers/*',
    'providers/a/b/*',
    'providers/../x/*',
    'providers//x/*',
    'providers/a b/*',
    'providers/a.b/*',
    'secrets/foo/*',
  ])('contributes nothing and reports a diagnostic for %s', (declared) => {
    const { providers, diagnostics } = deriveProviderRoster(
      registryOf(tool('bad_tool', [declared], [binding('serp-data')])),
    );
    expect(providers).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.toolName).toBe('bad_tool');
    expect(diagnostics[0]?.declared).toBe(declared);
    expect(diagnostics[0]?.reason).toContain('bad_tool');
    expect(diagnostics[0]?.reason).toContain(declared);
  });

  // An exact-ref grant is a specific credential, not a namespace names can be
  // added under, and four shipped tools declare one deliberately (§7.4). It
  // contributes nothing and is NOT reported: a diagnostic here would be
  // permanent noise in the operator-visible row for correct declarations.
  it.each(['providers/dataforseo', 'providers/dataforseo/apiKey'])(
    'contributes nothing and stays silent for the non-prefix grant %s',
    (declared) => {
      const roster = deriveProviderRoster(
        registryOf(tool('exact_tool', [declared], [binding('serp-data')])),
      );
      expect(roster).toEqual({ providers: [], diagnostics: [] });
    },
  );

  // The engine_ask case of the rule above, pinned on its own because it is the
  // one shipped tool that declares a prefix and an exact ref side by side: the
  // Perplexity key is one operator-wide credential, so it publishes no
  // namespace — and no diagnostic either, because that is deliberate.
  it("publishes no perplexity namespace — engine_ask's perplexity grant is an exact ref", () => {
    const { providers, diagnostics } = deriveProviderRoster(inTreeRegistry());
    expect(providers.map((p) => p.provider)).not.toContain('perplexity');
    expect(diagnostics.filter((d) => d.declared.includes('perplexity'))).toEqual([]);
  });

  it('unions the kinds of two tools declaring the same provider into one row', () => {
    const { providers } = deriveProviderRoster(
      registryOf(
        tool('a_tool', ['providers/google/*'], [binding('youtube-api-key')]),
        tool('b_tool', ['providers/google/*'], [binding('gmail-api-key')]),
      ),
    );
    expect(providers).toHaveLength(1);
    expect(providers[0]?.kinds).toEqual(['gmail-api-key', 'youtube-api-key']);
  });

  it('resolves a label first-declaration-wins in registry order', () => {
    const { providers } = deriveProviderRoster(
      registryOf(
        tool('first', ['providers/google/*'], [binding('k', { providerLabel: 'First' })]),
        tool('second', ['providers/google/*'], [binding('k', { providerLabel: 'Second' })]),
      ),
    );
    expect(providers[0]?.label).toBe('First');
  });

  it('derives exactly the seven providers the shipped tools declare', () => {
    const { providers, diagnostics } = deriveProviderRoster(inTreeRegistry());
    expect(providers.map((p) => p.provider)).toEqual([
      'brave',
      'exa',
      'google',
      'google-search-console',
      'openai',
      'tavily',
      'xai',
    ]);
    // `reddit` and `replicate` declare exact refs, so they stay unmanageable
    // until their tools widen to a prefix — recorded in the plan's §15, not
    // fixed here: widening a shipped tool's grant is a security-visible edit.
    expect(providers.map((p) => p.provider)).not.toContain('reddit');
    expect(providers.map((p) => p.provider)).not.toContain('replicate');
    expect(diagnostics).toEqual([]);
  });

  it('adds x only through the compatibility seed — no shipped tool declares it', () => {
    expect(deriveProviderRoster(inTreeRegistry()).providers.map((p) => p.provider)).not.toContain(
      'x',
    );
    const seeded = deriveProviderRoster(inTreeRegistry(), NAMED_SECRET_SEED_PROVIDERS);
    const x = seeded.providers.find((p) => p.provider === 'x');
    expect(x).toEqual({
      provider: 'x',
      kinds: ['x-api'],
      label: 'X API (bearer token)',
      getKeyUrl: 'https://developer.x.com/en/portal/dashboard',
    });
  });

  // Both pins from the deleted contract test, over the derived roster. The two
  // Google namespaces stay distinct: a YouTube Data API key and a Search
  // Console service-account JSON are different credentials with different
  // quotas, failure modes and rotation stories, and a picker filtered by one
  // kind must never offer the other's secrets.
  it('keeps google on youtube-api-key and google-search-console on gsc-service-account', () => {
    const { providers } = deriveProviderRoster(inTreeRegistry());
    const kindsOf = (id: string) => providers.find((p) => p.provider === id)?.kinds;
    expect(kindsOf('google')).toEqual(['youtube-api-key']);
    expect(kindsOf('google-search-console')).toEqual(['gsc-service-account']);
    expect(kindsOf('google')).not.toEqual(kindsOf('google-search-console'));
  });

  it('labels each web-search provider from the tool enum, not one shared providerLabel', () => {
    const { providers } = deriveProviderRoster(inTreeRegistry());
    const labelOf = (id: string) => providers.find((p) => p.provider === id)?.label;
    expect([labelOf('exa'), labelOf('tavily'), labelOf('brave')]).toEqual([
      'Exa',
      'Tavily',
      'Brave Search',
    ]);
  });

  it('takes per-option getKeyUrl for a multi-provider tool', () => {
    const { providers } = deriveProviderRoster(inTreeRegistry());
    const urlOf = (id: string) => providers.find((p) => p.provider === id)?.getKeyUrl;
    expect(urlOf('exa')).toBe('https://exa.ai/');
    expect(urlOf('tavily')).toBe('https://tavily.com/');
    expect(urlOf('brave')).toBe('https://brave.com/search/api/');
  });

  // Replaces the `never` exhaustiveness guard the derived roster removed (§7.3):
  // a `string` provider has nothing to narrow, so a new in-tree provider with
  // no probe branch now silently reports `tested: false` instead of failing to
  // compile. This is the in-tree half of that guard; a plugin's tool could
  // never have had a compile-forced branch anyway.
  it('gives every derived in-tree provider a probe branch or an explicit exemption', () => {
    const { providers } = deriveProviderRoster(inTreeRegistry(), NAMED_SECRET_SEED_PROVIDERS);
    for (const { provider } of providers) {
      expect(
        PROBED_PROVIDERS.includes(provider) || PROBE_EXEMPT_PROVIDERS.includes(provider),
        `provider ${provider} has neither a probe branch nor an exemption`,
      ).toBe(true);
    }
  });

  it('is the seed alone when no registry is wired', () => {
    expect(deriveProviderRoster(undefined, NAMED_SECRET_SEED_PROVIDERS).providers).toEqual([
      ...NAMED_SECRET_SEED_PROVIDERS,
    ]);
    expect(deriveProviderRoster(undefined)).toEqual({ providers: [], diagnostics: [] });
  });
});
