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
