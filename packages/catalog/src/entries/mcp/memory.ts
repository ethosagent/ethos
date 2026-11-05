import type { CatalogEntry } from '@ethosagent/types';

// Verified 2026-11-05 · npm · launched with `npx -y --ignore-scripts` and
// kept serving. A tools/list handshake against the pinned version returned 9
// tools.
//
// Licence: npm's `license` field is "SEE LICENSE IN LICENSE" and the tarball
// ships no LICENSE file, so the SPDX id was read from the upstream repo
// (modelcontextprotocol/servers, `LICENSE` on main, 2026-11-05): an MIT ->
// Apache-2.0 transition containing both licence texts. Hence
// `MIT AND Apache-2.0`. See filesystem.ts for the same determination.
//
// MEMORY_FILE_PATH is optional — the server defaults to a memory.json beside
// the installed package (filesystem 'own-state').
export const memory: CatalogEntry = {
  id: 'memory',
  kind: 'mcp',
  name: 'memory',
  description: 'Key-value memory store',
  category: 'Utilities',
  publisher: 'Model Context Protocol',
  tier: 'verified',
  pin: {
    type: 'npm',
    package: '@modelcontextprotocol/server-memory',
    version: '2.1.0',
    integrity:
      'sha512-4rhufvmutolbl5O/RflMRenzhYnSh/wij3uMK8H2vuZ2xSGgrA6O2VXwsg/+tSb2UsU1hVDw1XwZ2lcCz8XR2g==',
  },
  capabilities: {
    network: [],
    auth: 'none',
    env: ['MEMORY_FILE_PATH'],
    filesystem: 'own-state',
    shell: false,
    toolCount: 9,
  },
  license: 'MIT AND Apache-2.0',
  reviewedAt: '2026-11-05',
  mcp: { argsAfterSpec: [], argVars: [], envVars: ['MEMORY_FILE_PATH'] },
};
