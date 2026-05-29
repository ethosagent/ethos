// Phase B — per-personality MCP connections.
//
// Verifies that McpManager.getToolsForPersonality() creates isolated
// McpClient instances for OAuth servers (per-personality token storage)
// while sharing a single client for stdio servers across personalities.
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { McpManager } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function spawnEchoServer(toolName) {
  const server = new Server(
    { name: `test-${toolName}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: toolName,
        description: `Echoes via ${toolName}`,
        inputSchema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const msg = req.params.arguments?.msg ?? '';
    return { content: [{ type: 'text', text: String(msg) }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport };
}
/** Creates a fresh in-memory transport pair, connecting only the server side. */
async function spawnFreshEchoServer(toolName) {
  return spawnEchoServer(toolName);
}
/**
 * Testable McpManager that intercepts both `_buildClient` and
 * `_buildClientWithSecrets` to inject in-memory transports. Tracks which
 * clients were built with which secrets resolver for assertion purposes.
 */
class PersonalityTestManager extends McpManager {
  // All fields use lazy init because field initializers run AFTER super(),
  // but super() (McpManager constructor) calls _buildClient which dispatches
  // to this subclass.
  _transports;
  _secretsLog;
  _clientLog;
  _connectCount = 0;
  get transports() {
    if (!this._transports) this._transports = new Map();
    return this._transports;
  }
  get secretsLog() {
    if (!this._secretsLog) this._secretsLog = [];
    return this._secretsLog;
  }
  get clientLog() {
    if (!this._clientLog) this._clientLog = new Map();
    return this._clientLog;
  }
  /** Register a transport factory so each call gets a fresh linked pair. */
  setTransportFactory(name, factory) {
    this.transports.set(name, factory);
  }
  /** Register a single transport (reused for all calls to the same server). */
  setTransport(name, transport) {
    this.transports.set(name, async () => ({ clientTransport: transport }));
  }
  get connectCount() {
    return this._connectCount;
  }
  _buildClient(config) {
    const real = super._buildClient(config);
    const factory = this.transports.get(config.name);
    if (factory) {
      real._createTransport = async () => {
        const { clientTransport } = await factory();
        this._connectCount++;
        return clientTransport;
      };
    }
    const label = `stdio::${config.name}`;
    this.clientLog.set(label, real);
    return real;
  }
  _buildClientWithSecrets(config, secrets) {
    this.secretsLog.push({ configName: config.name, secrets });
    const real = super._buildClientWithSecrets(config, secrets);
    const factory = this.transports.get(config.name);
    if (factory) {
      real._createTransport = async () => {
        const { clientTransport } = await factory();
        this._connectCount++;
        return clientTransport;
      };
    }
    // Label by the secrets identity for later differentiation
    const label = `oauth::${config.name}::${this.secretsLog.length}`;
    this.clientLog.set(label, real);
    return real;
  }
}
function makeStdioConfig(name) {
  return { name, transport: 'stdio', command: 'unused', keepaliveSeconds: 0 };
}
function makeHttpConfig(name) {
  return { name, transport: 'streamable-http', url: 'http://localhost:9999', keepaliveSeconds: 0 };
}
function makeSseConfig(name) {
  return { name, transport: 'sse', url: 'http://localhost:9999', keepaliveSeconds: 0 };
}
function noopSecrets() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('McpManager.getToolsForPersonality', () => {
  it('creates two distinct clients for the same OAuth server when called with different personalities', async () => {
    const configs = [makeHttpConfig('oauth-srv')];
    const inner = noopSecrets();
    const mgr = new PersonalityTestManager(configs, { innerSecrets: inner });
    // Each personality call needs its own transport pair.
    mgr.setTransportFactory('oauth-srv', () => spawnFreshEchoServer('alpha'));
    const toolsA = await mgr.getToolsForPersonality('personalityA');
    const toolsB = await mgr.getToolsForPersonality('personalityB');
    // Both should get the same tool names but from different clients.
    expect(toolsA.map((t) => t.name)).toEqual(['mcp__oauth-srv__alpha']);
    expect(toolsB.map((t) => t.name)).toEqual(['mcp__oauth-srv__alpha']);
    // Two distinct _buildClientWithSecrets calls with different scoped secrets.
    expect(mgr.secretsLog).toHaveLength(2);
    expect(mgr.secretsLog[0]?.secrets).not.toBe(mgr.secretsLog[1]?.secrets);
    await mgr.disconnect();
  });
  it('lazy connect — no connection until getToolsForPersonality is called; second call reuses cached client', async () => {
    const configs = [makeHttpConfig('oauth-srv')];
    const inner = noopSecrets();
    const mgr = new PersonalityTestManager(configs, { innerSecrets: inner });
    mgr.setTransportFactory('oauth-srv', () => spawnFreshEchoServer('alpha'));
    // No connections yet — only the constructor ran.
    expect(mgr.connectCount).toBe(0);
    const tools1 = await mgr.getToolsForPersonality('pA');
    expect(mgr.connectCount).toBe(1);
    expect(tools1).toHaveLength(1);
    // Second call with the same personality reuses the cached client.
    const tools2 = await mgr.getToolsForPersonality('pA');
    // Connect count should NOT increase — cached client is reused.
    expect(mgr.connectCount).toBe(1);
    expect(tools2).toHaveLength(1);
    await mgr.disconnect();
  });
  it('stdio server is shared across personalities — one client instance reused', async () => {
    const configs = [makeStdioConfig('stdio-srv')];
    const mgr = new PersonalityTestManager(configs, {});
    mgr.setTransportFactory('stdio-srv', () => spawnFreshEchoServer('beta'));
    const toolsA = await mgr.getToolsForPersonality('pA');
    expect(toolsA.map((t) => t.name)).toEqual(['mcp__stdio-srv__beta']);
    const toolsB = await mgr.getToolsForPersonality('pB');
    expect(toolsB.map((t) => t.name)).toEqual(['mcp__stdio-srv__beta']);
    // Only one connection was made — shared across personalities.
    expect(mgr.connectCount).toBe(1);
    // No _buildClientWithSecrets calls for stdio.
    expect(mgr.secretsLog).toHaveLength(0);
    await mgr.disconnect();
  });
  it('mixed stdio + OAuth configs — stdio shared, OAuth per-personality', async () => {
    const configs = [makeStdioConfig('stdio-srv'), makeHttpConfig('oauth-srv')];
    const inner = noopSecrets();
    const mgr = new PersonalityTestManager(configs, { innerSecrets: inner });
    mgr.setTransportFactory('stdio-srv', () => spawnFreshEchoServer('stdioTool'));
    mgr.setTransportFactory('oauth-srv', () => spawnFreshEchoServer('oauthTool'));
    const toolsA = await mgr.getToolsForPersonality('pA');
    const toolNames = toolsA.map((t) => t.name).sort();
    expect(toolNames).toEqual(['mcp__oauth-srv__oauthTool', 'mcp__stdio-srv__stdioTool']);
    const toolsB = await mgr.getToolsForPersonality('pB');
    const toolNamesB = toolsB.map((t) => t.name).sort();
    expect(toolNamesB).toEqual(['mcp__oauth-srv__oauthTool', 'mcp__stdio-srv__stdioTool']);
    // stdio: 1 connect. OAuth: 2 connects (one per personality).
    expect(mgr.connectCount).toBe(3);
    // OAuth: 2 _buildClientWithSecrets calls.
    expect(mgr.secretsLog).toHaveLength(2);
    await mgr.disconnect();
  });
  it('SSE transport is treated as OAuth — per-personality isolation', async () => {
    const configs = [makeSseConfig('sse-srv')];
    const inner = noopSecrets();
    const mgr = new PersonalityTestManager(configs, { innerSecrets: inner });
    mgr.setTransportFactory('sse-srv', () => spawnFreshEchoServer('sseTool'));
    await mgr.getToolsForPersonality('pA');
    await mgr.getToolsForPersonality('pB');
    // Two distinct clients — SSE uses per-personality isolation.
    expect(mgr.secretsLog).toHaveLength(2);
    expect(mgr.connectCount).toBe(2);
    await mgr.disconnect();
  });
});
describe('McpManager — backward compat (connect + getTools)', () => {
  it('existing connect() + getTools() still works for single-personality path', async () => {
    const { clientTransport } = await spawnEchoServer('bootTool');
    // Subclass that injects the in-memory transport at _buildClient time
    // (during construction), mirroring the pattern from mcp-manager-mutability.test.ts.
    class BootManager extends McpManager {
      _buildClient(config) {
        const real = super._buildClient(config);
        real._createTransport = async () => clientTransport;
        return real;
      }
    }
    const mgr = new BootManager([makeStdioConfig('boot-srv')], {});
    await mgr.connect();
    const tools = mgr.getTools();
    expect(tools.map((t) => t.name)).toEqual(['mcp__boot-srv__bootTool']);
    await mgr.disconnect();
  });
});
describe('McpManager — _configs stays in sync with _clients', () => {
  it('addServer: getToolsForPersonality includes tools from a runtime-added server', async () => {
    // Start with one stdio server.
    const configs = [makeStdioConfig('initial-srv')];
    const inner = noopSecrets();
    const mgr = new PersonalityTestManager(configs, { innerSecrets: inner });
    mgr.setTransportFactory('initial-srv', () => spawnFreshEchoServer('initTool'));
    // Verify initial server works via getToolsForPersonality.
    const toolsBefore = await mgr.getToolsForPersonality('pA');
    expect(toolsBefore.map((t) => t.name)).toContain('mcp__initial-srv__initTool');
    // Now add a new server at runtime.
    const newConfig = makeStdioConfig('added-srv');
    mgr.setTransportFactory('added-srv', () => spawnFreshEchoServer('addedTool'));
    await mgr.addServer(newConfig);
    // getToolsForPersonality must see the newly added server's tools.
    const toolsAfter = await mgr.getToolsForPersonality('pA');
    const toolNames = toolsAfter.map((t) => t.name).sort();
    expect(toolNames).toContain('mcp__added-srv__addedTool');
    expect(toolNames).toContain('mcp__initial-srv__initTool');
    await mgr.disconnect();
  });
  it('removeServer: getToolsForPersonality no longer reconnects a removed server', async () => {
    // Start with two servers.
    const configs = [makeStdioConfig('keep-srv'), makeStdioConfig('remove-srv')];
    const inner = noopSecrets();
    const mgr = new PersonalityTestManager(configs, { innerSecrets: inner });
    mgr.setTransportFactory('keep-srv', () => spawnFreshEchoServer('keepTool'));
    mgr.setTransportFactory('remove-srv', () => spawnFreshEchoServer('removeTool'));
    // Both servers visible initially.
    const toolsBefore = await mgr.getToolsForPersonality('pA');
    const namesBefore = toolsBefore.map((t) => t.name).sort();
    expect(namesBefore).toContain('mcp__keep-srv__keepTool');
    expect(namesBefore).toContain('mcp__remove-srv__removeTool');
    // Remove one server.
    await mgr.removeServer('remove-srv');
    // getToolsForPersonality must NOT include the removed server's tools,
    // and must NOT attempt to reconnect it.
    const toolsAfter = await mgr.getToolsForPersonality('pA');
    const namesAfter = toolsAfter.map((t) => t.name);
    expect(namesAfter).toContain('mcp__keep-srv__keepTool');
    expect(namesAfter).not.toContain('mcp__remove-srv__removeTool');
    await mgr.disconnect();
  });
});
