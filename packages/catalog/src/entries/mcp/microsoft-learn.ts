import type { CatalogEntry } from '@ethosagent/types';

// 2026-11-05: anonymous initialize + tools/list returned 3 tools.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const microsoftLearn: CatalogEntry = {
  id: 'microsoft-learn',
  kind: 'mcp',
  name: 'Microsoft Learn',
  description: 'Search official Microsoft and Azure documentation and code samples',
  category: 'Docs & knowledge',
  publisher: 'Microsoft',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://learn.microsoft.com/api/mcp', transport: 'streamable-http' },
  capabilities: {
    network: ['learn.microsoft.com'],
    auth: 'none',
    env: [],
    filesystem: 'none',
    shell: false,
    toolCount: 3,
  },
  license: null,
  homepage: 'https://github.com/MicrosoftDocs/mcp',
  reviewedAt: '2026-11-05',
};
