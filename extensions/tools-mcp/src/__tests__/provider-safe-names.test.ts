// UBP-035 — every MCP tool name handed to a provider matches
// ^[A-Za-z0-9_-]{1,64}$ (OpenAI/Bedrock/Anthropic reject anything else with a
// 400 on every request that carries it). The name is produced by ONE function,
// `mcpToolName` (packages/core/src/tool-registry.ts); the adapter's execute
// closure keeps the original name for dispatch, and the registry's allowlist
// gates resolve configured names through the same function.

import { DefaultToolRegistry } from '@ethosagent/core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { type McpClient, McpManager, type McpServerConfig, validateMcpServerName } from '../index';

const PROVIDER_SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const LONG_TOOL = `get_${'very_long_segment_'.repeat(3)}and_more_words_to_pass_seventy`;

async function spawnServer(toolNames: string[]) {
  const called: string[] = [];
  const server = new Server({ name: 'names', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    called.push(req.params.name);
    return { content: [{ type: 'text' as const, text: `ran ${req.params.name}` }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport, called };
}

class InMemoryManager extends McpManager {
  private _transports?: Map<string, InstanceType<typeof InMemoryTransport>>;
  setTransport(name: string, t: InstanceType<typeof InMemoryTransport>): void {
    if (!this._transports) this._transports = new Map();
    this._transports.set(name, t);
  }
  protected override _buildClient(config: McpServerConfig): McpClient {
    const real = super._buildClient(config);
    const transport = this._transports?.get(config.name);
    // biome-ignore lint/suspicious/noExplicitAny: test seam (same as mcp-manager-mutability.test.ts)
    if (transport) (real as any)._createTransport = async () => transport;
    return real;
  }
}

describe('mcpToolName', () => {
  it('leaves a conforming name unchanged', () => {
    expect(DefaultToolRegistry.mcpToolName('linear', 'list_issues')).toBe(
      'mcp__linear__list_issues',
    );
  });

  it('rewrites a dotted server and a 70-char tool into a conforming, deterministic name', () => {
    expect(LONG_TOOL.length).toBeGreaterThanOrEqual(70);
    const name = DefaultToolRegistry.mcpToolName('a.b', LONG_TOOL);
    expect(name).toMatch(PROVIDER_SAFE);
    expect(name.startsWith(DefaultToolRegistry.mcpToolPrefix('a.b'))).toBe(true);
    expect(DefaultToolRegistry.mcpToolName('a.b', LONG_TOOL)).toBe(name);
  });

  it('keeps two tools apart when folding and truncation alone would merge them', () => {
    const a = DefaultToolRegistry.mcpToolName('srv', 'files.read');
    const b = DefaultToolRegistry.mcpToolName('srv', 'files read');
    const c = DefaultToolRegistry.mcpToolName('srv', 'files_read');
    expect(new Set([a, b, c]).size).toBe(3);
    const long1 = DefaultToolRegistry.mcpToolName('srv', `${LONG_TOOL}_one`);
    const long2 = DefaultToolRegistry.mcpToolName('srv', `${LONG_TOOL}_two`);
    expect(long1).not.toBe(long2);
    for (const n of [a, b, c, long1, long2]) expect(n).toMatch(PROVIDER_SAFE);
  });

  it('never yields a server half containing "__"', () => {
    const segment = DefaultToolRegistry.mcpServerSegment('acme..docs  hub');
    expect(segment).not.toContain('__');
    expect(segment).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  });
});

describe('McpManager registers provider-safe names (UBP-035)', () => {
  it('a server named a.b with a 70-char tool registers conforming names and dispatches the original', async () => {
    const { clientTransport, called } = await spawnServer([LONG_TOOL, 'short']);
    const mgr = new InMemoryManager([]);
    mgr.setTransport('a.b', clientTransport);
    await mgr.addServer({
      name: 'a.b',
      transport: 'stdio',
      command: 'unused',
      keepaliveSeconds: 0,
    });

    const tools = mgr.getTools();
    expect(tools).toHaveLength(2);
    for (const t of tools) expect(t.name).toMatch(PROVIDER_SAFE);

    const long = tools.find((t) => t.name === DefaultToolRegistry.mcpToolName('a.b', LONG_TOOL));
    if (!long) throw new Error('long tool not registered under its safe name');
    // biome-ignore lint/suspicious/noExplicitAny: ToolContext is irrelevant to dispatch here
    const result = await long.execute({}, {} as any);
    expect(result.ok).toBe(true);
    expect(called).toEqual([LONG_TOOL]);

    // removeServer finds the renamed tools by the same prefix.
    await mgr.removeServer('a.b');
    expect(mgr.getTools()).toHaveLength(0);
    await mgr.disconnect();
  });

  it('keeps the registry allowlists working for a rewritten server name', async () => {
    const { clientTransport } = await spawnServer(['files.read', 'other']);
    const mgr = new InMemoryManager([]);
    mgr.setTransport('acme.docs', clientTransport);
    await mgr.addServer({
      name: 'acme.docs',
      transport: 'stdio',
      command: 'unused',
      keepaliveSeconds: 0,
    });
    const registry = new DefaultToolRegistry();
    for (const t of mgr.getTools()) registry.register(t);

    const visible = (opts: Parameters<DefaultToolRegistry['toDefinitions']>[1]) =>
      registry.toDefinitions(undefined, opts).map((d) => d.name);

    // Allowlisted by its CONFIGURED name — both tools pass the server gate.
    expect(visible({ allowedMcpServers: ['acme.docs'] })).toHaveLength(2);
    expect(visible({ allowedMcpServers: ['other-server'] })).toHaveLength(0);
    // Per-tool allowlist keyed by configured server and ORIGINAL tool name.
    expect(visible({ allowedMcpTools: { 'acme.docs': ['files.read'] } })).toEqual([
      DefaultToolRegistry.mcpToolName('acme.docs', 'files.read'),
    ]);
    await mgr.disconnect();
  });
});

describe('validateMcpServerName', () => {
  it('accepts ordinary names', () => {
    for (const ok of ['linear', 'my-git', 'fs_2', 'A1']) {
      expect(validateMcpServerName(ok)).toBeUndefined();
    }
  });

  it('refuses names that would put an invalid or ambiguous name on the wire', () => {
    for (const bad of ['acme.docs', 'my server', '-lead', 'a__b', 'tail_', 'x'.repeat(41), '']) {
      expect(validateMcpServerName(bad)).toBeTypeOf('string');
    }
  });
});
