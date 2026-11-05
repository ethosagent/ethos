import type { CatalogEntry } from '@ethosagent/types';

// Bare origin — no `/mcp` path on this host.
// 2026-11-05: unauthenticated initialize returned 401 with a WWW-Authenticate
// resource_metadata challenge. DCR was not re-walked. toolCount is absent:
// tools/list needs a token.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const vercel: CatalogEntry = {
  id: 'vercel',
  kind: 'mcp',
  name: 'Vercel',
  description: 'Inspect Vercel projects, deployments, and build logs',
  category: 'Developer tools',
  publisher: 'Vercel',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://mcp.vercel.com', transport: 'streamable-http' },
  capabilities: {
    network: ['mcp.vercel.com'],
    auth: 'oauth',
    env: [],
    filesystem: 'none',
    shell: false,
  },
  license: null,
  homepage: 'https://vercel.com/docs/mcp/vercel-mcp',
  reviewedAt: '2026-11-05',
};
