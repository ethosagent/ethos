import type { SecretsResolver } from '@ethosagent/types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimitMiddleware } from '../../middleware/rate-limit';

// WEB-007 — the unauthenticated codex device-auth endpoint must bound the
// number of concurrent pending flows so it cannot spawn unbounded background
// pollers / grow the in-memory map without limit.

// Mock the codex client so no network / real poller runs. `pollForAuthorization`
// never resolves, so each successful request leaves its `pending` entry in
// place (fake timers keep the cleanup timeout from firing).
vi.mock('@ethosagent/llm-codex', () => ({
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
