import type { Tool } from '@ethosagent/types';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../index';
import { McpClient, McpManager } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestServer(
  tools: { name: string; description: string }[] = [
    { name: 'echo', description: 'Echoes the message' },
  ],
) {
  const server = new Server(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: {} },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return { content: [{ type: 'text' as const, text: `called: ${req.params.name}` }] };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport, server };
}

class TestMcpClient extends McpClient {
  private _inMemoryTransport: InstanceType<typeof InMemoryTransport>;

  constructor(transport: InstanceType<typeof InMemoryTransport>, name = 'test') {
    super({ name, transport: 'stdio', command: 'unused', keepaliveSeconds: 0 });
    this._inMemoryTransport = transport;
  }

  // biome-ignore lint/suspicious/noExplicitAny: override for test
  protected override async _createTransport(): Promise<any> {
    return this._inMemoryTransport;
  }
}

/** A failing client that rejects on connect. */
class FailingMcpClient extends McpClient {
  constructor(name: string) {
    super({ name, transport: 'stdio', command: 'unused', keepaliveSeconds: 0 });
  }

  // biome-ignore lint/suspicious/noExplicitAny: override for test
  protected override async _createTransport(): Promise<any> {
    throw new Error('connect failed');
  }
}

type ClientFactory = (config: McpServerConfig) => McpClient;

