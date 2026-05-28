import { describe, expect, it } from 'vitest';
import { __testing__, buildChildLaunchArgs, defaultChildSpecs, nextBackoff, pruneRestarts, } from '../run-all';
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
            expect(buildChildLaunchArgs('/usr/local/lib/node_modules/@ethosagent/cli/dist/index.js', [
                'gateway',
                'start',
            ])).toEqual(['/usr/local/lib/node_modules/@ethosagent/cli/dist/index.js', 'gateway', 'start']);
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
            for (let i = 0; i < 5; i++)
                v = nextBackoff(v);
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
        it('shutdown grace is 5 seconds — enough for child SIGTERM cleanup', () => {
            expect(__testing__.SHUTDOWN_GRACE_MS).toBe(5_000);
        });
    });
});
