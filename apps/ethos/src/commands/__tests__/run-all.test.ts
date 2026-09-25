import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATEWAY_LOCK_EXIT_CODE } from '@ethosagent/wiring';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __testing__,
  buildChildLaunchArgs,
  type ChildSpec,
  childExitDecision,
  defaultChildSpecs,
  GATEWAY_LOCK_HELD_EXIT_CODE,
  nextBackoff,
  pruneRestarts,
} from '../run-all';

describe('run-all — pure helpers', () => {
  describe('defaultChildSpecs', () => {
    it('returns gateway + serve, in that order', () => {
      const specs = defaultChildSpecs();
      expect(specs.map((s) => s.name)).toEqual(['gateway', 'serve']);
    });

    it('serve args are just ["serve"] (web is always-on)', () => {
      const serveSpec = defaultChildSpecs().find((s) => s.name === 'serve');
      expect(serveSpec).toBeDefined();
      expect(serveSpec?.args).toEqual(['serve']);
    });

    it('gateway uses `gateway start`', () => {
      const gatewaySpec = defaultChildSpecs().find((s) => s.name === 'gateway');
      expect(gatewaySpec?.args).toEqual(['gateway', 'start']);
    });
  });

  describe('buildChildLaunchArgs', () => {
    it('prepends the tsx loader when entry point is a .ts source file', () => {
      expect(buildChildLaunchArgs('/repo/apps/ethos/src/index.ts', ['gateway', 'start'])).toEqual([
        '--import',
        'tsx',
        '/repo/apps/ethos/src/index.ts',
        'gateway',
        'start',
      ]);
    });

    it('prepends the tsx loader for .tsx too', () => {
      expect(buildChildLaunchArgs('/repo/entry.tsx', ['serve'])).toEqual([
        '--import',
        'tsx',
        '/repo/entry.tsx',
        'serve',
      ]);
    });

    it('skips the loader when entry point is a bundled .js binary', () => {
      expect(
        buildChildLaunchArgs('/usr/local/lib/node_modules/@ethosagent/cli/dist/index.js', [
          'gateway',
          'start',
        ]),
      ).toEqual(['/usr/local/lib/node_modules/@ethosagent/cli/dist/index.js', 'gateway', 'start']);
    });
  });

  describe('nextBackoff', () => {
    it('doubles the current backoff', () => {
      expect(nextBackoff(1_000)).toBe(2_000);
      expect(nextBackoff(2_000)).toBe(4_000);
      expect(nextBackoff(4_000)).toBe(8_000);
    });

    it('caps at MAX_BACKOFF_MS', () => {
      expect(nextBackoff(__testing__.MAX_BACKOFF_MS)).toBe(__testing__.MAX_BACKOFF_MS);
      expect(nextBackoff(__testing__.MAX_BACKOFF_MS * 10)).toBe(__testing__.MAX_BACKOFF_MS);
    });

    it('1s → 30s ladder reaches the cap within 5 doublings', () => {
      let v = __testing__.INITIAL_BACKOFF_MS;
      for (let i = 0; i < 5; i++) v = nextBackoff(v);
      expect(v).toBe(__testing__.MAX_BACKOFF_MS);
    });
  });

  describe('pruneRestarts', () => {
    it('drops timestamps older than the window', () => {
      const now = 10_000;
      const window = 5_000;
      const kept = pruneRestarts([1_000, 4_000, 6_000, 9_500], now, window);
      // now-window = 5_000; keep entries strictly newer than that
      expect(kept).toEqual([6_000, 9_500]);
    });

    it('keeps everything when all timestamps are inside the window', () => {
      const now = 1_000;
      const window = 60_000;
      expect(pruneRestarts([100, 500, 900], now, window)).toEqual([100, 500, 900]);
    });

    it('returns an empty array when input is empty', () => {
      expect(pruneRestarts([], 1_000, 60_000)).toEqual([]);
    });

    it('drops everything when the window has fully elapsed', () => {
      const now = 1_000_000;
      const window = 60_000;
      expect(pruneRestarts([1, 2, 3], now, window)).toEqual([]);
    });

    it('crash-storm guard: 11 crashes in the window exceeds the 10 cap', () => {
      // Simulate 11 crashes spaced 100ms apart, all within the window. The
      // supervisor pushes its 11th timestamp and pruneRestarts keeps them all;
      // the caller's length-check then trips MAX_RESTARTS_IN_WINDOW.
      const now = 12_000;
      const timestamps = Array.from({ length: 11 }, (_, i) => 11_000 + i * 100);
      const kept = pruneRestarts(timestamps, now, __testing__.RESTART_WINDOW_MS);
      expect(kept.length).toBe(11);
      expect(kept.length).toBeGreaterThan(__testing__.MAX_RESTARTS_IN_WINDOW);
    });
  });

  describe('tuning constants', () => {
    it('initial backoff is 1 second', () => {
      expect(__testing__.INITIAL_BACKOFF_MS).toBe(1_000);
    });

    it('max backoff is 30 seconds', () => {
      expect(__testing__.MAX_BACKOFF_MS).toBe(30_000);
    });

    it('stable threshold is 60 seconds', () => {
      expect(__testing__.STABLE_THRESHOLD_MS).toBe(60_000);
    });

    it('restart window is 5 minutes', () => {
      expect(__testing__.RESTART_WINDOW_MS).toBe(5 * 60_000);
    });

    it('max-restarts cap leaves headroom above typical transient retries', () => {
      // 10 restarts in 5 minutes is the budget — generous enough that a real
      // crash-loop (token expired, bad config) trips it within ~30s of doubling
      // backoff, but a flaky network blip doesn't.
      expect(__testing__.MAX_RESTARTS_IN_WINDOW).toBe(10);
    });

    // F06 follow-up — a child's own SIGTERM path is bounded, but by far more
    // than 5 s: the gateway drains approval cards and in-flight turns before
    // its runtime disposal, serve closes its chat turns before its own. A 5 s
    // grace SIGKILLed children mid-disposal (half-closed stores, -wal left).
    // The grace is derived from the children's budgets; this pins it against
    // the constants where each budget is actually defined, so raising one
    // without raising the grace fails here.
    it('shutdown grace outlasts the slowest child’s own bounded shutdown', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
      const constant = async (path: string, name: string): Promise<number> => {
        const src = await readFile(join(root, path), 'utf8');
        const m = src.match(new RegExp(`const ${name}(?::\\s*number)? = ([0-9_]+);`));
        if (!m?.[1]) throw new Error(`${name} not found in ${path}`);
        return Number(m[1].replace(/_/g, ''));
      };
      const dispose = await constant(
        'apps/ethos/src/lib/dispose-before-exit.ts',
        'DISPOSE_BEFORE_EXIT_GRACE_MS',
      );
      const step = await constant(
        'apps/ethos/src/lib/bounded-shutdown-step.ts',
        'SHUTDOWN_STEP_TIMEOUT_MS',
      );
      // Every `boundedShutdownStep(` call site on a child's path counts one
      // step bound — a new bounded await raises the budget or fails here.
      const steps = async (path: string): Promise<number> =>
        ((await readFile(join(root, path), 'utf8')).match(/boundedShutdownStep\(/g) ?? []).length;
      const gatewaySteps = await steps('apps/ethos/src/commands/gateway.ts');
      expect(gatewaySteps).toBe(4);
      const gateway =
        (await constant('apps/ethos/src/commands/gateway.ts', 'APPROVAL_SHUTDOWN_DRAIN_MS')) +
        gatewaySteps * step +
        // `Gateway.shutdown`: notice sends and the turn drain share this one bound.
        (await constant('extensions/gateway/src/index.ts', 'SHUTDOWN_DRAIN_TIMEOUT_MS')) +
        dispose;
      // serve.ts has five call sites across its two branches (onboarding: one;
      // full: four); the longer branch is four steps. Its listener step
      // includes `LISTENER_FLUSH_MS`, so the flush adds nothing on top.
      expect(await steps('apps/ethos/src/commands/serve.ts')).toBe(5);
      const serve =
        (await constant('apps/web-api/src/features/chat/service.ts', 'CLOSE_GRACE_MS')) +
        4 * step +
        dispose;
      expect(__testing__.CHILD_SHUTDOWN_BUDGET_MS).toBe(gateway);
      expect(__testing__.CHILD_SHUTDOWN_BUDGET_MS).toBeGreaterThanOrEqual(Math.max(gateway, serve));
      expect(__testing__.SHUTDOWN_GRACE_MS).toBeGreaterThan(__testing__.CHILD_SHUTDOWN_BUDGET_MS);
    });

    it('default health port is 3004 (moved off 3003 to avoid the gateway webhook collision)', () => {
      expect(__testing__.DEFAULT_HEALTH_PORT).toBe(3004);
    });
  });
});

