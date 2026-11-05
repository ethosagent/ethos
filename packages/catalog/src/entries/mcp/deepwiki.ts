import type { CatalogEntry } from '@ethosagent/types';

// Group: Docs & knowledge (no auth).
// 2026-11-05: initialize + tools/list over streamable-http, no credentials, returned 3 tools.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const deepwiki: CatalogEntry = {
  id: 'deepwiki',
  kind: 'mcp',
  name: 'DeepWiki',
  description: 'Ask questions about any public GitHub repo and get answers grounded in its source',
  category: 'Docs & knowledge',
  publisher: 'Cognition (Devin)',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://mcp.deepwiki.com/mcp', transport: 'streamable-http' },
  capabilities: {
    network: ['mcp.deepwiki.com'],
    auth: 'none',
    env: [],
    filesystem: 'none',
    shell: false,
    toolCount: 3,
  },
  license: null,
  homepage: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
  reviewedAt: '2026-11-05',
};
