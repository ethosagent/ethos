import type { CatalogEntry } from '@ethosagent/types';

// Group: Productivity (OAuth, DCR-installable).
// 2026-11-05: unauthenticated initialize returned 401 with a WWW-Authenticate
// resource_metadata challenge. DCR was not re-walked. toolCount is absent:
// tools/list needs a token.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const linear: CatalogEntry = {
  id: 'linear',
  kind: 'mcp',
  name: 'Linear',
  description: 'Read and update Linear issues, projects, and cycles',
  category: 'Productivity',
  publisher: 'Linear',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://mcp.linear.app/mcp', transport: 'streamable-http' },
  capabilities: {
    network: ['mcp.linear.app'],
    auth: 'oauth',
    env: [],
    filesystem: 'none',
    shell: false,
  },
  license: null,
  homepage: 'https://linear.app/docs/mcp',
  reviewedAt: '2026-11-05',
};
