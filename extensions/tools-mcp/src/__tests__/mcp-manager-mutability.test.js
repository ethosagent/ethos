// Phase A.5 — McpManager.addServer / removeServer / listServers under
// concurrency, with the onToolsChanged callback that wires runtime tool
// deltas into a consumer's ToolRegistry.
//
// The "registry visibility" regression (C-NEW-2) lives in the wiring package
// (`packages/wiring/src/__tests__/mcp-tool-registry-integration.test.ts`)
// because `@ethosagent/tools-mcp` is a downstream extension and cannot
// import `DefaultToolRegistry` from `@ethosagent/core` without inverting the
// layer model. Here we cover the callback contract with a minimal stub.
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
 * McpManager subclass that maps server names to pre-paired in-memory
 * transports. `addServer` invocations use the registered transport. An
 * unmapped name builds a real client (which will fail to connect — used to
 * test the all-or-nothing path).
 */
class TestableManager extends McpManager {
    // Initialized lazily because field initializers run AFTER super(), but
    // super() (the McpManager constructor) itself calls _buildClient — which
    // dispatches to this subclass. So `this.transports` would be undefined the
    // first time through. Lazy init dodges that.
    _transports;
    /** If set, the NEXT addServer's connect call rejects with this error. */
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
        // Wire the standard callbacks the real McpManager wires (onToolsChanged
        // for tools/list_changed, etc.) by going through the parent _buildClient
        // — but then swap the transport.
        const real = super._buildClient(config);
        const transport = this.transports.get(config.name);
        if (!transport) {
            // No transport registered — return as-is. Caller can hook a `failNext`
            // by overriding _createTransport via private field swap; for the
            // failure tests we set `failNext` instead.
            if (this.failNext) {
                const err = this.failNext;
                // biome-ignore lint/suspicious/noExplicitAny: test seam
                real._createTransport = async () => {
                    throw err;
                };
            }
            return real;
        }
        // Splice in the in-memory transport. Preserve the parent class's
        // callback wiring (onToolsChanged) — that's why we call super first
        // and only override _createTransport here.
        // biome-ignore lint/suspicious/noExplicitAny: test seam
        real._createTransport = async () => transport;
        return real;
    }
}
function makeStdioConfig(name, keepaliveSeconds = 0) {
    return { name, transport: 'stdio', command: 'unused', keepaliveSeconds };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('McpManager.addServer', () => {
    it('connects, exposes new tools via getTools, and invokes onToolsChanged once', async () => {
        const { clientTransport } = await spawnEchoServer('alpha');
        const onToolsChanged = vi.fn();
        const mgr = new TestableManager([], { onToolsChanged });
        mgr.setTransport('srv', clientTransport);
        await mgr.addServer(makeStdioConfig('srv'));
        expect(mgr.getTools().map((t) => t.name)).toEqual(['mcp__srv__alpha']);
        expect(onToolsChanged).toHaveBeenCalledTimes(1);
        const [added, removed] = onToolsChanged.mock.calls[0] ?? [[], []];
        expect(added.map((t) => t.name)).toEqual(['mcp__srv__alpha']);
        expect(removed).toEqual([]);
        await mgr.disconnect();
    });
    it('all-or-nothing — connect failure leaves _clients and _tools unchanged, callback NOT called', async () => {
        const onToolsChanged = vi.fn();
        const mgr = new TestableManager([], { onToolsChanged });
        mgr.failNext = new Error('boom');
        const before = mgr.getTools();
        const beforeServers = mgr.listServers();
        await expect(mgr.addServer(makeStdioConfig('srv'))).rejects.toThrow('boom');
        expect(mgr.getTools()).toBe(before);
        expect(mgr.listServers()).toEqual(beforeServers);
        expect(onToolsChanged).not.toHaveBeenCalled();
    });
    it('serializes concurrent addServer calls — both servers land, callback called twice with disjoint sets', async () => {
        const { clientTransport: tA } = await spawnEchoServer('alphaTool');
        const { clientTransport: tB } = await spawnEchoServer('betaTool');
        const onToolsChanged = vi.fn();
        const mgr = new TestableManager([], { onToolsChanged });
        mgr.setTransport('a', tA);
        mgr.setTransport('b', tB);
        await Promise.all([mgr.addServer(makeStdioConfig('a')), mgr.addServer(makeStdioConfig('b'))]);
        const toolNames = mgr
            .getTools()
            .map((t) => t.name)
            .sort();
        expect(toolNames).toEqual(['mcp__a__alphaTool', 'mcp__b__betaTool']);
        expect(onToolsChanged).toHaveBeenCalledTimes(2);
        const allAdded = [];
        for (const call of onToolsChanged.mock.calls) {
            const added = call[0];
            const removed = call[1];
            expect(removed).toEqual([]);
            expect(added).toHaveLength(1);
            const first = added[0];
            if (first)
                allAdded.push(first.name);
        }
        expect(allAdded.sort()).toEqual(['mcp__a__alphaTool', 'mcp__b__betaTool']);
        await mgr.disconnect();
    });
    it('getTools racing addServer never returns a partial array', async () => {
        const { clientTransport: tA } = await spawnEchoServer('alphaTool');
        const { clientTransport: tB } = await spawnEchoServer('betaTool');
        const mgr = new TestableManager([], {});
        mgr.setTransport('a', tA);
        mgr.setTransport('b', tB);
        // Reader: poll getTools 200 times while two addServer calls race.
        let reads = 0;
        const reader = (async () => {
            while (reads < 200) {
                const snap = mgr.getTools();
                // Valid snapshots: empty, {a}, {b}, or {a,b}. No half-array states.
                const names = snap.map((t) => t.name).sort();
                const ok = names.length === 0 ||
                    (names.length === 1 &&
                        (names[0] === 'mcp__a__alphaTool' || names[0] === 'mcp__b__betaTool')) ||
                    (names.length === 2 &&
                        names[0] === 'mcp__a__alphaTool' &&
                        names[1] === 'mcp__b__betaTool');
                expect(ok).toBe(true);
                reads++;
                await Promise.resolve();
            }
        })();
        await Promise.all([
            mgr.addServer(makeStdioConfig('a')),
            mgr.addServer(makeStdioConfig('b')),
            reader,
        ]);
        expect(reads).toBeGreaterThanOrEqual(200);
        await mgr.disconnect();
    });
});
describe('McpManager.removeServer', () => {
    it('disconnects, removes tools, invokes onToolsChanged with the right names', async () => {
        const { clientTransport } = await spawnEchoServer('alpha');
        const onToolsChanged = vi.fn();
        const mgr = new TestableManager([], { onToolsChanged });
        mgr.setTransport('srv', clientTransport);
        await mgr.addServer(makeStdioConfig('srv'));
        onToolsChanged.mockClear();
        await mgr.removeServer('srv');
        expect(mgr.getTools()).toEqual([]);
        expect(mgr.listServers()).toEqual([]);
        expect(onToolsChanged).toHaveBeenCalledTimes(1);
        expect(onToolsChanged).toHaveBeenCalledWith([], ['mcp__srv__alpha']);
    });
    it('throws NOT_FOUND for an unknown name', async () => {
        const mgr = new TestableManager([], {});
        await expect(mgr.removeServer('missing')).rejects.toMatchObject({
            name: 'EthosError',
            code: 'NOT_FOUND',
        });
    });
});
describe('McpManager.listServers', () => {
    it('returns a fresh array each call', async () => {
        const { clientTransport } = await spawnEchoServer('alpha');
        const mgr = new TestableManager([], {});
        mgr.setTransport('srv', clientTransport);
        await mgr.addServer(makeStdioConfig('srv'));
        const first = mgr.listServers();
        const second = mgr.listServers();
        expect(first).not.toBe(second);
        // Mutating one snapshot doesn't affect internal state
        first.push({ name: 'forged', transport: 'stdio' });
        expect(mgr.listServers()).toHaveLength(1);
        await mgr.disconnect();
    });
    it('returns name + transport + command (stdio) for an added server', async () => {
        const { clientTransport } = await spawnEchoServer('alpha');
        const mgr = new TestableManager([], {});
        mgr.setTransport('srv', clientTransport);
        await mgr.addServer({
            name: 'srv',
            transport: 'stdio',
            command: 'unused',
            keepaliveSeconds: 0,
        });
        const list = mgr.listServers();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ name: 'srv', transport: 'stdio', command: 'unused' });
        await mgr.disconnect();
    });
});
describe('McpManager — boot-flow regression', () => {
    it('boot-time getTools() + tools.register() still works alongside the callback', async () => {
        // Simulate the wiring path: constructor with one initial config, plus a
        // post-boot addServer that goes through the callback.
        const { clientTransport: tBoot } = await spawnEchoServer('bootTool');
        const { clientTransport: tAdded } = await spawnEchoServer('addedTool');
        const onToolsChanged = vi.fn();
        class BootManager extends TestableManager {
            // biome-ignore lint/suspicious/noExplicitAny: test seam
            _buildClient(config) {
                // For boot-time configs, splice in the boot transport.
                const real = super._buildClient(config);
                if (config.name === 'boot') {
                    // biome-ignore lint/suspicious/noExplicitAny: test seam
                    real._createTransport = async () => tBoot;
                }
                return real;
            }
        }
        const mgr = new BootManager([makeStdioConfig('boot')], { onToolsChanged });
        mgr.setTransport('extra', tAdded);
        await mgr.connect();
        // Boot tools are exposed via getTools() — the wiring loop calls
        // `tools.register(...)` for these. The callback is NOT called for them.
        const bootTools = mgr.getTools().map((t) => t.name);
        expect(bootTools).toEqual(['mcp__boot__bootTool']);
        expect(onToolsChanged).not.toHaveBeenCalled();
        // Post-boot addServer DOES fire the callback.
        await mgr.addServer(makeStdioConfig('extra'));
        expect(onToolsChanged).toHaveBeenCalledTimes(1);
        await mgr.disconnect();
    });
});
describe('McpManager.addServer → consumer registry callback contract', () => {
    // The registry-visibility regression (C-NEW-2) lives in
    // packages/wiring/src/__tests__/mcp-tool-registry-integration.test.ts
    // because tools-mcp can't depend on @ethosagent/core. This test pins the
    // contract from the McpManager side: a stub registry sees register() and
    // unregister() calls in lockstep with the callback.
    it('register/unregister calls track addServer/removeServer one-for-one', async () => {
        const { clientTransport } = await spawnEchoServer('alpha');
        const registered = new Map();
        const mgr = new TestableManager([], {
            onToolsChanged: (added, removedNames) => {
                for (const t of added)
                    registered.set(t.name, t);
                for (const n of removedNames)
                    registered.delete(n);
            },
        });
        mgr.setTransport('srv', clientTransport);
        expect(registered.size).toBe(0);
        await mgr.addServer(makeStdioConfig('srv'));
        expect([...registered.keys()]).toEqual(['mcp__srv__alpha']);
        await mgr.removeServer('srv');
        expect(registered.size).toBe(0);
    });
});
