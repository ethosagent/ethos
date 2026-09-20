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

// Sentinel "scope" for methods that live in a mapped namespace but must NOT be
// reachable via an API key (bearer) at all. These mutate personality config,
// and the `ApiKeyScope` enum deliberately has no `personalities:write` — such
// methods are cookie-only (the web UI). Mapping them here (rather than omitting
// them) keeps the drift test's subset invariant honest: EVERY router method in
// a mapped namespace has an explicit entry, and the gate below fails closed for
// every bearer key that resolves to this sentinel.
export const COOKIE_ONLY = 'cookie-only';

// Sentinel "scope" for a method reachable by ANY authenticated bearer key,
// with no scope check at all (mobile-app plan S12). `meta.whoami` is the only
// member — it reads nothing but the caller's own key row, so a key with zero
// scopes can still call it. The gate below treats this as "authenticated is
// enough"; the drift test's value assertion accepts it beside `COOKIE_ONLY`.
export const ANY_KEY = 'any-key';

// Deliberately UNMAPPED namespaces fail closed for bearer keys (the
// "experimental" branch in `dualAuth`). `outbox` (Part 2) and `learning`
// (Part 4, L-T8) are left out on purpose: approving a publication, or a
// learned change that rewrites a skill or an Expression, is a human decision
// made in the web UI, never something an API key can do.
export const SCOPE_MAP: Record<string, Record<string, string>> = {
  sessions: {
    list: 'sessions:read',
    get: 'sessions:read',
    messages: 'sessions:read',
    fork: 'sessions:write',
    delete: 'sessions:write',
    update: 'sessions:write',
    export: 'sessions:read',
    pin: 'sessions:write',
    unpin: 'sessions:write',
    contextAnatomy: 'sessions:read',
    compact: 'sessions:write',
  },
  chat: { send: 'chat:send', abort: 'chat:send', steer: 'chat:send' },
  personalities: {
    list: 'personalities:read',
    get: 'personalities:read',
    characterSheet: 'personalities:read',
    renderers: 'personalities:read',
    skillsList: 'personalities:read',
    skillsGet: 'personalities:read',
    livingSoul: 'personalities:read',
    // M-T9 — the MCP export section. Bearer-reachable, which is why its output
    // carries key prefixes and never a secret (`McpExportViewSchema`).
    mcpExport: 'personalities:read',
    skillCandidatesList: 'personalities:read',
    // Mutating / config-writing methods — cookie-only (no bearer scope grants them).
    create: COOKIE_ONLY,
    update: COOKIE_ONLY,
    delete: COOKIE_ONLY,
    duplicate: COOKIE_ONLY,
    skillsCreate: COOKIE_ONLY,
    skillsUpdate: COOKIE_ONLY,
    skillsDelete: COOKIE_ONLY,
    skillsImportGlobal: COOKIE_ONLY,
    mcpSetToken: COOKIE_ONLY,
    mcpDeleteToken: COOKIE_ONLY,
    proposeExpression: COOKIE_ONLY,
    applyExpression: COOKIE_ONLY,
    revertExpression: COOKIE_ONLY,
    proposeSoulSplit: COOKIE_ONLY,
    skillCandidateApprove: COOKIE_ONLY,
    skillCandidateReject: COOKIE_ONLY,
  },
  memory: {
    list: 'memory:read',
    get: 'memory:read',
    write: 'memory:write',
    listUsers: 'memory:read',
    history: 'memory:read',
    historyBlob: 'memory:read',
    restore: 'memory:write',
    pendingList: 'memory:read',
    pendingApprove: 'memory:write',
    pendingReject: 'memory:write',
  },
  tools: {
    approve: 'tools:approve',
    deny: 'tools:approve',
    catalog: 'tools:approve',
    detail: 'tools:approve',
    // `test` can really EXECUTE a tool (read-only ones, per the capability
    // gate in `services/tool-inspection`). An API key is not a licence to make
    // this deployment run things — cookie-only.
    test: COOKIE_ONLY,
    // The foreground catch-up (S3) — same scope as `approve`/`deny`, since it
    // reads exactly what those methods act on.
    listPending: 'tools:approve',
  },
  // Activity tab data (mobile-app S1) — history and the live SSE feed share
  // one scope.
  activity: {
    history: 'activity:read',
  },
  // Reuse, not add (mobile-app S1): answering the agent's question is a
  // steer, so it takes the same scope as `chat.steer`; the foreground
  // catch-up read is a session read.
  clarify: {
    respond: 'chat:send',
    listPending: 'sessions:read',
  },
  // Reuse, not add (mobile-app S1): background job rows are per-session, so
  // list/get are session reads; cancel is the same trust as `chat.abort`.
  tasks: {
    list: 'sessions:read',
    get: 'sessions:read',
    cancel: 'chat:send',
  },
  // Meta (mobile-app S12, S13(b)). `capabilities` is the coarse
  // "what's installed" read; `whoami` is reachable by any authenticated key
  // (it only reads the caller's own row); `connectInfo` names the URL a
  // phone should scan and is cookie-only — a bearer caller has no business
  // asking the server where it lives.
  meta: {
    capabilities: 'library:read',
    whoami: ANY_KEY,
    connectInfo: COOKIE_ONLY,
  },
};

