import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from '../middleware/auth';
import type { ApiKeyAuthStore } from '../middleware/bearer-auth';
import { csrfMiddleware } from '../middleware/csrf';
import { cookieOnlyGuard, dualAuth, resolveScope } from '../middleware/dual-auth';
import { errorHandler } from '../middleware/error-envelope';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import type { WebTokenRepository } from '../repositories/web-token.repository';
import type { ChatService } from '../services/chat.service';
import type { SessionsService } from '../services/sessions.service';
import { authRoutes } from './auth';
import { openAiRoutes } from './openai';
import { openapiRoutes } from './openapi';
import { mcpRpcPath, rpcRoutes } from './rpc';
import { setupWhatsAppRoutes } from './setup-whatsapp';
import { sseRoutes } from './sse';
import { staticRoutes } from './static';
import { systemSseRoutes } from './system-sse';

// Single place where all sub-routers attach to a Hono app, with the auth +
// CSRF + error-envelope wiring. `createWebApi` calls this and returns the
// resulting app — boot code (`apps/ethos/src/commands/serve.ts`, future) is
// the only thing that actually `serve()`s it.

export interface CreateRoutesOptions {
  tokens: WebTokenRepository;
  services: ServiceContainer;
  /** Bearer-token store for the OpenAI-compat surface. When omitted, `/v1/*`
   *  is not mounted (deployments without the API need no api_keys table). */
  apiKeys?: ApiKeyAuthStore;
  /** Returns currently registered team names for `/v1/models`. */
  listTeams?: () => Promise<string[]>;
  /** Explicit allow-list of origins for cross-origin CSRF check. Empty / unset
   *  means "localhost only". */
  allowedOrigins?: string[];
  /** Set the `secure` flag on the auth cookie. Off by default for localhost. */
  secureCookie?: boolean;
  /** Absolute path to the built `apps/web/dist`. When set, the SPA is
   *  served at `/*` with a fallback to `index.html` for client-side
   *  routes. Omit during dev — Vite's :5173 dev server proxies API calls
   *  to this Hono app instead. */
  webDist?: string;
  /** Configured public base URL of the web UI — used as an allowlist
   *  anchor when deriving the MCP OAuth redirect URI from inbound
   *  requests. Loopback + RFC 1918 origins are always trusted; anything
   *  else must match this. */
  webBaseUrl?: string;
  /** Storage abstraction for reading ~/.ethos/ files (gateway heartbeat). */
  storage?: Storage;
}

export interface ServiceContainer {
  sessions: SessionsService;
  chat: ChatService;
  personalities: import('../services/personalities.service').PersonalitiesService;
  config: import('../services/config.service').ConfigService;
  onboarding: import('../services/onboarding.service').OnboardingService;
  approvals: import('../services/approvals.service').ApprovalsService;
  /** Bridge backing the `clarify` tool — undefined when the loop has none. */
  clarifyBridge?: import('@ethosagent/core').ClarifyBridge;
  cron: import('../services/cron.service').CronService;
  skills: import('../services/skills.service').SkillsService;
  evolver: import('../services/evolver.service').EvolverService;
  mesh: import('../services/mesh.service').MeshService;
  memory: import('../services/memory.service').MemoryService;
  plugins: import('../services/plugins.service').PluginsService;
  mcp: import('../services/mcp.service').McpService;
  platforms: import('../services/platforms.service').PlatformsService;
  lab: import('../services/lab.service').LabService;
  kanban: import('../services/kanban.service').KanbanService;
  completions: import('../services/completions.service').CompletionsService;
  apiKeys: import('../services/api-keys.service').ApiKeysService;
  toolRegistry?: import('@ethosagent/types').ToolRegistry;
  systemBus?: import('../services/system-event-bus').SystemEventBus;
}

