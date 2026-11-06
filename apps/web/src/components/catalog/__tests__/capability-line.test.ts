import type { CatalogListEntry } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { capabilityLine } from '../capability-line';

function entry(over: Partial<CatalogListEntry>): CatalogListEntry {
  return {
    id: 'x',
    kind: 'mcp',
    name: 'X',
    description: '',
    category: 'c',
    publisher: 'p',
    tier: 'verified',
    pin: { type: 'remote', url: 'https://mcp.linear.app/mcp', transport: 'streamable-http' },
    capabilities: { network: [], auth: 'oauth', env: [], filesystem: 'none', shell: false },
    license: null,
    reviewedAt: '2026-09-04',
    installed: false,
    action: { type: 'oauth', url: 'https://mcp.linear.app/mcp', name: 'x' },
    ...over,
  };
}

describe('capabilityLine', () => {
  it('remote: host, auth, tool count, files', () => {
    const e = entry({
      capabilities: {
        network: [],
        auth: 'oauth',
        env: [],
        filesystem: 'none',
        shell: false,
        toolCount: 23,
      },
    });
    expect(capabilityLine(e)).toBe('mcp.linear.app · OAuth · 23 tools · no files');
  });

  it('omits the tool count when absent and singularises one tool', () => {
    expect(capabilityLine(entry({}))).toBe('mcp.linear.app · OAuth · no files');
    const one = entry({
      capabilities: {
        network: [],
        auth: 'none',
        env: [],
        filesystem: 'none',
        shell: false,
        toolCount: 1,
      },
    });
    expect(capabilityLine(one)).toBe('mcp.linear.app · no auth · 1 tool · no files');
  });

  it('local npm: spec and files, no auth segment when keyless', () => {
    const e = entry({
      pin: {
        type: 'npm',
        package: '@modelcontextprotocol/server-filesystem',
        version: '2.2.0',
        integrity: 'sha512-x',
      },
      capabilities: { network: [], auth: 'none', env: [], filesystem: 'user-path', shell: false },
      action: { type: 'cli', command: 'ethos catalog install x' },
    });
    expect(capabilityLine(e)).toBe('npm @modelcontextprotocol/server-filesystem@2.2.0 · your path');
  });

  it('local with an env key and a shell shows both', () => {
    const e = entry({
      pin: { type: 'pypi', package: 'srv', version: '1.0.0', integrity: 'sha256-x' },
      capabilities: { network: [], auth: 'env', env: ['K'], filesystem: 'own-state', shell: true },
    });
    expect(capabilityLine(e)).toBe('pypi srv@1.0.0 · env key · own state · runs shell');
  });

  it('git pin shortens the commit', () => {
    const e = entry({
      pin: { type: 'git', repo: 'github.com/a/b', commit: 'abcdef0123456789', contentDigest: 'd' },
      capabilities: { network: [], auth: 'none', env: [], filesystem: 'none', shell: false },
    });
    expect(capabilityLine(e)).toBe('git github.com/a/b@abcdef0 · no files');
  });
});
