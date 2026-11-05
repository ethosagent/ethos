import type { CatalogEntry } from '@ethosagent/types';

// Bare origin — there is NO `/mcp` path on this host. Appending one is the
// obvious-looking mistake and does not resolve to the server.
// Responds with plain `application/json` and negotiates MCP protocol
// `2025-03-26` rather than SSE / `2025-06-18`. Both are fine: our client uses
// the official SDK's StreamableHTTPClientTransport, which branches on the
// response content-type and accepts `application/json`, and `2025-03-26` is
// in the SDK's SUPPORTED_PROTOCOL_VERSIONS.
// 2026-11-05: anonymous initialize + tools/list returned 5 tools.
// Remote MCP server: no code is fetched, so `license` is null (D6) and the pin
// is the URL. Reachability re-checked 2026-11-05 (see the per-entry notes).
export const awsKnowledge: CatalogEntry = {
  id: 'aws-knowledge',
  kind: 'mcp',
  name: 'AWS Knowledge',
  description: 'Search and retrieve official AWS documentation and API references',
  category: 'Docs & knowledge',
  publisher: 'Amazon Web Services',
  tier: 'verified',
  pin: {
    type: 'remote',
    url: 'https://knowledge-mcp.global.api.aws',
    transport: 'streamable-http',
  },
  capabilities: {
    network: ['knowledge-mcp.global.api.aws'],
    auth: 'none',
    env: [],
    filesystem: 'none',
    shell: false,
    toolCount: 5,
  },
  license: null,
  homepage: 'https://github.com/awslabs/mcp/tree/main/src/aws-knowledge-mcp-server',
  reviewedAt: '2026-11-05',
};