export function createRoutes(opts: CreateRoutesOptions): Hono {
  const app = new Hono();

  // Unauthenticated health-check for container probes (liveness / readiness).
  // Registered before any middleware so it never requires auth or CORS.
  // Reads the gateway heartbeat file written by the gateway process to surface
  // adapter health alongside the serve process's own uptime.
  app.get('/healthz', async (c) => {
    const uptime = process.uptime();
    const healthPath = join(homedir(), '.ethos', 'gateway-health.json');

    let gatewayBlock: {
      status: 'ok' | 'down' | 'stale';
      adapters: Array<{ name: string; ok: boolean }>;
      lastHeartbeatAgeSec: number | null;
    };

    try {
      const raw = opts.storage ? await opts.storage.read(healthPath) : null;
      if (!raw) throw new Error('no storage or file missing');
      const hb = JSON.parse(raw) as {
        updatedAt: string;
        adapters: Array<{ name: string; ok: boolean }>;
      };
      const ageSec = (Date.now() - new Date(hb.updatedAt).getTime()) / 1000;
      const stale = !Number.isFinite(ageSec) || ageSec > 30;
      gatewayBlock = {
        status: stale ? 'stale' : 'ok',
        adapters: hb.adapters,
        lastHeartbeatAgeSec: Math.round(ageSec),
      };
    } catch {
      // File missing or unparseable — gateway is not running.
      gatewayBlock = { status: 'down', adapters: [], lastHeartbeatAgeSec: null };
    }

    const allAdaptersOk =
      gatewayBlock.adapters.length > 0 && gatewayBlock.adapters.every((a) => a.ok);
    const healthy = gatewayBlock.status === 'ok' && allAdaptersOk;
    const status = healthy ? 'ok' : 'degraded';

    return c.json({ status, uptime, gateway: gatewayBlock }, healthy ? 200 : 503);
  });

  // Last-resort error catcher. Routes that throw EthosError land here.
  app.onError(errorHandler);

  // CORS preflight + Access-Control-Allow-Origin headers. The browser needs
  // these BEFORE any RPC/SSE call from a different origin will succeed —
  // the Mission Control template on :3001 calling the API on :3000 is the
  // canonical case. Origin policy matches the CSRF default: explicit
  // `allowedOrigins` if set, otherwise any localhost host:port for dev.
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return null; // same-origin / non-browser request
        const explicit = opts.allowedOrigins ?? [];
        if (explicit.includes(origin)) return origin;
        try {
          const host = new URL(origin).hostname;
          if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return origin;
        } catch {
          /* malformed origin header — fall through */
        }
        return null;
      },
      credentials: true,
      allowMethods: ['GET', 'POST', 'OPTIONS', 'DELETE', 'PATCH'],
      allowHeaders: ['Authorization', 'Content-Type'],
    }),
  );

  // Auth exchange is unauthenticated by definition — it's how cookies get set.
  // Mounted BEFORE the auth middleware below.
  app.route(
    '/auth',
    authRoutes({ tokens: opts.tokens, ...(opts.secureCookie ? { secureCookie: true } : {}) }),
  );

  // RPC + SSE auth: dual-auth (cookie OR bearer) when an api-key store
  // is wired; cookie-only otherwise (backward-compatible default).
  if (opts.apiKeys) {
    const dual = dualAuth({
      tokens: opts.tokens,
      apiKeys: opts.apiKeys,
      scopeForPath: resolveScope,
    });
    app.use('/rpc/*', dual);
    app.use('/sse/*', dual);
    // apiKeys namespace rejects bearer auth — cookie only.
    app.use('/rpc/apiKeys/*', cookieOnlyGuard());
  } else {
    app.use('/rpc/*', authMiddleware({ tokens: opts.tokens }));
    app.use('/sse/*', authMiddleware({ tokens: opts.tokens }));
  }

  // OpenAPI surface always requires cookie auth (browseable docs).
  app.use('/openapi/*', authMiddleware({ tokens: opts.tokens }));

  // Origin / CSRF check on state-changing methods. Localhost-default; pass an
  // explicit list when the server binds beyond localhost. Skipped for
  // bearer-auth requests — the API key is the auth, not a cookie.
  const csrf = csrfMiddleware(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {});
  app.use('/rpc/*', async (c, next) => {
    if (c.get('authMethod') === 'bearer') return next();
    return csrf(c, next);
  });
  app.use('/openapi/*', csrf);

  // Rate-limit mcp.start to prevent DCR registration spam
  const mcpStartRateLimit = rateLimitMiddleware();
  app.use(mcpRpcPath('start'), mcpStartRateLimit);

  app.route(
    '/rpc',
    rpcRoutes({
      services: opts.services,
      ...(opts.webBaseUrl ? { webBaseUrl: opts.webBaseUrl } : {}),
    }),
  );
  app.route('/sse', sseRoutes({ chat: opts.services.chat }));
  if (opts.services.systemBus) {
    app.route('/sse', systemSseRoutes({ systemBus: opts.services.systemBus }));
  }
  app.route('/openapi', openapiRoutes({ services: opts.services }));

  // OpenAI-compat surface (F1-F4). Self-contained bearer-token auth — does
  // NOT share the cookie middleware above. Only mounted when an api-key
  // store is wired so test/ACP-only deployments can opt out cleanly.
  if (opts.apiKeys) {
    app.route(
      '/v1',
      openAiRoutes({
        apiKeys: opts.apiKeys,
        personalities: opts.services.personalities,
        completions: opts.services.completions,
        ...(opts.listTeams ? { listTeams: opts.listTeams } : {}),
      }),
    );
  }

  // WhatsApp QR-pairing SSE stream. Gated behind auth — the QR string is
  // a live WhatsApp account-linking credential and must not be publicly
  // accessible. Must be before the static SPA mount (which owns `/*`).
  app.use('/setup/whatsapp/*', authMiddleware({ tokens: opts.tokens }));
  app.route('/setup/whatsapp', setupWhatsAppRoutes());

  // Static SPA mount (must be LAST — it owns `/*` so any unmatched path
  // falls through to index.html). Skipped when `webDist` isn't supplied;
  // dev users hit Vite at :5173 instead and the API runs without a
  // mounted client.
  if (opts.webDist) {
    app.route('/', staticRoutes({ dist: opts.webDist }));
  }

  return app;
}
