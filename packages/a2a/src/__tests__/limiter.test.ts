// Per-peer limiter (plan §O6 / §12) — the rate cap and the concurrency cap are
// DISTINCT and defend against distinct attacks.

import { describe, expect, it } from 'vitest';
import { MemoryA2aLimiter } from '../limiter';

const P = 'researcher';
const PEER = 'fp-peer';

describe('MemoryA2aLimiter — concurrency cap (distinct from rate)', () => {
  it('rejects the (cap+1)-th concurrent lease and readmits after a release', async () => {
    const limiter = new MemoryA2aLimiter({ maxConcurrentPerPeer: 2, ratePerWindow: 1000 });

    const a = await limiter.acquire(P, PEER);
    const b = await limiter.acquire(P, PEER);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    // Third concurrent task is over the concurrency cap → typed busy (null).
    const c = await limiter.acquire(P, PEER);
    expect(c).toBeNull();

    // Releasing one frees a concurrency slot (rate budget is generous here).
    a?.release();
    const d = await limiter.acquire(P, PEER);
    expect(d).not.toBeNull();
  });

  it('caps concurrency PER peer independently', async () => {
    const limiter = new MemoryA2aLimiter({ maxConcurrentPerPeer: 1, ratePerWindow: 1000 });
    const a = await limiter.acquire(P, 'peer-1');
    expect(a).not.toBeNull();
    expect(await limiter.acquire(P, 'peer-1')).toBeNull();
    // A different peer has its own slot.
    expect(await limiter.acquire(P, 'peer-2')).not.toBeNull();
  });
});

describe('MemoryA2aLimiter — rate cap (distinct from concurrency)', () => {
  it('rejects once the rate window is saturated even when leases are released', async () => {
    let t = 1_000_000;
    const limiter = new MemoryA2aLimiter({
      maxConcurrentPerPeer: 1000,
      ratePerWindow: 3,
      windowMs: 60_000,
      now: () => t,
    });

    // Three acquisitions, each released immediately (concurrency never a factor).
    for (let i = 0; i < 3; i++) {
      const lease = await limiter.acquire(P, PEER);
      expect(lease).not.toBeNull();
      lease?.release();
    }
    // The 4th within the window is rate-limited despite zero active leases.
    expect(await limiter.acquire(P, PEER)).toBeNull();

    // After the window slides, the rate budget refills.
    t += 60_001;
    const later = await limiter.acquire(P, PEER);
    expect(later).not.toBeNull();
  });
});
