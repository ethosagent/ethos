import type { CatalogEntry } from '@ethosagent/types';

// 2026-11-05: unauthenticated initialize returned 401 with a WWW-Authenticate
// resource_metadata challenge. DCR was not re-walked. toolCount is absent:
// tools/list needs a token.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const notion: CatalogEntry = {
  id: 'notion',
  kind: 'mcp',
  name: 'Notion',
  description: 'Search and edit Notion pages and databases',
  category: 'Productivity',
  publisher: 'Notion',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://mcp.notion.com/mcp', transport: 'streamable-http' },
  capabilities: {
    network: ['mcp.notion.com'],
    auth: 'oauth',
    env: [],
    filesystem: 'none',
    shell: false,
  },
  license: null,
  homepage: 'https://developers.notion.com/docs/mcp',
  reviewedAt: '2026-11-05',
};
