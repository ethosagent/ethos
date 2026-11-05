import type { CatalogEntry } from '@ethosagent/types';

// Context7 returns a `WWW-Authenticate: Bearer ...` header on a 200 response.
// That is advisory, not a challenge — the server is genuinely no-auth today,
// confirmed by an anonymous `tools/call` returning live data. Do not "fix"
// auth to 'bearer' on seeing that header. An API key only raises rate limits.
// 2026-11-05: anonymous initialize + tools/list returned 2 tools.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const context7: CatalogEntry = {
  id: 'context7',
  kind: 'mcp',
  name: 'Context7',
  description: 'Look up current documentation for a library or framework by name and version',
  category: 'Docs & knowledge',
  publisher: 'Upstash',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://mcp.context7.com/mcp', transport: 'streamable-http' },
  capabilities: {
    network: ['mcp.context7.com'],
    auth: 'none',
    env: [],
    filesystem: 'none',
    shell: false,
    toolCount: 2,
  },
  license: null,
  homepage: 'https://github.com/upstash/context7',
  reviewedAt: '2026-11-05',
};
