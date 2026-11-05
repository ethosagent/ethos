import type { CatalogEntry } from '@ethosagent/types';

// Group: Developer tools (OAuth, DCR-installable).
// 2026-11-05: unauthenticated initialize returned 401 with a WWW-Authenticate
// resource_metadata challenge. DCR was not re-walked. toolCount is absent:
// tools/list needs a token.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const sentry: CatalogEntry = {
  id: 'sentry',
  kind: 'mcp',
  name: 'Sentry',
  description: 'Search Sentry issues and inspect events, traces, and releases',
  category: 'Developer tools',
  publisher: 'Sentry',
  tier: 'verified',
  pin: { type: 'remote', url: 'https://mcp.sentry.dev/mcp', transport: 'streamable-http' },
  capabilities: {
    network: ['mcp.sentry.dev'],
    auth: 'oauth',
    env: [],
    filesystem: 'none',
    shell: false,
  },
  license: null,
  reviewedAt: '2026-11-05',
};
