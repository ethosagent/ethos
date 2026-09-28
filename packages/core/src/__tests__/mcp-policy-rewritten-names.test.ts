// UBP-035 — `mcpToolName` rewrites a non-conforming server or tool name
// (`acme.docs` / `files.read`) to a provider-safe one. The mcp.yaml policy is
// keyed by the ORIGINAL names, so both checks must resolve their keys the way
// the registry allowlist gates do (`namesServer` in tool-registry.ts) — or
// `enabled: false` and `reject_args` fail open for exactly those servers.

import type { McpPolicy } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { checkMcpEnabled, checkMcpRejectArgs } from '../agent-loop';
import { DefaultToolRegistry } from '../tool-registry';

const name = DefaultToolRegistry.mcpToolName('acme.docs', 'files.read');

describe('UBP-035 — mcp.yaml policy applies to rewritten MCP tool names', () => {
  it('the name really is rewritten (precondition)', () => {
    expect(name).not.toBe('mcp__acme.docs__files.read');
  });

  it('enabled: false on the original server key refuses the rewritten tool', () => {
    const policy: McpPolicy = { servers: { 'acme.docs': { enabled: false } } };
    expect(checkMcpEnabled(policy, name)).toContain('disabled for this personality');
  });

  it('reject_args keyed by the original server and tool names fires', () => {
    const policy: McpPolicy = {
      servers: { 'acme.docs': { reject_args: { 'files.read': { path: ['/etc/shadow'] } } } },
    };
    expect(checkMcpRejectArgs(policy, name, { path: '/etc/shadow' })).toContain(
      "argument 'path' value '/etc/shadow' is rejected",
    );
    expect(checkMcpRejectArgs(policy, name, { path: '/tmp/ok' })).toBeUndefined();
  });

  it('a different server with the same tool name is unaffected', () => {
    const policy: McpPolicy = {
      servers: { 'other.docs': { enabled: false, reject_args: { 'files.read': { path: ['x'] } } } },
    };
    expect(checkMcpEnabled(policy, name)).toBeUndefined();
    expect(checkMcpRejectArgs(policy, name, { path: 'x' })).toBeUndefined();
  });
});

// V-CP-4 — a server name inside the charset that contains '__' or ends in '_'
// used to be kept verbatim, and the name then split back to the wrong server.
describe.each(['a__b', 'x_'])('V-CP-4 — mcp.yaml policy for server %s', (server) => {
  const tool = DefaultToolRegistry.mcpToolName(server, 'read');

  it('enabled: false on the server refuses its tool', () => {
    const policy: McpPolicy = { servers: { [server]: { enabled: false } } };
    expect(checkMcpEnabled(policy, tool)).toContain('disabled for this personality');
  });

  it('reject_args keyed by the server and tool fires', () => {
    const policy: McpPolicy = {
      servers: { [server]: { reject_args: { read: { path: ['/etc/shadow'] } } } },
    };
    expect(checkMcpRejectArgs(policy, tool, { path: '/etc/shadow' })).toContain(
      "argument 'path' value '/etc/shadow' is rejected",
    );
  });

  it('the registry allowlist gate lists the tool under its server', () => {
    const registry = new DefaultToolRegistry();
    registry.register({
      name: tool,
      description: 'read',
      schema: { type: 'object' },
      capabilities: {},
      async execute() {
        return { ok: true, value: '' };
      },
    });
    const names = registry
      .toDefinitions(undefined, { allowedMcpServers: [server] })
      .map((d) => d.name);
    expect(names).toEqual([tool]);
  });
});
