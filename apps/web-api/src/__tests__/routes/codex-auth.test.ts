import type { SecretsResolver } from '@ethosagent/types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { codexAuthRoutes } = await import('../../routes/codex-auth');

describe('codex device-auth pending cap (WEB-007)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.useFakeTimers();
    app = new Hono();
    app.route('/auth/codex', codexAuthRoutes({ secrets: {} as unknown as SecretsResolver }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('accepts up to the ceiling then rejects further device-code requests with 429', async () => {
    // The module-global `pending` map starts empty in this isolated module.
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
