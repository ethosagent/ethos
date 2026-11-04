import { DefaultToolRegistry } from '@ethosagent/core';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { McpJsonStore, type McpManager, type McpServerConfig } from '@ethosagent/tools-mcp';
import type { Tool } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { McpService } from '../mcp.service';

// connectPreset (plan keyless-first-run §5.2, §5.3, D24): a no-sign-in preset
// is written to mcp.json, added to the RUNNING manager, and granted to ONE
// user-owned personality. The fake manager mirrors McpManager.addServer's
// contract (throws on a duplicate, fires onToolsChanged once per add) and a
// real DefaultToolRegistry stands in for the loop's registry.

function mcpTool(server: string, name: string): Tool {
  return {
    name: DefaultToolRegistry.mcpToolName(server, name),
    description: name,
    schema: { type: 'object' },
    toolset: 'mcp',
    capabilities: {},
    execute: async () => ({ ok: true, value: 'ok' }),
  };
}

function makeHarness(
  opts: {
    builtin?: string[];
    connectFails?: boolean;
    personalities?: Record<string, string[]>;
  } = {},
) {
  const storage = new InMemoryStorage();
  const mcpJsonStore = new McpJsonStore(storage);
  const registry = new DefaultToolRegistry();

  const servers = new Map<string, McpServerConfig>();
  const addServer = vi.fn(async (config: McpServerConfig) => {
    if (servers.has(config.name)) {
      throw new Error(`MCP server '${config.name}' is already registered`);
    }
    if (opts.connectFails) throw new Error('connect ECONNREFUSED');
    servers.set(config.name, config);
    // McpManager.addServer fires onToolsChanged exactly once per add; the
    // loop wires that to ToolRegistry.register (compose-tools.ts).
    for (const t of [mcpTool(config.name, 'ask'), mcpTool(config.name, 'read')]) {
      registry.register(t);
    }
  });
  const mcpManager = {
    addServer,
    listServers: () => [...servers.keys()].map((name) => ({ name, transport: 'streamable-http' })),
    getTools: () => registry.getAvailable(),
  } as unknown as McpManager;

  const personalities = new Map<string, string[]>(
    Object.entries(opts.personalities ?? { sage: [], other: ['linear'] }),
  );
  const update = vi.fn(async (id: string, patch: { mcp_servers?: string[] }) => {
    personalities.set(id, patch.mcp_servers ?? []);
  });
  const personalityUpdater = {
    get: (id: string) => {
      const mcp_servers = personalities.get(id);
      return mcp_servers ? { id, mcp_servers } : undefined;
    },
    update,
  };

  const service = new McpService({
    mcpManager,
    personalityUpdater,
    secrets: new InMemorySecretsResolver(),
    mcpJsonStore,
    redirectUri: 'http://localhost/oauth/callback',
    isBuiltinPersonality: (id) => (opts.builtin ?? ['researcher']).includes(id),
  });
  personalities.set('researcher', []);
  return { service, mcpJsonStore, addServer, update, personalities, registry };
}

