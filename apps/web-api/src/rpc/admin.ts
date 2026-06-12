import { adminTestSend, gatherAdminStatus, requireAdmin } from '../services/admin.service';
import { os } from './context';

// Every admin procedure is gated by `requireAdmin` — `admin.enabled: true`
// in ~/.ethos/config.yaml (default false). Disabled → FORBIDDEN, which the
// rpc interceptor renders as HTTP 403.

export const adminRouter = {
  getStatus: os.admin.getStatus.handler(async ({ context }) => {
    await requireAdmin(context.config);
    return gatherAdminStatus(context);
  }),

  rotateKey: os.admin.rotateKey.handler(async ({ input, context }) => {
    await requireAdmin(context.config);
    await context.config.update({
      providers: [{ provider: input.provider, apiKey: input.key }],
    });
    return { ok: true as const };
  }),

  checkProvider: os.admin.checkProvider.handler(async ({ input, context }) => {
    await requireAdmin(context.config);
    const creds = await context.config.resolveProviderCredentials(input.provider);
    if (!creds) return { ok: false, latencyMs: 0 };
    const start = Date.now();
    try {
      const result = await context.onboarding.validateProvider({
        provider: input.provider as
          | 'anthropic'
          | 'openai'
          | 'openrouter'
          | 'openai-compat'
          | 'ollama'
          | 'azure'
          | 'codex',
        apiKey: creds.apiKey,
        ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
      });
      return { ok: result.ok, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }),

  testSend: os.admin.testSend.handler(async ({ input, context }) => {
    await requireAdmin(context.config);
    return adminTestSend(context.platforms, input.channel);
  }),

  addMcpServer: os.admin.addMcpServer.handler(async ({ input, context }) => {
    await requireAdmin(context.config);
    const result = await context.mcp.addServer({
      name: input.name,
      transport: 'streamable-http',
      url: input.url,
      authType: input.authType === 'bearer' ? 'bearer' : 'none',
    });
    if ('ok' in result && result.ok === false) {
      throw new Error(result.detail ?? 'Failed to add MCP server');
    }
    return { ok: true as const };
  }),

  removeMcpServer: os.admin.removeMcpServer.handler(async ({ input, context }) => {
    await requireAdmin(context.config);
    await context.mcp.delete({ name: input.name });
    return { ok: true as const };
  }),
};
