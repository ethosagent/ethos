import { beforeEach, describe, expect, it } from 'vitest';
import { clearTokenCache } from '../auth';
import { DEFAULT_SECRET_REF, NO_KEY_MESSAGE } from '../constants';
import { createGscSitesTool } from '../sites';
import { CLIENT_EMAIL, makeCtx, makeRouter, serviceAccountJson } from './fixtures';

beforeEach(() => {
  clearTokenCache();
});

const tool = createGscSitesTool();

describe('gsc_sites', () => {
  it('renders every property with its permission level and the siteUrl forms note', async () => {
    const { scopedFetch, calls } = makeRouter(() =>
      Response.json({
        siteEntry: [
          { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' },
          { siteUrl: 'https://www.example.com/', permissionLevel: 'siteRestrictedUser' },
        ],
      }),
    );
    const result = await tool.execute({}, makeCtx(scopedFetch));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('sc-domain:example.com');
    expect(result.value).toContain('siteFullUser');
    expect(result.value).toContain('https://www.example.com/');
    expect(result.value).toContain('siteRestrictedUser');
    expect(result.value).toContain('WITH the trailing slash');
    // Mint first, then the API call, with the minted bearer.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://searchconsole.googleapis.com/webmasters/v3/sites');
    const headers = calls[1]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-access-token');
  });

  it('treats an empty roster as ok and names the service account (§7.1)', async () => {
    // `sites.list` on an ungranted account answers with no siteEntry key at all.
    const { scopedFetch } = makeRouter(() => Response.json({}));
    const result = await tool.execute({}, makeCtx(scopedFetch));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain(CLIENT_EMAIL);
    expect(result.value).toContain('Users and permissions');
  });

  it('routes a 403 through describeGscApiError', async () => {
    const { scopedFetch } = makeRouter(
      () =>
        new Response(JSON.stringify({ error: { errors: [{ reason: 'accessNotConfigured' }] } }), {
          status: 403,
        }),
    );
    const result = await tool.execute({}, makeCtx(scopedFetch));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain('not enabled');
  });

  // D32: the vault backend THROWS on a missing ref
  // (packages/wiring/src/build-infrastructure.ts), it does not return null — so
  // a stub returning null would pin an unreachable branch and prove nothing.
  it('answers a THROWING secrets backend with the no-key message and never the raw ref', async () => {
    const { scopedFetch, calls } = makeRouter(() => Response.json({}));
    const throwingSecrets = {
      get: async (ref: string) => {
        throw new Error(`Secret ${ref} not found`);
      },
    };
    const result = await tool.execute({}, makeCtx(scopedFetch, throwingSecrets));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toBe(NO_KEY_MESSAGE);
    expect(result.error).not.toContain(DEFAULT_SECRET_REF);
    expect(result.error).not.toContain('providers/');
    expect(calls).toHaveLength(0);
  });

  it('refuses a malformed stored credential as input_invalid, naming the field', async () => {
    const { scopedFetch } = makeRouter(() => Response.json({}));
    const secrets = { get: async () => serviceAccountJson({ private_key: undefined }) };
    const result = await tool.execute({}, makeCtx(scopedFetch, secrets));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('private_key');
  });

  it('declares both hosts, the prefix secret grant, and the shared settings key', () => {
    expect(tool.capabilities.network?.allowedHosts).toEqual([
      'searchconsole.googleapis.com',
      'oauth2.googleapis.com',
    ]);
    expect(tool.capabilities.secrets).toEqual(['providers/google-search-console/*']);
    expect(tool.settingsKey).toBe('search_console');
    expect(tool.isAvailable?.()).toBe(true);
  });
});
