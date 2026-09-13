import { ModelTestRateLimiter } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { service } from './model-registry-fixture';

// The 10s per-alias-per-caller limit (D19). A test is a real billable
// completion reachable by anything that can call the RPC, so the limit is
// enforced in the handler's own path — the client-side disable (T2.8) is UX on
// top of it, not the limit itself.

describe('modelRegistry.test rate limit', () => {
  it('a second test of the same alias within the window is refused by the handler, not only by the button', async () => {
    let now = 1_000_000;
    const limiter = new ModelTestRateLimiter(10_000, () => now);
    const { svc, probed } = service(() => ({ ok: true, latencyMs: 5 }), { limiter });

    expect((await svc.test({ alias: 'opus' }, 'cookie')).state).toBe('ok');
    now += 3_000;
    expect((await svc.test({ alias: 'opus' }, 'cookie')).state).toBe('rate_limited');
    // The point of enforcing it here: no second billable completion happened.
    expect(probed.length).toBe(1);

    // A DIFFERENT alias is a different bucket, and so is a different caller.
    expect((await svc.test({ alias: 'sonnet' }, 'cookie')).state).toBe('ok');
    expect((await svc.test({ alias: 'opus' }, 'bearer')).state).toBe('ok');

    // Past the window, the same alias is testable again.
    now += 8_000;
    expect((await svc.test({ alias: 'opus' }, 'cookie')).state).toBe('ok');
  });

  it('the refusal names the seconds remaining', async () => {
    let now = 0;
    const limiter = new ModelTestRateLimiter(10_000, () => now);
    const { svc } = service(() => ({ ok: true, latencyMs: 5 }), { limiter });
    await svc.test({ alias: 'opus' }, 'cookie');
    now += 2_500;
    const out = await svc.test({ alias: 'opus' }, 'cookie');
    expect(out.state).toBe('rate_limited');
    // Rounded UP: never tell the caller to come back before the window closes.
    expect(out.state === 'rate_limited' && out.retryAfterSeconds).toBe(8);
  });
});