// ---------------------------------------------------------------------------
// Gateway lock refusal is terminal, not a crash (plan reach-and-containment
// D2-14).
// ---------------------------------------------------------------------------

describe('run-all — gateway exit 3 is terminal', () => {
  // The log dir is left in the OS tmpdir: `startChild` opens its log stream
  // asynchronously, and removing the directory under it raises ENOENT after
  // the test has finished.
  let dir: string | undefined;
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mirrors the wiring exit code and marks only the gateway spec terminal on 3', () => {
    expect(GATEWAY_LOCK_HELD_EXIT_CODE).toBe(GATEWAY_LOCK_EXIT_CODE);
    const [gateway, serve] = defaultChildSpecs();
    if (!gateway || !serve) throw new Error('specs');
    expect(childExitDecision(gateway, 3, null)).toBe('terminal');
    expect(childExitDecision(gateway, 1, null)).toBe('restart');
    expect(childExitDecision(gateway, null, 'SIGKILL')).toBe('restart');
    expect(childExitDecision(serve, 3, null)).toBe('restart');
  });

  function fakeSpawn() {
    const spawned: Array<{ name: string; child: EventEmitter & { stderr: EventEmitter } }> = [];
    const spawn = vi.fn((_exec: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 1000 + spawned.length,
      });
      spawned.push({ name: args.includes('serve') ? 'serve' : 'gateway', child });
      return child;
    });
    return { spawn, spawned };
  }

  function supervised(spec: ChildSpec) {
    return {
      spec,
      process: null,
      restarts: [] as number[],
      backoffMs: __testing__.INITIAL_BACKOFF_MS,
      shuttingDown: false,
      stableTimer: null,
      logStream: null,
      rotationTimer: null,
    };
  }

  it('does not restart a gateway child that exits 3, logs the refusal once, keeps serve up', () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'run-all-'));
    const logs: string[] = [];
    const log = { log: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const { spawn, spawned } = fakeSpawn();
    const [gatewaySpec, serveSpec] = defaultChildSpecs();
    if (!gatewaySpec || !serveSpec) throw new Error('specs');
    const gw = supervised(gatewaySpec);
    const serve = supervised(serveSpec);
    const rotation = { ...__testing__.DEFAULT_LOG_ROTATION, enabled: false };
    for (const sc of [gw, serve]) {
      __testing__.startChild(sc as never, 'x.js', dir, spawn as never, log, () => {}, rotation);
    }
    const gwChild = spawned.find((s) => s.name === 'gateway')?.child;
    gwChild?.stderr.emit(
      'data',
      Buffer.from('Another Ethos gateway is already running for /tmp/x (pid 42).\n'),
    );
    gwChild?.emit('exit', 3, null);
    vi.advanceTimersByTime(10 * 60_000);

    expect(spawned.filter((s) => s.name === 'gateway')).toHaveLength(1);
    expect(logs.filter((l) => l.includes('refused to start'))).toHaveLength(1);
    expect(logs.join('\n')).toContain('Another Ethos gateway is already running');
    expect(logs.join('\n')).not.toContain('restarting gateway');
    // serve was never touched.
    expect(serve.process).not.toBeNull();
    expect(spawned.filter((s) => s.name === 'serve')).toHaveLength(1);
  });

  it('a genuine gateway crash still restarts after the backoff', () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'run-all-'));
    const log = { log: () => {}, error: () => {} };
    const { spawn, spawned } = fakeSpawn();
    const [gatewaySpec] = defaultChildSpecs();
    if (!gatewaySpec) throw new Error('specs');
    const gw = supervised(gatewaySpec);
    const rotation = { ...__testing__.DEFAULT_LOG_ROTATION, enabled: false };
    __testing__.startChild(gw as never, 'x.js', dir, spawn as never, log, () => {}, rotation);
    spawned[0]?.child.emit('exit', 1, null);
    vi.advanceTimersByTime(__testing__.INITIAL_BACKOFF_MS + 10);
    expect(spawned).toHaveLength(2);
  });
});
