import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { McpManager } from '../index';
async function spawnEchoServer(toolName) {
    const server = new Server({ name: `test-${toolName}`, version: '1.0.0' }, { capabilities: { tools: {} } });
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
/**
 * TestableManager — maps server names to pre-paired in-memory transports.
 * Mirrors the pattern from mcp-manager-mutability.test.ts.
 */
class TestableManager extends McpManager {
    _transports;
    failNext;
    get transports() {
        if (!this._transports)
            this._transports = new Map();
        return this._transports;
    }
    setTransport(name, transport) {
        this.transports.set(name, transport);
    }
    _buildClient(config) {
        const real = super._buildClient(config);
        const transport = this.transports.get(config.name);
        if (!transport) {
            if (this.failNext) {
                const err = this.failNext;
                // biome-ignore lint/suspicious/noExplicitAny: test seam
                real._createTransport = async () => {
                    throw err;
                };
            }
            return real;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test seam
        real._createTransport = async () => transport;
        return real;
    }
}
function makeStdioConfig(name, keepaliveSeconds = 0) {
    return { name, transport: 'stdio', command: 'unused', keepaliveSeconds };
}
function makeInMemorySecrets() {
    const stored = new Map();
    return {
        stored,
        async get(ref) {
            return stored.get(ref) ?? null;
        },
        async set(ref, value) {
            stored.set(ref, value);
        },
        async delete(ref) {
            stored.delete(ref);
        },
        async list(prefix) {
            return [...stored.keys()].filter((k) => (prefix ? k.startsWith(prefix) : true));
        },
    };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('McpManager.renameServer', () => {
    it('renames a server and updates tools prefix', async () => {
        const { clientTransport: tOld } = await spawnEchoServer('alpha');
        const { clientTransport: tNew } = await spawnEchoServer('alpha');
        const onToolsChanged = vi.fn();
        const mgr = new TestableManager([], { onToolsChanged });
        mgr.setTransport('old-name', tOld);
        mgr.setTransport('new-name', tNew);
        await mgr.addServer(makeStdioConfig('old-name'));
        expect(mgr.getTools().map((t) => t.name)).toEqual(['mcp__old-name__alpha']);
        onToolsChanged.mockClear();
        await mgr.renameServer('old-name', 'new-name');
        const tools = mgr.getTools();
        expect(tools.map((t) => t.name)).toEqual(['mcp__new-name__alpha']);
        const servers = mgr.listServers();
        expect(servers).toHaveLength(1);
        expect(servers[0]?.name).toBe('new-name');
        // onToolsChanged should have been called with the renamed tools
        expect(onToolsChanged).toHaveBeenCalledTimes(1);
    });
    it('throws NOT_FOUND for unknown server', async () => {
        const mgr = new TestableManager([], {});
        await expect(mgr.renameServer('nonexistent', 'new-name')).rejects.toMatchObject({
            name: 'EthosError',
            code: 'NOT_FOUND',
        });
    });
    it('throws when newName is already taken', async () => {
        const { clientTransport: tA } = await spawnEchoServer('toolA');
        const { clientTransport: tB } = await spawnEchoServer('toolB');
        const mgr = new TestableManager([], {});
        mgr.setTransport('server-a', tA);
        mgr.setTransport('server-b', tB);
        await mgr.addServer(makeStdioConfig('server-a'));
        await mgr.addServer(makeStdioConfig('server-b'));
        await expect(mgr.renameServer('server-a', 'server-b')).rejects.toThrow("MCP server 'server-b' is already registered");
        await mgr.disconnect();
    });
});
describe('McpManager.updateToken', () => {
    it('stores the token and attempts reconnect', async () => {
        const { clientTransport } = await spawnEchoServer('alpha');
        const { clientTransport: tReconnect } = await spawnEchoServer('alpha');
        const secrets = makeInMemorySecrets();
        const mgr = new TestableManager([], { secrets });
        mgr.setTransport('srv', clientTransport);
        await mgr.addServer(makeStdioConfig('srv'));
        // Register a new transport for the reconnect
        mgr.setTransport('srv', tReconnect);
        await mgr.updateToken('srv', 'sk-new-token');
        // Verify token was stored
        const storedToken = await secrets.get('mcp/srv/access_token');
        expect(storedToken).toBe('sk-new-token');
        await mgr.disconnect();
    });
    it('throws NOT_FOUND for unknown server', async () => {
        const secrets = makeInMemorySecrets();
        const mgr = new TestableManager([], { secrets });
        await expect(mgr.updateToken('nonexistent', 'token')).rejects.toMatchObject({
            name: 'EthosError',
            code: 'NOT_FOUND',
        });
    });
    it('throws when no secrets resolver is configured', async () => {
        const { clientTransport } = await spawnEchoServer('alpha');
        const mgr = new TestableManager([], {});
        mgr.setTransport('srv', clientTransport);
        await mgr.addServer(makeStdioConfig('srv'));
        await expect(mgr.updateToken('srv', 'token')).rejects.toThrow('No secrets resolver configured');
        await mgr.disconnect();
    });
});
