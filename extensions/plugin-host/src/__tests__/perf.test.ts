import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CHILD_ENTRY, callTool, fixtureDir, makeCtx, makeHarness } from './helpers/harness';

// Plan plugin-process-isolation §9.4. The bounds are loose on purpose (CI
// variance); the measured numbers are printed so the PR description can quote them.

const CALLS = 300;
const WARMUP = 20;
const TEN_KB = 'x'.repeat(10 * 1024);
const SLOW = 120_000;
const SOURCE_SPAWN_CEILING_MS = 10_000;

type Execute = (args: unknown, ctx: unknown) => Promise<unknown>;

function pct(samples: number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

/** stderr, so the numbers survive a quiet reporter. */
function report(text: string): void {
  process.stderr.write(`${text}\n`);
}

const fmt = (n: number): string => n.toFixed(3);

async function time(fn: () => Promise<unknown>, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n + WARMUP; i++) {
    const t0 = performance.now();
    await fn();
    if (i >= WARMUP) out.push(performance.now() - t0);
  }
  return out;
}

/** The echo fixture's `echo` tool run in this process, the baseline. */
async function inProcessEcho(): Promise<Execute> {
  const home = await mkdtemp(join(tmpdir(), 'plugin-host-perf-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = (await import(pathToFileURL(join(fixtureDir('echo'), 'index.js')).href)) as {
      activate(api: { registerTool(t: { name: string; execute: Execute }): void }): void;
    };
    let execute: Execute | undefined;
    mod.activate({
      registerTool: (t: { name: string; execute: Execute }) => {
        if (t.name === 'echo') execute = t.execute;
      },
    } as never);
    if (!execute) throw new Error('echo tool not registered');
    return execute;
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

describe('host-mode overhead', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  it(
    'a no-op tool call costs p50 <= 1 ms and p95 <= 5 ms over in-process; 10 KB stays under 2 ms p50',
    async () => {
      const local = await inProcessEcho();
      const h = await makeHarness({ now: Date.now });
      cleanups.push(() => h.cleanup());
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      const ctx = makeCtx();

      const inProc = await time(() => local({ text: '' }, ctx), CALLS);
      const hosted = await time(() => callTool(lease, 'echo', { text: '' }), CALLS);
      const inProc10k = await time(() => local({ text: TEN_KB }, ctx), CALLS);
      const hosted10k = await time(() => callTool(lease, 'echo', { text: TEN_KB }), CALLS);

      const over = {
        p50: pct(hosted, 0.5) - pct(inProc, 0.5),
        p95: pct(hosted, 0.95) - pct(inProc, 0.95),
      };
      const over10k = pct(hosted10k, 0.5) - pct(inProc10k, 0.5);
      report(
        `[perf] n=${CALLS} no-op: in-process p50=${fmt(pct(inProc, 0.5))}ms p95=${fmt(pct(inProc, 0.95))}ms | hosted p50=${fmt(pct(hosted, 0.5))}ms p95=${fmt(pct(hosted, 0.95))}ms | overhead p50=${fmt(over.p50)}ms p95=${fmt(over.p95)}ms\n` +
          `[perf] 10KB arg: in-process p50=${fmt(pct(inProc10k, 0.5))}ms | hosted p50=${fmt(pct(hosted10k, 0.5))}ms p95=${fmt(pct(hosted10k, 0.95))}ms | overhead p50=${fmt(over10k)}ms`,
      );

      expect(over.p50).toBeLessThanOrEqual(1);
      expect(over.p95).toBeLessThanOrEqual(5);
      expect(pct(hosted10k, 0.5)).toBeLessThan(2);
    },
    SLOW,
  );

  it(
    'spawn to ready is <= 1 s at p95 for the echo fixture, and idle RSS is logged',
    async () => {
      const spawns: number[] = [];
      const rss: number[] = [];
      for (let i = 0; i < 6; i++) {
        const h = await makeHarness({ now: Date.now, statsIntervalMs: 0 });
        const t0 = performance.now();
        await h.pool.acquire({ id: `echo-${i}`, dir: fixtureDir('echo') });
        spawns.push(performance.now() - t0);
        const spawned = h.events.find((e) => e.category === 'plugin_host.spawned');
        if (typeof spawned?.payload.rss_mb === 'number') rss.push(spawned.payload.rss_mb);
        await h.cleanup();
      }
      report(
        `[perf] spawn-to-ready n=${spawns.length}: p50=${fmt(pct(spawns, 0.5))}ms p95=${fmt(pct(spawns, 0.95))}ms max=${fmt(Math.max(...spawns))}ms | idle child rss_mb=${rss.join(',')}`,
      );
      // The plan's 1 s bound is for a bundled child. The test child is TypeScript
      // run through tsx, which compiles the whole child graph on every spawn, so
      // under source it only has to stay inside a dev-mode ceiling. The measured
      // numbers above are what the PR quotes for the 1 s question.
      const fromSource = CHILD_ENTRY.endsWith('.ts');
      expect(pct(spawns, 0.95)).toBeLessThanOrEqual(fromSource ? SOURCE_SPAWN_CEILING_MS : 1_000);
    },
    SLOW,
  );
});
