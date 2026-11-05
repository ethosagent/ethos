import type { CatalogEntry } from '@ethosagent/types';

// Verified 2026-11-05 · PyPI wheel mcp_server_git-2026.11.4-py3-none-any.whl.
// Launched with `uvx mcp-server-git@2026.11.4 --repository <path>`; a
// tools/list handshake returned 14 tools.
// Licence: PyPI `info.license` is "MIT" (classifier "MIT License").
//
// `--repository` is a flag, so it lives in `argsAfterSpec`; the path the user
// supplies is the `GIT_REPO_PATH` argVar.
export const git: CatalogEntry = {
  id: 'git',
  kind: 'mcp',
  name: 'git',
  description: 'Git repository operations (requires uvx)',
  category: 'Developer tools',
  publisher: 'Model Context Protocol',
  tier: 'verified',
  pin: {
    type: 'pypi',
    package: 'mcp-server-git',
    version: '2026.11.4',
    integrity: 'sha256-0cdaa8f446554d020f8ffa0e44ef45b89df4ed4deaeb961b4305d8a2852b4e0e',
  },
  capabilities: {
    network: [],
    auth: 'none',
    env: [],
    filesystem: 'user-path',
    shell: false,
    toolCount: 14,
  },
  license: 'MIT',
  reviewedAt: '2026-11-05',
  mcp: { argsAfterSpec: ['--repository'], argVars: ['GIT_REPO_PATH'], envVars: [] },
};