describe('McpService.connectPreset', () => {
  it('a no-auth preset is written to mcp.json, added to the running manager, and attached to that one personality', async () => {
    const h = makeHarness();

    const out = await h.service.connectPreset({ presetName: 'deepwiki', personalityId: 'sage' });

    expect(out).toEqual({ ok: true, serverName: 'deepwiki', toolCount: 2 });
    const stored = await h.mcpJsonStore.get('deepwiki');
    expect(stored).toMatchObject({
      name: 'deepwiki',
      transport: 'streamable-http',
      created_via: 'ui',
    });
    expect(stored?.url).toMatch(/^https:\/\//);
    expect(h.addServer).toHaveBeenCalledTimes(1);
    expect(h.personalities.get('sage')).toEqual(['deepwiki']);
  });

  it("another personality's allowlist is unchanged", async () => {
    const h = makeHarness();
    await h.service.connectPreset({ presetName: 'deepwiki', personalityId: 'sage' });
    expect(h.personalities.get('other')).toEqual(['linear']);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith('sage', { mcp_servers: ['deepwiki'] });
  });

  it('an oauth preset is refused with code oauth_required, and nothing is written', async () => {
    const h = makeHarness();
    const out = await h.service.connectPreset({ presetName: 'linear', personalityId: 'sage' });
    expect(out).toMatchObject({ ok: false, code: 'oauth_required' });
    expect(h.addServer).not.toHaveBeenCalled();
    expect(await h.mcpJsonStore.get('linear')).toBeNull();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('an unknown preset is refused with not_found', async () => {
    const h = makeHarness();
    const out = await h.service.connectPreset({ presetName: 'nope', personalityId: 'sage' });
    expect(out).toMatchObject({ ok: false, code: 'not_found' });
    expect(h.addServer).not.toHaveBeenCalled();
  });

  it('an unknown personality is refused with not_found', async () => {
    const h = makeHarness();
    const out = await h.service.connectPreset({ presetName: 'deepwiki', personalityId: 'ghost' });
    expect(out).toMatchObject({ ok: false, code: 'not_found' });
    expect(h.addServer).not.toHaveBeenCalled();
  });

  it('a built-in personality is refused with read_only before anything is written', async () => {
    const h = makeHarness();
    const out = await h.service.connectPreset({
      presetName: 'deepwiki',
      personalityId: 'researcher',
    });
    expect(out).toMatchObject({ ok: false, code: 'read_only' });
    expect(h.addServer).not.toHaveBeenCalled();
    expect(await h.mcpJsonStore.get('deepwiki')).toBeNull();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('a second call is a no-op (no duplicate addServer throw, no duplicate mcp_servers entry)', async () => {
    const h = makeHarness();
    const first = await h.service.connectPreset({ presetName: 'deepwiki', personalityId: 'sage' });
    const second = await h.service.connectPreset({ presetName: 'deepwiki', personalityId: 'sage' });
    expect(second).toEqual(first);
    expect(h.addServer).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.personalities.get('sage')).toEqual(['deepwiki']);
    expect((await h.mcpJsonStore.read()).filter((c) => c.name === 'deepwiki')).toHaveLength(1);
  });

  it('a retry converges after a partial failure (mcp.json written, manager lacks it)', async () => {
    const h = makeHarness();
    await h.mcpJsonStore.upsert('deepwiki', {
      name: 'deepwiki',
      transport: 'streamable-http',
      url: 'https://mcp.deepwiki.com/mcp',
    });
    const out = await h.service.connectPreset({ presetName: 'deepwiki', personalityId: 'sage' });
    expect(out).toMatchObject({ ok: true, serverName: 'deepwiki' });
    expect(h.addServer).toHaveBeenCalledTimes(1);
    expect(h.personalities.get('sage')).toEqual(['deepwiki']);
  });

  it('a connect failure → connect_failed, with no grant and no dead mcp.json entry', async () => {
    const h = makeHarness({ connectFails: true });
    const out = await h.service.connectPreset({ presetName: 'deepwiki', personalityId: 'sage' });
    expect(out).toMatchObject({ ok: false, code: 'connect_failed' });
    expect(h.update).not.toHaveBeenCalled();
    expect(await h.mcpJsonStore.get('deepwiki')).toBeNull();
  });

  it("onToolsChanged registers the preset's tools without a restart", async () => {
    const h = makeHarness();
    expect(h.registry.get('mcp__deepwiki__ask')).toBeUndefined();

    await h.service.connectPreset({ presetName: 'deepwiki', personalityId: 'sage' });

    expect(h.registry.get('mcp__deepwiki__ask')).toBeDefined();
    // Default-deny per personality (ARCHITECTURE.md S1): the granted personality
    // sees the tools, a personality without the grant does not.
    const granted = h.registry.toDefinitions(undefined, { allowedMcpServers: ['deepwiki'] });
    const other = h.registry.toDefinitions(undefined, { allowedMcpServers: ['linear'] });
    expect(granted.map((d) => d.name)).toContain('mcp__deepwiki__ask');
    expect(other.map((d) => d.name)).not.toContain('mcp__deepwiki__ask');
  });
});
