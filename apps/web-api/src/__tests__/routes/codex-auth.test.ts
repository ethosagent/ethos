import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { SecretsResolver } from '@ethosagent/types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { rateLimitMiddleware } from '../../middleware/rate-limit';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// WEB-007 — the codex device-auth endpoint must bound the
// number of concurrent pending flows so it cannot spawn unbounded background
// pollers / grow the in-memory map without limit.

// Mock the codex client so no network / real poller runs. `pollForAuthorization`
// never resolves, so each successful request leaves its `pending` entry in
// place (fake timers keep the cleanup timeout from firing).
// The rest of the package is kept real: the full-app mount below pulls in
// wiring, which imports more of it than these four.
vi.mock('@ethosagent/llm-codex', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CodexTokenStore: class {
    async save() {}
  },
  requestDeviceCode: vi.fn(async () => ({ deviceAuthId: 'dev', userCode: 'ABCD-1234' })),
  pollForAuthorization: vi.fn(() => new Promise<never>(() => {})),
  exchangeForTokens: vi.fn(async () => ({})),
}));

// Re-import per test so the module-global `pending` map starts empty each time.
async function freshCodexRoutes() {
  vi.resetModules();
  const { codexAuthRoutes } = await import('../../routes/codex-auth');
  return codexAuthRoutes({ secrets: {} as unknown as SecretsResolver });
}

describe('codex device-auth pending cap (WEB-007)', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.useFakeTimers();
    app = new Hono();
    app.route('/auth/codex', await freshCodexRoutes());
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('accepts up to the ceiling then rejects further device-code requests with 429', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await app.request('/auth/codex/device-code', { method: 'POST' });
      expect(res.status).toBe(200);
    }
    // 21st request exceeds MAX_PENDING (20) → rejected without a new poller.
    const overflow = await app.request('/auth/codex/device-code', { method: 'POST' });
    expect(overflow.status).toBe(429);
    const body = (await overflow.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/too many pending/i);
  });
});

// The onboarding UI polls /status on an interval. The mount wiring in
// routes/index.ts gives /status a poll-tolerant limiter while /device-code
// (which spawns background pollers) keeps the strict defaults — mirror that
// wiring here and assert the split.
describe('codex device-auth rate-limit mounts', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.useFakeTimers();
    app = new Hono();
    app.use('/auth/codex/device-code', rateLimitMiddleware({ trustProxy: false }));
    app.use(
      '/auth/codex/status',
      rateLimitMiddleware({
        maxTokens: 30,
        refillMs: 4_000,
        lockoutMs: 60_000,
        trustProxy: false,
      }),
    );
    app.route('/auth/codex', await freshCodexRoutes());
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('status tolerates rapid polling — 10 quick GETs return 404, never 429', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/auth/codex/status?session=unknown-session');
      expect(res.status).toBe(404);
    }
  });

  it('device-code still rate-limits after 5 requests', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/auth/codex/device-code', { method: 'POST' });
      expect(res.status).toBe(200);
    }
    const limited = await app.request('/auth/codex/device-code', { method: 'POST' });
    expect(limited.status).toBe(429);
    // The onboarding UI reads Retry-After to schedule its next poll.
    const retryAfter = Number.parseInt(limited.headers.get('Retry-After') ?? '', 10);
    expect(retryAfter).toBeGreaterThan(0);
    const body = (await limited.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('rate_limited');
  });
});

// S8 (plan openclaw-2026.9.6-gaps). The device-code flow ends in
// `CodexTokenStore.save`, which replaces this deployment's Codex credentials,
// and `/auth/codex` used to be mounted with rate limiting only — anyone who
// could reach a `0.0.0.0` bind could start one. It now sits behind the cookie
// auth and the CSRF check (the `/auth/codex/*` mount in `createRoutes`,
// routes/index.ts). Every caller is the SPA (`AuthStep`,
// `add-provider-drawer`), which is already signed in and same-origin.
describe('codex device-auth mount posture (S8)', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;
  const sameOrigin = { origin: 'http://localhost:3000', host: 'localhost:3000' };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dir = await mkdtemp(join(tmpdir(), 'ethos-codex-auth-'));
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'm', provider: 'p' },
    }).app;
    const token = await new WebTokenRepository({
      dataDir: dir,
      storage: new FsStorage(),
    }).getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, { headers: sameOrigin });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    expect(cookie).toBeTruthy();
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('401s an unauthenticated device-code request', async () => {
    const res = await app.request('/auth/codex/device-code', {
      method: 'POST',
      headers: sameOrigin,
    });
    expect(res.status).toBe(401);
  });

  it('401s an unauthenticated status poll', async () => {
    const res = await app.request('/auth/codex/status?session=unknown');
    expect(res.status).toBe(401);
  });

  it('refuses a cross-origin device-code request that carries the cookie', async () => {
    const res = await app.request('/auth/codex/device-code', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost:5999', host: 'localhost:3000' },
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/Cross-origin/);
  });

  it('serves the signed-in, same-origin SPA', async () => {
    const res = await app.request('/auth/codex/device-code', {
      method: 'POST',
      headers: { cookie, ...sameOrigin },
    });
    expect(res.status).toBe(200);
    const { sessionToken } = (await res.json()) as { sessionToken: string };
    const status = await app.request(`/auth/codex/status?session=${sessionToken}`, {
      headers: { cookie },
    });
    expect(status.status).toBe(200);
  });
});
