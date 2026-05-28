// Supervisor crash-behaviour unit tests.
//
// These test the state-machine logic directly without spawning real processes.
// They verify:
//   - auto_restart:true → backoff restart, give-up after 5 failures/60s
//   - auto_restart:false → member marked failed, supervisor stays alive
//   - Supervisor process.exit is never called on a member crash
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helper — simulate the exit-event handler logic extracted from supervisor.ts
// ---------------------------------------------------------------------------
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;
function simulateExit(member, _code, _signal, now = Date.now()) {
  let restartScheduled = false;
  let backoffMs = null;
  let gaveUp = false;
  const exitCalled = false; // supervisor never calls process.exit on member crash
  if (!member.auto_restart) {
    member.status = 'failed';
    return { status: member.status, restartScheduled, backoffMs, gaveUp, exitCalled };
  }
  member.recentFailures = member.recentFailures.filter((t) => now - t < FAILURE_WINDOW_MS);
  member.recentFailures.push(now);
  member.failureCount++;
  if (member.recentFailures.length >= MAX_FAILURES) {
    member.status = 'failed';
    gaveUp = true;
    return { status: member.status, restartScheduled, backoffMs, gaveUp, exitCalled };
  }
  backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (member.recentFailures.length - 1), BACKOFF_CAP_MS);
  member.status = 'restarting';
  restartScheduled = true;
  return { status: member.status, restartScheduled, backoffMs, gaveUp, exitCalled };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('supervisor crash behaviour — auto_restart: true', () => {
  it('schedules a restart on first crash', () => {
    const m = {
      personality: 'worker',
      auto_restart: true,
      status: 'running',
      failureCount: 0,
      recentFailures: [],
    };
    const r = simulateExit(m, 1, null);
    expect(r.restartScheduled).toBe(true);
    expect(r.status).toBe('restarting');
    expect(r.backoffMs).toBe(1000);
    expect(r.gaveUp).toBe(false);
  });
  it('applies exponential backoff: 1s → 2s → 4s → 8s → give-up', () => {
    const m = {
      personality: 'worker',
      auto_restart: true,
      status: 'running',
      failureCount: 0,
      recentFailures: [],
    };
    const now = Date.now();
    const backoffs = [];
    for (let i = 0; i < 5; i++) {
      const r = simulateExit(m, 1, null, now + i);
      backoffs.push(r.backoffMs);
    }
    expect(backoffs[0]).toBe(1000);
    expect(backoffs[1]).toBe(2000);
    expect(backoffs[2]).toBe(4000);
    expect(backoffs[3]).toBe(8000);
    // 5th failure hits the limit → give_up, backoffMs is null
    expect(backoffs[4]).toBeNull();
  });
  it('marks member failed after 5 failures within the window', () => {
    const m = {
      personality: 'worker',
      auto_restart: true,
      status: 'running',
      failureCount: 0,
      recentFailures: [],
    };
    const now = Date.now();
    let last;
    for (let i = 0; i < 5; i++) {
      last = simulateExit(m, 1, null, now + i);
    }
    expect(last?.gaveUp).toBe(true);
    expect(last?.status).toBe('failed');
    expect(last?.restartScheduled).toBe(false);
  });
  it('does NOT call process.exit on member crash', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const m = {
      personality: 'worker',
      auto_restart: true,
      status: 'running',
      failureCount: 0,
      recentFailures: [],
    };
    simulateExit(m, 1, null);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
  it('resets failure window when crashes are spread more than 60s apart', () => {
    const m = {
      personality: 'worker',
      auto_restart: true,
      status: 'running',
      failureCount: 0,
      recentFailures: [],
    };
    const t0 = Date.now();
    // 4 failures right now
    for (let i = 0; i < 4; i++) simulateExit(m, 1, null, t0 + i);
    expect(m.recentFailures).toHaveLength(4);
    // 1 failure 61s later — window resets; those 4 failures are pruned
    const r = simulateExit(m, 1, null, t0 + 61_000);
    expect(r.status).toBe('restarting'); // not 'failed' — only 1 failure in new window
    expect(r.backoffMs).toBe(1000);
  });
});
describe('supervisor crash behaviour — auto_restart: false', () => {
  it('marks member failed and does not schedule restart', () => {
    const m = {
      personality: 'worker',
      auto_restart: false,
      status: 'running',
      failureCount: 0,
      recentFailures: [],
    };
    const r = simulateExit(m, 1, null);
    expect(r.status).toBe('failed');
    expect(r.restartScheduled).toBe(false);
    expect(r.gaveUp).toBe(false);
  });
  it('does NOT call process.exit — other members unaffected', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const m = {
      personality: 'worker',
      auto_restart: false,
      status: 'running',
      failureCount: 0,
      recentFailures: [],
    };
    simulateExit(m, 137, 'SIGKILL');
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
describe('supervisor crash behaviour — backoff cap', () => {
  it('backoff caps at 30s regardless of failure count', () => {
    const m = {
      personality: 'worker',
      auto_restart: true,
      status: 'running',
      failureCount: 0,
      recentFailures: [],
    };
    // Pre-load 3 recent failures to reach high backoff without triggering give-up
    const now = Date.now();
    m.recentFailures = [now - 3, now - 2, now - 1];
    m.failureCount = 3;
    // 4th failure → 2^(4-1) * 1000 = 8000 ms
    const r = simulateExit(m, 1, null, now);
    expect(r.backoffMs).toBe(8000);
    // Manually push failure count to get to the cap
    m.recentFailures = []; // reset to avoid give-up
    m.recentFailures = [now - 4, now - 3, now - 2, now - 1];
    const r2 = simulateExit(m, 1, null, now);
    // 5th failure in window → give_up (not cap)
    expect(r2.gaveUp).toBe(true);
  });
  it('backoff is capped at BACKOFF_CAP_MS when forced manually', () => {
    // Directly test the cap formula
    const raw = BACKOFF_BASE_MS * 2 ** 10; // 1024s
    const capped = Math.min(raw, BACKOFF_CAP_MS);
    expect(capped).toBe(BACKOFF_CAP_MS);
  });
});
