import type { CatalogEntry } from '@ethosagent/types';

// Use the `/mcp` path, not the `/sse` one most Asana docs show. `/mcp` is a
// real route (a control probe of a bogus path 404s) and speaks
// streamable-http, which is the transport the remote pin type models.
// 2026-11-05: unauthenticated initialize returned 401 with a WWW-Authenticate
// resource_metadata challenge. DCR was not re-walked. toolCount is absent:
// tools/list needs a token.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const asana: CatalogEntry = {
  id: 'asana',
  kind: 'mcp',
  name: 'Asana',
  description: 'Read and update Asana tasks, projects, and workspaces',
  category: 'Productivity',
  publisher: 'Asana',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://mcp.asana.com/mcp', transport: 'streamable-http' },
  capabilities: {
    network: ['mcp.asana.com'],
    auth: 'oauth',
    env: [],
    filesystem: 'none',
    shell: false,
  },
  license: null,
  homepage: 'https://developers.asana.com/docs/using-asanas-mcp-server',
  reviewedAt: '2026-11-05',
};
