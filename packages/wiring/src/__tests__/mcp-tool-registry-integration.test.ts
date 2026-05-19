// Phase A.5 — C-NEW-2 regression: when `McpManager.addServer` runs against a
// real `DefaultToolRegistry` wired via the `onToolsChanged` callback (the
// same wiring the CLI uses at boot, see packages/wiring/src/index.ts), the
// new tools become visible to the agent loop on its next turn through
// `registry.getAvailable()` / `registry.toDefinitions()`. removeServer is
// symmetric.
//
// This test lives in `@ethosagent/wiring` rather than `@ethosagent/tools-mcp`
// because `tools-mcp` is an extension and cannot import `DefaultToolRegistry`
// from `@ethosagent/core` without inverting the layer model.

import { DefaultToolRegistry } from '@ethosagent/core';
import type { McpServerConfig } from '@ethosagent/tools-mcp';
import { type McpClient, McpManager } from '@ethosagent/tools-mcp';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

async function spawnEchoServer(toolName: string) {
  const server = new Server(
    { name: `test-${toolName}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: toolName,
        description: `Echo via ${toolName}`,
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

class StubTransportManager extends McpManager {
  private readonly transports = new Map<string, InstanceType<typeof InMemoryTransport>>();
  setTransport(name: string, transport: InstanceType<typeof InMemoryTransport>): void {
    this.transports.set(name, transport);
  }
  protected override _buildClient(config: McpServerConfig): McpClient {
    const real = super._buildClient(config);
    const transport = this.transports.get(config.name);
    if (transport) {
      // biome-ignore lint/suspicious/noExplicitAny: test seam
      (real as any)._createTransport = async () => transport;
    }
    return real;
  }
}

describe('McpManager + DefaultToolRegistry integration', () => {
  it('addServer makes MCP tools visible via registry.getAvailable()', async () => {
    const clientTransport = await spawnEchoServer('alpha');
    const registry = new DefaultToolRegistry();
    const mgr = new StubTransportManager([], {
      onToolsChanged: (added, removedNames) => {
        for (const t of added) registry.register(t);
        for (const n of removedNames) registry.unregister(n);
      },
    });
    mgr.setTransport('srv', clientTransport);

    expect(registry.getAvailable()).toHaveLength(0);

    await mgr.addServer({
      name: 'srv',
      transport: 'stdio',
      command: 'unused',
      keepaliveSeconds: 0,
    });

    const names = registry.getAvailable().map((t) => t.name);
    expect(names).toEqual(['mcp__srv__alpha']);

    await mgr.removeServer('srv');
    expect(registry.getAvailable()).toHaveLength(0);
  });
});
