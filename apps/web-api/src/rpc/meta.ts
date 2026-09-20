import type { ApiKeyScope } from '@ethosagent/web-contracts';
import { computeCoreCapabilities } from '../services/capabilities';
import { resolveConnectInfo } from './connect-info';
import { os } from './context';

interface WhoamiApiKey {
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsed: Date | null;
}

// `whoami` (mobile-app plan S12) is reachable by ANY authenticated bearer
// key (the `ANY_KEY` sentinel in `dual-auth.ts`'s SCOPE_MAP) — it reads only
// the caller's own key row. `_authMethod`/`_apiKey` are threaded into the RPC
// context the same way `rpc/kanban.ts` and `rpc/tools.ts` already read them
// (S9); not declared on `RpcContext` itself, so read via the same inline cast.
function readAuth(context: unknown): {
  authMethod: 'bearer' | 'cookie';
  apiKey?: WhoamiApiKey;
} {
  const c = context as { _authMethod?: unknown; _apiKey?: WhoamiApiKey };
  return {
    authMethod: c._authMethod === 'bearer' ? 'bearer' : 'cookie',
    apiKey: c._apiKey,
  };
}

export const metaRouter = {
  capabilities: os.meta.capabilities.handler(async ({ context }) => {
    const capabilities = await computeCoreCapabilities({
      voice: context.voice,
      config: context.config,
    });
    return { capabilities };
  }),

  whoami: os.meta.whoami.handler(async ({ context }) => {
    const { authMethod, apiKey } = readAuth(context);
    const version = context.version;
    if (authMethod === 'bearer' && apiKey) {
      return {
        authMethod: 'bearer' as const,
        ...(version ? { version } : {}),
        key: {
          name: apiKey.name,
          prefix: apiKey.prefix,
          scopes: apiKey.scopes as ApiKeyScope[],
          createdAt: apiKey.createdAt.toISOString(),
          lastUsed: apiKey.lastUsed?.toISOString() ?? null,
        },
      };
    }
    return { authMethod: 'cookie' as const, ...(version ? { version } : {}) };
  }),

  // Cookie-only (`SCOPE_MAP.meta.connectInfo === COOKIE_ONLY`); the gate
  // refuses every bearer request before this handler runs.
  connectInfo: os.meta.connectInfo.handler(async ({ context }) => {
    const cfg = await context.config.get();
    return resolveConnectInfo({
      env: process.env,
      configWebBaseUrl: cfg.webBaseUrl,
      webHost: context.webHost ?? '127.0.0.1',
      webPort: context.webPort ?? 3000,
    });
  }),
};
