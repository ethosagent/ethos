import { hashApiKey } from '@ethosagent/session-sqlite';
import { EthosError } from '@ethosagent/types';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { WebTokenRepository } from '../repositories/web-token.repository';
import type { ApiKeyAuthStore, ApiKeyRecord } from './bearer-auth';

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
  // U3 — spend and tokens aggregated from session message rows: a read of
  // sessions, so it takes the same scope as `sessions.get`.
  usage: { summary: 'sessions:read' },
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
  // Push (mobile-app S5, S13(c)). register/unregister/test act only on the
  // calling key's own device rows (`rpc/push.ts`). `listDevices` shows every
  // key's phones — the web's Connected phones list — so it is cookie-only.
  push: {
    register: 'push:register',
    unregister: 'push:register',
    test: 'push:register',
    listDevices: COOKIE_ONLY,
  },
  // Teams board (mobile-app S1, T5). Reads — including `listAgents`, which
  // names personalities and their mesh presence, no secrets — are
  // `kanban:read`; every write is `kanban:write`, and `rpc/kanban.ts`'s
  // `actorFor` stamps a bearer write `human:key:<name>` from the key row (S9).
  kanban: {
    list: 'kanban:read',
    getBoard: 'kanban:read',
    getTask: 'kanban:read',
    listAgents: 'kanban:read',
    updateStatus: 'kanban:write',
    bulkUpdateStatus: 'kanban:write',
    createTask: 'kanban:write',
    assign: 'kanban:write',
    bulkAssign: 'kanban:write',
    addComment: 'kanban:write',
  },
  // Team altitude (mobile-app S1, T5). Team memory is edited on the web, so
  // `memoryWrite` is cookie-only.
  teams: {
    list: 'teams:read',
    get: 'teams:read',
    ledger: 'teams:read',
    memoryList: 'teams:read',
    memoryRead: 'teams:read',
    memoryWrite: COOKIE_ONLY,
  },
  // Cron (mobile-app S1, T5): "see what a job did" without the power to fire,
  // edit or schedule one — every mutation is cookie-only.
  cron: {
    list: 'cron:read',
    get: 'cron:read',
    history: 'cron:read',
    deliveryTargets: 'cron:read',
    create: COOKIE_ONLY,
    update: COOKIE_ONLY,
    delete: COOKIE_ONLY,
    pause: COOKIE_ONLY,
    resume: COOKIE_ONLY,
    runNow: COOKIE_ONLY,
  },
  // Voice (mobile-app S8/Phase 3). `voice:talk` is what the phone's call
  // screen needs: one-shot turns, the realtime mint, the provider rosters
  // (labels, never credentials) and reading its lane's mode. Configuring the
  // deployment — a lane's mode, satellites, wake routes — and the phone-call
  // log (other people's numbers and transcripts) stay on the web: cookie-only.
  // Nested routers are keyed `<router>.<method>`: `resolveScope` splits on the
  // FIRST dot, so `/rpc/voice/laneMode/get` → `voice` + `laneMode.get`.
  voice: {
    transcribe: 'voice:talk',
    synthesize: 'voice:talk',
    runTurn: 'voice:talk',
    realtimeToken: 'voice:talk',
    ttsEntries: 'voice:talk',
    sttEntries: 'voice:talk',
    realtimeEntries: 'voice:talk',
    'laneMode.get': 'voice:talk',
    'laneMode.set': COOKIE_ONLY,
    'satellites.list': COOKIE_ONLY,
    'satellites.setWakeEnabled': COOKIE_ONLY,
    'wakeRoutes.get': COOKIE_ONLY,
    'wakeRoutes.set': COOKIE_ONLY,
    'calls.list': COOKIE_ONLY,
    'calls.active': COOKIE_ONLY,
    'calls.get': COOKIE_ONLY,
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

export interface VerifyBearerOptions {
  /** The raw `Authorization` header value. */
  header: string;
  /** The request's `Origin` header, checked against the key's `allowedOrigins`. */
  origin: string | undefined;
  apiKeys: ApiKeyAuthStore;
  /**
   * The scope this request needs: a scope name, `ANY_KEY`, or `COOKIE_ONLY`
   * (always refused). A thunk is resolved only AFTER the key itself checks
   * out, so a caller's own route refusals (thrown from it) rank below "your
   * key is bad" — the order `dualAuth` has always had.
   */
  requiredScope: string | (() => string);
  /** `touchLastUsed` throttle state — one map per mounted surface. */
  lastTouchAt: Map<string, number>;
}

/**
 * THE bearer API-key check outside `/v1/*`. Two callers, one enforcer:
 * `dualAuth` below (RPC and SSE) and the voice WebSocket upgrade (the
 * `authenticate` passed to `createVoiceSocket` in ../index.ts). In order: the
 * Bearer scheme, the `sk-ethos-` prefix, the key row by `hashApiKey`
 * (`SqliteApiKeyStore.findByHash` returns no revoked row, `revoked_at IS
 * NULL`; `revokedAt` is re-checked here for any other store), the key's
 * `allowedOrigins`, the scope, then a throttled `touchLastUsed`. Throws an
 * `EthosError` coded UNAUTHORIZED (the credential is bad) or FORBIDDEN (it is
 * good, but not for this). Pinned by ../__tests__/middleware/verify-bearer.test.ts.
 */
export async function verifyBearer(opts: VerifyBearerOptions): Promise<ApiKeyRecord> {
  const { header, origin } = opts;
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
  if (!record || record.revokedAt) {
    throw new EthosError({
      code: 'UNAUTHORIZED',
      cause: 'API key is invalid or has been revoked.',
      action: 'Check the key, or mint a new one from the Settings page.',
    });
  }

  if (record.allowedOrigins.length > 0) {
    if (!origin) {
      throw new EthosError({
        code: 'FORBIDDEN',
        cause: 'This API key requires an Origin header but none was provided.',
        action: 'Include the Origin header in your request, or remove allowedOrigins from the key.',
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

  const requiredScope =
    typeof opts.requiredScope === 'function' ? opts.requiredScope() : opts.requiredScope;
  if (requiredScope === COOKIE_ONLY) {
    throw new EthosError({
      code: 'FORBIDDEN',
      cause: 'This surface requires cookie authentication and is not accessible via API key.',
      action: 'Use cookie auth (the Ethos web UI).',
    });
  }
  // `ANY_KEY`: authenticated is enough — no scope check.
  if (requiredScope !== ANY_KEY && !record.scopes.includes(requiredScope)) {
    throw new EthosError({
      code: 'FORBIDDEN',
      cause: `API key is missing required scope "${requiredScope}".`,
      action: `Create a key with the "${requiredScope}" scope.`,
    });
  }

  const now = Date.now();
  const previous = opts.lastTouchAt.get(record.id) ?? 0;
  if (now - previous >= TOUCH_THROTTLE_MS) {
    opts.lastTouchAt.set(record.id, now);
    try {
      await opts.apiKeys.touchLastUsed(record.id);
    } catch {
      // `last_used` is a display hint for the Settings list; failing to bump
      // it must not refuse a request whose key already checked out.
    }
  }
  return record;
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

    const record = await verifyBearer({
      header,
      origin: c.req.header('origin'),
      apiKeys: opts.apiKeys,
      lastTouchAt,
      requiredScope: () => {
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
        if (c.req.path.startsWith('/sse/')) {
          const feed = c.req.path.slice('/sse/'.length).split('/')[0] ?? '';
          const feedScope = SSE_SCOPES[feed];
          if (feedScope === undefined) {
            throw new EthosError({
              code: 'FORBIDDEN',
              cause: `Feed "${feed}" is experimental and not accessible via API key.`,
              action: 'Use cookie auth (the Ethos web UI) for experimental feeds.',
            });
          }
          return feedScope;
        }

        const requiredScope = opts.scopeForPath(rpcPath);
        if (requiredScope === COOKIE_ONLY) {
          throw new EthosError({
            code: 'FORBIDDEN',
            cause: `Method "${rpcPath}" requires cookie authentication and is not accessible via API key.`,
            action: 'Use cookie auth (the Ethos web UI) for this method.',
          });
        }
        if (requiredScope) return requiredScope;
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
      },
    });

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