function makeTestManager(
  configs: McpServerConfig[],
  factory: ClientFactory,
  opts?: ConstructorParameters<typeof McpManager>[1],
): McpManager {
  class Mgr extends McpManager {
    protected override _buildClient(config: McpServerConfig): McpClient {
      return factory(config);
    }
  }
  return new Mgr(configs, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpManager mutation methods', () => {
  // -------------------------------------------------------------------------
  // addServer
  // -------------------------------------------------------------------------

  it('addServer adds a new server and tools appear in getTools()', async () => {
    const { clientTransport } = await createTestServer([
      { name: 'greet', description: 'Says hello' },
    ]);

    const manager = makeTestManager([], (config) => {
      return new TestMcpClient(clientTransport, config.name);
    });
    await manager.connect();

    expect(manager.getTools()).toHaveLength(0);

    await manager.addServer({ name: 'dynamic', transport: 'stdio', command: 'unused' });

    const tools = manager.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('mcp__dynamic__greet');

    await manager.disconnect();
  });

  it('addServer fires onToolsChanged callback with added tools', async () => {
    const { clientTransport } = await createTestServer([
      { name: 'alpha', description: 'Tool alpha' },
      { name: 'beta', description: 'Tool beta' },
    ]);

    const onToolsChanged = vi.fn();

    const manager = makeTestManager(
      [],
      (config) => new TestMcpClient(clientTransport, config.name),
      { onToolsChanged },
    );
    await manager.connect();

    await manager.addServer({ name: 'srv', transport: 'stdio', command: 'unused' });

    expect(onToolsChanged).toHaveBeenCalledTimes(1);
    const [added, removed] = onToolsChanged.mock.calls[0] as [Tool[], string[]];
    expect(added).toHaveLength(2);
    expect(added.map((t) => t.name)).toContain('mcp__srv__alpha');
    expect(added.map((t) => t.name)).toContain('mcp__srv__beta');
    expect(removed).toHaveLength(0);

    await manager.disconnect();
  });

  // -------------------------------------------------------------------------
  // removeServer
  // -------------------------------------------------------------------------

  it('removeServer removes server and tools disappear from getTools()', async () => {
    const { clientTransport } = await createTestServer([{ name: 'tool1', description: 'Tool 1' }]);

    const manager = makeTestManager(
      [{ name: 'initial', transport: 'stdio', command: 'unused' }],
      (config) => new TestMcpClient(clientTransport, config.name),
    );
    await manager.connect();

    expect(manager.getTools()).toHaveLength(1);
    expect(manager.getTools()[0]?.name).toBe('mcp__initial__tool1');

    await manager.removeServer('initial');

    expect(manager.getTools()).toHaveLength(0);

    await manager.disconnect();
  });

  it('removeServer fires onToolsChanged callback with removed tool names', async () => {
    const { clientTransport } = await createTestServer([
      { name: 'tool_a', description: 'A' },
      { name: 'tool_b', description: 'B' },
    ]);

    const onToolsChanged = vi.fn();

    const manager = makeTestManager(
      [{ name: 'srv', transport: 'stdio', command: 'unused' }],
      (config) => new TestMcpClient(clientTransport, config.name),
      { onToolsChanged },
    );
    await manager.connect();

    await manager.removeServer('srv');

    expect(onToolsChanged).toHaveBeenCalledTimes(1);
    const [added, removed] = onToolsChanged.mock.calls[0] as [Tool[], string[]];
    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(2);
    expect(removed).toContain('mcp__srv__tool_a');
    expect(removed).toContain('mcp__srv__tool_b');

    await manager.disconnect();
  });

  // -------------------------------------------------------------------------
  // Duplicate name
  // -------------------------------------------------------------------------

  it('addServer with duplicate name throws', async () => {
    const { clientTransport } = await createTestServer();

    const manager = makeTestManager(
      [{ name: 'dup', transport: 'stdio', command: 'unused' }],
      (config) => new TestMcpClient(clientTransport, config.name),
    );
    await manager.connect();

    await expect(
      manager.addServer({ name: 'dup', transport: 'stdio', command: 'unused' }),
    ).rejects.toThrow("MCP server 'dup' is already registered");

    await manager.disconnect();
  });

  // -------------------------------------------------------------------------
  // Unknown name
  // -------------------------------------------------------------------------

  it('removeServer with unknown name throws', async () => {
    const manager = makeTestManager([], () => {
      throw new Error('should not be called');
    });
    await manager.connect();

    await expect(manager.removeServer('nonexistent')).rejects.toThrow(
      "MCP server 'nonexistent' is not registered",
    );

    await manager.disconnect();
  });

  // -------------------------------------------------------------------------
  // Connect failure
  // -------------------------------------------------------------------------

  it('addServer connect failure does NOT add client or invoke callback', async () => {
    const onToolsChanged = vi.fn();

    const manager = makeTestManager([], (config) => new FailingMcpClient(config.name), {
      onToolsChanged,
    });
    await manager.connect();

    await expect(
      manager.addServer({ name: 'broken', transport: 'stdio', command: 'unused' }),
    ).rejects.toThrow('connect failed');

    expect(manager.getTools()).toHaveLength(0);
    expect(onToolsChanged).not.toHaveBeenCalled();

    await manager.disconnect();
  });

  // -------------------------------------------------------------------------
  // Concurrent mutations serialize correctly
  // -------------------------------------------------------------------------

  it('concurrent addServer/removeServer serialize correctly', async () => {
    const serverA = await createTestServer([{ name: 'tool_from_a', description: 'From A' }]);
    const serverB = await createTestServer([{ name: 'tool_from_b', description: 'From B' }]);

    const transports = new Map<string, InstanceType<typeof InMemoryTransport>>([
      ['server_a', serverA.clientTransport],
      ['server_b', serverB.clientTransport],
    ]);

    const manager = makeTestManager([], (config) => {
      const transport = transports.get(config.name);
      if (!transport) throw new Error(`No transport for ${config.name}`);
      return new TestMcpClient(transport, config.name);
    });
    await manager.connect();

    // Fire both mutations concurrently
    const [resultA, resultB] = await Promise.allSettled([
      manager.addServer({ name: 'server_a', transport: 'stdio', command: 'unused' }),
      manager.addServer({ name: 'server_b', transport: 'stdio', command: 'unused' }),
    ]);

    expect(resultA.status).toBe('fulfilled');
    expect(resultB.status).toBe('fulfilled');

    const tools = manager.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain('mcp__server_a__tool_from_a');
    expect(tools.map((t) => t.name)).toContain('mcp__server_b__tool_from_b');

    // Now remove one while adding state is settled
    await manager.removeServer('server_a');

    const remaining = manager.getTools();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe('mcp__server_b__tool_from_b');

    // Fire remove and add concurrently
    const serverC = await createTestServer([{ name: 'tool_from_c', description: 'From C' }]);
    transports.set('server_c', serverC.clientTransport);

    const [removeResult, addResult] = await Promise.allSettled([
      manager.removeServer('server_b'),
      manager.addServer({ name: 'server_c', transport: 'stdio', command: 'unused' }),
    ]);

    expect(removeResult.status).toBe('fulfilled');
    expect(addResult.status).toBe('fulfilled');

    const finalTools = manager.getTools();
    expect(finalTools).toHaveLength(1);
    expect(finalTools[0]?.name).toBe('mcp__server_c__tool_from_c');

    await manager.disconnect();
  });

  // -------------------------------------------------------------------------
  // listServers
  // -------------------------------------------------------------------------

  it('listServers returns a snapshot of connected servers', async () => {
    const { clientTransport } = await createTestServer();

    const manager = makeTestManager(
      [{ name: 'srv1', transport: 'stdio', command: 'node' }],
      (config) => new TestMcpClient(clientTransport, config.name),
    );
    await manager.connect();

    const servers = manager.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe('srv1');
    expect(servers[0]?.transport).toBe('stdio');
    // `connected` is no longer part of McpServerInfo (HEAD); auth_status and
    // created_via are populated by the surface that has token visibility.

    await manager.disconnect();
  });
});
