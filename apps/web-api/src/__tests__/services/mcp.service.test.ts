import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { type McpInstallFlow, McpJsonStore, type McpManager } from '@ethosagent/tools-mcp';
import { describe, expect, it, vi } from 'vitest';
import { McpService } from '../../services/mcp.service';

// Narrowly scoped — the only behavior under test is that McpService.start
// threads its second argument (the per-request redirect URI derived from
// the web request's Origin) through to the underlying McpInstallFlow.start
// call. Full happy-path / error-path coverage of the install flow lives in
// extensions/tools-mcp/src/__tests__/install-flow.test.ts.

describe('McpService.start — redirectUri thread-through', () => {
  function makeServiceWithSpy() {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const mcpJsonStore = new McpJsonStore(storage);
    const mcpManager: McpManager = {
      connect: async () => {},
      disconnect: async () => {},
      shutdown: async () => {},
      getTools: () => [],
      listServers: () => [],
      addServer: async () => {},
      removeServer: async () => {},
    } as unknown as McpManager;
    const personalityUpdater = {
      get: () => undefined,
      update: async () => undefined,
    };

    const service = new McpService({
      mcpManager,
      personalityUpdater,
      secrets,
      mcpJsonStore,
      redirectUri: 'http://default.fallback/oauth/callback',
    });

    // Reach in and stub the private `flow` so we can observe the args
    // passed to `start()`. Replacing the field directly avoids the cost
    // of mocking discovery + DCR fetch calls — the test is about the
    // thread-through wiring, not the flow's own behavior.
    const flowStart = vi.fn(async () => ({
      state: 'STATE',
      authorizeUrl: 'https://auth.example/authorize',
      serverName: 'example',
      expiresAt: new Date(),
    }));
    (service as unknown as { flow: Pick<McpInstallFlow, 'start'> }).flow = {
      start: flowStart as unknown as McpInstallFlow['start'],
    };

    return { service, flowStart };
  }

  it('passes the per-call redirectUri to flow.start when supplied', async () => {
    const { service, flowStart } = makeServiceWithSpy();

    const result = await service.start(
      { url: 'https://mcp.example/sse', name: 'example' },
      'http://192.168.1.10:5173/oauth/callback',
    );

    expect(result.ok).toBe(true);
    expect(flowStart).toHaveBeenCalledTimes(1);
    const args = flowStart.mock.calls[0] as unknown[] | undefined;
    expect(args?.[0]).toEqual({
      mcpUrl: 'https://mcp.example/sse',
      name: 'example',
      redirectUri: 'http://192.168.1.10:5173/oauth/callback',
    });
  });

  it('omits redirectUri from the call when none is supplied (constructor default applies)', async () => {
    const { service, flowStart } = makeServiceWithSpy();

    const result = await service.start({ url: 'https://mcp.example/sse' });

    expect(result.ok).toBe(true);
    expect(flowStart).toHaveBeenCalledTimes(1);
    const args = flowStart.mock.calls[0] as unknown[] | undefined;
    const arg = args?.[0] as Record<string, unknown> | undefined;
    expect(arg?.mcpUrl).toBe('https://mcp.example/sse');
    expect(arg).not.toHaveProperty('redirectUri');
    expect(arg).not.toHaveProperty('name');
  });
});

describe('McpService.serverTools — per-server tool discovery', () => {
  function makeService(getToolsForPersonality: McpManager['getToolsForPersonality']): McpService {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const mcpJsonStore = new McpJsonStore(storage);
    const mcpManager: McpManager = {
      connect: async () => {},
      disconnect: async () => {},
      shutdown: async () => {},
      getTools: () => [],
      getToolsForPersonality,
      listServers: () => [],
      addServer: async () => {},
      removeServer: async () => {},
    } as unknown as McpManager;
    return new McpService({
      mcpManager,
      personalityUpdater: { get: () => undefined, update: async () => undefined },
      secrets,
      mcpJsonStore,
      redirectUri: 'http://default.fallback/oauth/callback',
    });
  }

  // Minimal Tool-shaped object — only `name` and `description` are read.
  function tool(name: string, description?: string) {
    return { name, description } as unknown as Awaited<
      ReturnType<McpManager['getToolsForPersonality']>
    >[number];
  }

  it('strips the mcp__<server>__ prefix and returns only the named server', async () => {
    const service = makeService(async () => [
      tool('mcp__linear__list_issues', 'List issues'),
      tool('mcp__linear__get_issue', 'Get an issue'),
      tool('mcp__slack__search_public', 'Search'),
    ]);

    const result = await service.serverTools({ personalityId: 'p1', serverName: 'linear' });

    expect(result.available).toBe(true);
    expect(result.tools).toEqual([
      { name: 'list_issues', description: 'List issues' },
      { name: 'get_issue', description: 'Get an issue' },
    ]);
  });

  it('omits a description equal to the bare tool name', async () => {
    const service = makeService(async () => [tool('mcp__linear__list_issues', 'list_issues')]);
    const result = await service.serverTools({ personalityId: 'p1', serverName: 'linear' });
    expect(result.tools).toEqual([{ name: 'list_issues' }]);
  });

  it('returns available:false with no tools when the server exposed nothing', async () => {
    const service = makeService(async () => [tool('mcp__other__x')]);
    const result = await service.serverTools({ personalityId: 'p1', serverName: 'linear' });
    expect(result.available).toBe(false);
    expect(result.tools).toEqual([]);
  });

  it('returns available:false when discovery throws (server unreachable)', async () => {
    const service = makeService(async () => {
      throw new Error('connect failed');
    });
    const result = await service.serverTools({ personalityId: 'p1', serverName: 'linear' });
    expect(result.available).toBe(false);
    expect(result.tools).toEqual([]);
  });
});
