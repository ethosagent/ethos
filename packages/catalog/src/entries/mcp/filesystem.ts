import type { CatalogEntry } from '@ethosagent/types';

// Verified 2026-11-05 · npm · launched with `npx -y --ignore-scripts` and
// kept serving. A tools/list handshake against the pinned version returned 16
// tools (started with one allowed directory).
//
// Licence: npm's `license` field is "SEE LICENSE IN LICENSE" and the tarball
// ships no LICENSE file, so the SPDX id was read from the upstream repo
// (modelcontextprotocol/servers, `LICENSE` on main, 2026-11-05): it states an
// MIT -> Apache-2.0 transition, with Apache-2.0 for new contributions and MIT
// retained for unrelocated ones, and contains both licence texts. Hence
// `MIT AND Apache-2.0`. The package README says only "MIT".
//
// The server takes allowed directories as positional args, NOT from the
// environment. Started with none it logs "Started without allowed
// directories" and every tool call fails.
export const filesystem: CatalogEntry = {
  id: 'filesystem',
  kind: 'mcp',
  name: 'filesystem',
  description: 'Read/write local files under a required allowed path',
  category: 'Developer tools',
  publisher: 'Model Context Protocol',
  tier: 'verified',
  pin: {
    type: 'npm',
    package: '@modelcontextprotocol/server-filesystem',
    version: '2.2.0',
    integrity:
      'sha512-mNLj/qhV+P4kj1qP8VzgQ2fjSmWcKDQ3Q+KpZEA+WahCDWHw5zJBRQUNSPZ6Ai2/ZGGUjzNzsFpz958a1+4T9A==',
  },
  capabilities: {
    network: [],
    auth: 'none',
    env: [],
    filesystem: 'user-path',
    shell: false,
    toolCount: 16,
  },
  license: 'MIT AND Apache-2.0',
  reviewedAt: '2026-11-05',
  mcp: { argsAfterSpec: [], argVars: ['ALLOWED_PATH'], envVars: [] },
};
