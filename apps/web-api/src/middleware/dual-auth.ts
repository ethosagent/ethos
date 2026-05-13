import { hashApiKey } from '@ethosagent/session-sqlite';
import { EthosError } from '@ethosagent/types';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { WebTokenRepository } from '../repositories/web-token.repository';
import type { ApiKeyAuthStore } from './bearer-auth';

// Dual-auth middleware for the `/rpc/*` and `/sse/*` surfaces. Accepts
// EITHER a cookie (existing single-origin path) OR a bearer token (new
// API-key path for external Mission Controls). Cookie is checked first;
// bearer is the fallback. On success, sets `c.set('authMethod')` so
// downstream guards (e.g. the apiKeys namespace cookie-only gate) can
// distinguish.

export type AuthMethod = 'cookie' | 'bearer';

export interface DualAuthOptions {
  tokens: WebTokenRepository;
  apiKeys: ApiKeyAuthStore;
  scopeForPath: (path: string) => string | null;
}

const AUTH_COOKIE = 'ethos_auth';
const BEARER_PREFIX = 'Bearer ';
const SECRET_PREFIX = 'sk-ethos-';
const TOUCH_THROTTLE_MS = 60_000;

const SCOPE_MAP: Record<string, Record<string, string>> = {
  sessions: {
    list: 'sessions:read',
    get: 'sessions:read',
    fork: 'sessions:write',
    delete: 'sessions:write',
    update: 'sessions:write',
  },
  chat: { send: 'chat:send', abort: 'chat:send' },
  personalities: {
    list: 'personalities:read',
    get: 'personalities:read',
    characterSheet: 'personalities:read',
  },
  memory: { list: 'memory:read', get: 'memory:read', write: 'memory:write' },
  tools: { approve: 'tools:approve', deny: 'tools:approve' },
};

export function resolveScope(rpcPath: string): string | null {
  const dotIdx = rpcPath.indexOf('.');
  if (dotIdx < 0) return null;
  const ns = rpcPath.slice(0, dotIdx);
  const method = rpcPath.slice(dotIdx + 1);
  const nsMap = SCOPE_MAP[ns];
  if (!nsMap) return null;
  return nsMap[method] ?? null;
}

export function dualAuth(opts: DualAuthOptions): MiddlewareHandler {
  const lastTouchAt = new Map<string, number>();

  return async (c, next) => {
    const cookie = getCookie(c, AUTH_COOKIE);
    if (cookie) {
      const ok = await opts.tokens.matches(cookie);
      if (ok) {
        c.set('authMethod', 'cookie' as AuthMethod);
        return next();
      }
    }

    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    if (!header) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'Missing authentication — provide a cookie or Authorization: Bearer header.',
        action: 'Visit the URL printed by `ethos serve` to sign in, or use an API key.',
      });
    }

    if (!header.startsWith(BEARER_PREFIX)) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'Authorization header must use the Bearer scheme.',
        action: 'Use `Authorization: Bearer sk-ethos-...`.',
      });
    }

    const secret = header.slice(BEARER_PREFIX.length).trim();
    if (!secret.startsWith(SECRET_PREFIX)) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'API key must start with `sk-ethos-`.',
        action: 'Create a key from the Ethos Settings page.',
      });
    }

    const record = await opts.apiKeys.findByHash(hashApiKey(secret));
    if (!record) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'API key is invalid or has been revoked.',
        action: 'Check the key, or mint a new one from the Settings page.',
      });
    }

    const origin = c.req.header('origin');
    if (origin && record.allowedOrigins.length > 0 && !record.allowedOrigins.includes(origin)) {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: `Origin "${origin}" is not in the allowedOrigins list for this API key.`,
        action: "Add this origin to the key's allowedOrigins, or use the correct key.",
      });
    }

    const rpcPath = c.req.path.replace(/^\/rpc\//, '').replace(/^\/sse\//, '');
    const requiredScope = opts.scopeForPath(rpcPath);
    if (requiredScope && !record.scopes.includes(requiredScope)) {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: `API key is missing required scope "${requiredScope}".`,
        action: `Create a key with the "${requiredScope}" scope.`,
      });
    }
    if (!requiredScope) {
      const dotIdx = rpcPath.indexOf('.');
      const ns = dotIdx > 0 ? rpcPath.slice(0, dotIdx) : rpcPath;
      if (ns !== 'apiKeys' && !SCOPE_MAP[ns]) {
        throw new EthosError({
          code: 'FORBIDDEN',
          cause: `Namespace "${ns}" is experimental and not accessible via API key.`,
          action: 'Use cookie auth (the Ethos web UI) for experimental namespaces.',
        });
      }
    }

    const now = Date.now();
    const previous = lastTouchAt.get(record.id) ?? 0;
    if (now - previous >= TOUCH_THROTTLE_MS) {
      lastTouchAt.set(record.id, now);
      try {
        await opts.apiKeys.touchLastUsed(record.id);
      } catch {
        // intentionally ignored
      }
    }

    c.set('apiKey', record);
    c.set('authMethod', 'bearer' as AuthMethod);
    await next();
  };
}

export function cookieOnlyGuard(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.get('authMethod') as AuthMethod | undefined;
    if (method === 'bearer') {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause:
          'This endpoint requires cookie authentication — bearer tokens cannot manage API keys.',
        action: 'Use the Ethos web UI to manage API keys.',
      });
    }
    return next();
  };
}

declare module 'hono' {
  interface ContextVariableMap {
    authMethod: AuthMethod;
  }
}
