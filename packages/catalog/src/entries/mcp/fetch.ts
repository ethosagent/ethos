import type { CatalogEntry } from '@ethosagent/types';

// Verified 2026-11-05 · PyPI wheel mcp_server_fetch-2026.11.4-py3-none-any.whl.
// Launched with `uvx mcp-server-fetch@2026.11.4`; a tools/list handshake
// returned 1 tool (`fetch`).
// Licence: PyPI `info.license` is "MIT" (classifier "MIT License").
//
// network ['*']: the server fetches whatever URL the model gives it.
export const fetch: CatalogEntry = {
  id: 'fetch',
  kind: 'mcp',
  name: 'fetch',
  description: 'HTTP fetch operations (requires uvx)',
  category: 'Web',
  publisher: 'Model Context Protocol',
  tier: 'verified',
  pin: {
    type: 'pypi',
    package: 'mcp-server-fetch',
    version: '2026.11.4',
    integrity: 'sha256-7c5891e3d3e3ea7d2d8c21acb9c64ccd30ff1f42beeea59f95715637b970307d',
  },
  capabilities: {
    network: ['*'],
    auth: 'none',
    env: [],
    filesystem: 'none',
    shell: false,
    toolCount: 1,
  },
  license: 'MIT',
  reviewedAt: '2026-11-05',
  mcp: { argsAfterSpec: [], argVars: [], envVars: [] },
};
