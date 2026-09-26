import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { ApiKeyStaticScopeSchema } from '@ethosagent/web-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import { COOKIE_ONLY, SCOPE_MAP } from '../../middleware/dual-auth';
import { apiRouter } from '../../rpc/router';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// WEB-001 drift gate. Every RPC method in a namespace that SCOPE_MAP claims to
// govern MUST have an explicit scope entry. Without this, a method added to a
// mapped namespace (e.g. `sessions.export`) silently inherits the fail-closed
// path and becomes cookie-only by accident — or, before the fail-closed fix,
// fell through with NO scope enforced. The reverse assertion catches stale
// mappings pointing at renamed/removed methods.

const router = apiRouter as unknown as Record<string, Record<string, unknown>>;
// SCOPE_MAP gates fixed surfaces, so its values are drawn from the static
// enum half of the scope vocabulary. The open-ended `mcp:<id>` family is not
// a SCOPE_MAP concern and has no enumerable list.
const validScopes = new Set<string>(ApiKeyStaticScopeSchema.options);

describe('SCOPE_MAP drift — router methods ⊆ SCOPE_MAP per mapped namespace', () => {
  for (const ns of Object.keys(SCOPE_MAP)) {
    const mapped = SCOPE_MAP[ns] ?? {};

    it(`${ns}: every router method has a scope entry`, () => {
      const routerMethods = Object.keys(router[ns] ?? {});
      const missing = routerMethods.filter((m) => !(m in mapped));
      expect(missing).toEqual([]);
    });

    it(`${ns}: no stale scope entries for removed methods`, () => {
      const routerMethods = new Set(Object.keys(router[ns] ?? {}));
      const stale = Object.keys(mapped).filter((m) => !routerMethods.has(m));
      expect(stale).toEqual([]);
    });

    it(`${ns}: every scope value is a real ApiKeyScope or COOKIE_ONLY`, () => {
      for (const scope of Object.values(mapped)) {
        if (scope === COOKIE_ONLY) continue;
        expect(validScopes.has(scope)).toBe(true);
      }
    });
  }
});

// Mount-posture drift gate (S8, plan openclaw-2026.9.6-gaps). SCOPE_MAP only
// governs `/rpc`; a route mounted anywhere else gets whatever middleware its
// prefix happens to have, and `/auth/codex` was mounted with none. Every route
// the built app registers must answer an unauthenticated request with 401/403,
// unless it is listed in PUBLIC_ROUTES with the reason it may be public. A new
// route that is neither fails here instead of shipping open.
const PUBLIC_ROUTES: Record<string, string> = {
  'GET /healthz': 'container liveness probe; reports health only',
  'GET /auth/exchange': 'how the auth cookie gets set — cannot require it',
  'GET /auth/callback':
    'OAuth redirect target; only completes a flow the coordinator started, by its state',
  'GET /oauth/callback':
    'MCP OAuth redirect target; only completes a flow whose state matches the ' +
    'ethos_mcp_pending cookie (McpService.complete)',
};

describe('mount-posture drift — every non-public route refuses an unauthenticated request', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-mount-posture-'));
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'm', provider: 'p' },
    }).app;
  });

  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Every registered route, middleware included (Hono lists `use()` entries as
  // method ALL — probed as POST, the state-changing case). App-wide `*`
  // middleware is not a route.
  function mounted(): Array<{ method: string; path: string }> {
    const seen = new Set<string>();
    const out: Array<{ method: string; path: string }> = [];
    for (const r of app.routes) {
      if (r.path === '*' || r.path === '/*') continue;
      const method = r.method === 'ALL' ? 'POST' : r.method;
      const key = `${method} ${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ method, path: r.path });
    }
    return out;
  }

  it('enumerates /auth/codex', () => {
    const paths = mounted().map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('POST /auth/codex/device-code');
    expect(paths).toContain('GET /auth/codex/status');
  });

  it('gates every route not listed as public', async () => {
    const open: string[] = [];
    for (const { method, path } of mounted()) {
      const key = `${method} ${path}`;
      if (key in PUBLIC_ROUTES) continue;
      const url = path.replace(/:[^/]+/g, 'x').replace(/\*/g, 'x');
      const res = await app.request(url, {
        method,
        headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
      });
      if (res.status !== 401 && res.status !== 403) open.push(`${key} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  });
});