// SSE feeds are keyed by the first path segment after `/sse/`, not by an RPC
// method — `/sse/sessions/<id>` normalizes to `sessions.<id>`, which has no
// SCOPE_MAP entry. This table replaces the old single `isSseSessionStream`
// special case (mobile-app plan S2) so every feed gets the same treatment;
// anything else FORBIDDEN as today (the "experimental" branch below).
export const SSE_SCOPES: Record<string, string> = {
  sessions: 'sessions:read',
  activity: 'activity:read',
  system: 'events:subscribe',
  kanban: 'kanban:read',
  goals: 'library:read',
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
    if (record.allowedOrigins.length > 0) {
      if (!origin) {
        throw new EthosError({
          code: 'FORBIDDEN',
          cause: 'This API key requires an Origin header but none was provided.',
          action:
            'Include the Origin header in your request, or remove allowedOrigins from the key.',
        });
      }
      if (!record.allowedOrigins.includes(origin)) {
        throw new EthosError({
          code: 'FORBIDDEN',
          cause: `Origin "${origin}" is not in the allowedOrigins list for this API key.`,
          action: "Add this origin to the key's allowedOrigins, or use the correct key.",
        });
      }
    }

    // oRPC URL paths use `/` (e.g. `/rpc/sessions/list`), but the SCOPE_MAP
    // and `resolveScope` are keyed on dot notation (`sessions.list`).
    // Normalize before lookup so the scope + experimental gate fire on the
    // namespace, not on the whole "sessions/list" string.
    const rpcPath = c.req.path
      .replace(/^\/rpc\//, '')
      .replace(/^\/sse\//, '')
      .replace(/\//g, '.')
      .replace(/[./]+$/, '');

    // Defense-in-depth: apiKeys namespace is always cookie-only
    if (rpcPath.startsWith('apiKeys')) {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: 'The apiKeys namespace requires cookie authentication.',
        action: 'Use the Ethos web UI to manage API keys.',
      });
    }

    // SSE feeds: keyed on the first path segment after `/sse/`, not on an
    // RPC method (SSE_SCOPES table above). An unknown feed falls through to
    // the same "experimental" refusal every unmapped RPC namespace gets.
    const isSse = c.req.path.startsWith('/sse/');
    let requiredScope: string | null;
    if (isSse) {
      const feed = c.req.path.slice('/sse/'.length).split('/')[0] ?? '';
      requiredScope = SSE_SCOPES[feed] ?? null;
      if (requiredScope === null) {
        throw new EthosError({
          code: 'FORBIDDEN',
          cause: `Feed "${feed}" is experimental and not accessible via API key.`,
          action: 'Use cookie auth (the Ethos web UI) for experimental feeds.',
        });
      }
    } else {
      requiredScope = opts.scopeForPath(rpcPath);
    }

    if (requiredScope === COOKIE_ONLY) {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: `Method "${rpcPath}" requires cookie authentication and is not accessible via API key.`,
        action: 'Use cookie auth (the Ethos web UI) for this method.',
      });
    }
    if (requiredScope === ANY_KEY) {
      // Authenticated is enough — no scope check.
    } else if (requiredScope) {
      if (!record.scopes.includes(requiredScope)) {
        throw new EthosError({
          code: 'FORBIDDEN',
          cause: `API key is missing required scope "${requiredScope}".`,
          action: `Create a key with the "${requiredScope}" scope.`,
        });
      }
    } else if (!isSse) {
      // No scope resolved. FAIL CLOSED (WEB-001): a known namespace with an
      // unmapped method previously fell through with NO scope enforced. Now it
      // is rejected — mapping a new method is a conscious decision, not an
      // accidental open door. Experimental (unmapped) namespaces keep their
      // dedicated message.
      const dotIdx = rpcPath.indexOf('.');
      const ns = dotIdx > 0 ? rpcPath.slice(0, dotIdx) : rpcPath;
      if (SCOPE_MAP[ns]) {
        throw new EthosError({
          code: 'FORBIDDEN',
          cause: `Method "${rpcPath}" is not mapped to a scope and is not accessible via API key.`,
          action: 'Use cookie auth (the Ethos web UI), or map this method to a scope.',
        });
      }
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: `Namespace "${ns}" is experimental and not accessible via API key.`,
        action: 'Use cookie auth (the Ethos web UI) for experimental namespaces.',
      });
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
