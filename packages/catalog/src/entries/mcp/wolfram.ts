import type { CatalogEntry } from '@ethosagent/types';

// Host is `agenttools.wolfram.com`, NOT `services.wolfram.com/api/mcp`. The
// latter is what most write-ups show; it 401s and requires a Wolfram account
// bearer token. This one answers anonymously.
// Same plain-`application/json` + protocol `2025-03-26` shape as
// aws-knowledge; the SDK transport handles both.
// 2026-11-05: anonymous initialize + tools/list returned 3 tools.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const wolfram: CatalogEntry = {
  id: 'wolfram',
  kind: 'mcp',
  name: 'Wolfram',
  description: 'Compute answers and query curated data with Wolfram Alpha',
  category: 'Docs & knowledge',
  publisher: 'Wolfram Research',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://agenttools.wolfram.com/mcp', transport: 'streamable-http' },
  capabilities: {
    network: ['agenttools.wolfram.com'],
    auth: 'none',
    env: [],
    filesystem: 'none',
    shell: false,
    toolCount: 3,
  },
  license: null,
  reviewedAt: '2026-11-05',
};
