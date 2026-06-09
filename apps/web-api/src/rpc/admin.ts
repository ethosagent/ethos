import { os } from './context';

export const adminRouter = {
  getStatus: os.admin.getStatus.handler(async ({ context }) => {
    // Gather channel status from platforms service
    type Channel = {
      id: string;
      platform: string;
      status: 'connected' | 'disconnected' | 'error';
      webhookUrl?: string;
    };
    let channels: Channel[] = [];
    try {
      const result = await context.platforms.list();
      channels = result.platforms.map((p) => ({
        id: p.id,
        platform: p.id,
        status: (p.configured ? 'connected' : 'disconnected') as 'connected' | 'disconnected',
      }));
    } catch {
      // platforms service may not be available
    }

    // Gather provider status from config service
    type Provider = {
      id: string;
      name: string;
      hasKey: boolean;
      healthy?: boolean;
      latencyMs?: number;
    };
    let providers: Provider[] = [];
    try {
      const cfg = await context.config.get();
      providers = cfg.providers.map((p) => ({
        id: p.provider,
        name: p.provider,
        hasKey: Boolean(p.apiKeyPreview),
      }));
    } catch {
      // config service may not be available
    }

    // Gather MCP server status from plugins service
    type McpServer = {
      name: string;
      status: 'connected' | 'disconnected' | 'error';
      toolCount?: number;
    };
    let mcpServers: McpServer[] = [];
    try {
      const result = await context.plugins.list();
      mcpServers = result.mcpServers.map((s) => ({
        name: s.name,
        status: (s.auth_status === 'authorized' ? 'connected' : 'disconnected') as
          | 'connected'
          | 'disconnected',
      }));
    } catch {
      // plugins service may not be available
    }

    return { channels, providers, mcpServers };
  }),

  rotateKey: os.admin.rotateKey.handler(async ({ input, context }) => {
    await context.config.update({
      providers: [{ provider: input.provider, apiKey: input.key }],
    });
    return { ok: true as const };
  }),

  checkProvider: os.admin.checkProvider.handler(async ({ input, context }) => {
    const start = Date.now();
    try {
      await context.onboarding.validateProvider({
        provider: input.provider as
          | 'anthropic'
          | 'openai'
          | 'openrouter'
          | 'openai-compat'
          | 'ollama'
          | 'azure'
          | 'codex',
        apiKey: '',
      });
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }),

  addMcpServer: os.admin.addMcpServer.handler(async () => {
    // Placeholder — full MCP server management uses the mcp namespace
    return { ok: true as const };
  }),

  removeMcpServer: os.admin.removeMcpServer.handler(async () => {
    // Placeholder — full MCP server management uses the mcp namespace
    return { ok: true as const };
  }),
};
