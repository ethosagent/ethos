import type { CatalogEntry } from '@ethosagent/types';

// Verified 2026-09-04: `initialize` 401s with
// `WWW-Authenticate: Bearer error="invalid_token",
// resource_metadata="https://mcp.granola.ai/.well-known/oauth-protected-resource"`,
// whose metadata names authorization server https://mcp-auth.granola.ai.
// That server publishes `registration_endpoint`
// https://mcp-auth.granola.ai/oauth2/register, lists `"none"` in
// `token_endpoint_auth_methods_supported`, and supports S256 — and a live
// RFC 7591 DCR POST returned a public client (no `client_secret`,
// `token_endpoint_auth_method: "none"`). So it is installable by
// `registerOAuthClient` in extensions/tools-mcp/src/oauth.ts, unlike
// github/supabase (see remote-presets.ts).
// 2026-11-05: the 401 challenge is unchanged. toolCount is absent: tools/list
// needs a token.
//
// No `homepage` on purpose: https://www.granola.ai/docs/mcp 308s to
// https://docs.granola.ai/help-center/mcp, which 404s (probed 2026-09-04).
// A dead link is worse than no link — don't add one back from memory.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const granola: CatalogEntry = {
  id: 'granola',
  kind: 'mcp',
  name: 'Granola',
  description: 'Search your Granola meeting notes and pull transcripts, summaries, and decisions',
  category: 'Productivity',
  publisher: 'Granola',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://mcp.granola.ai/mcp', transport: 'streamable-http' },
  capabilities: {
    network: ['mcp.granola.ai'],
    auth: 'oauth',
    env: [],
    filesystem: 'none',
    shell: false,
  },
  license: null,
  reviewedAt: '2026-11-05',
};
