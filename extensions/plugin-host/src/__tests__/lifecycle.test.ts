import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { backoffDelay } from '../backoff';
import { HostStartError, HostUnavailableError } from '../errors';
import { defaultLaunchArgs } from '../pool';
import {
  CHILD_ENTRY,
  callTool,
  eventsOf,
  fixtureDir,
  type Harness,
  isAlive,
  makeHarness,
  waitFor,
} from './helpers/harness';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const SLOW = 30_000;

describe('start', () => {
  it('ready within the deadline or the plugin fails to start', async () => {
    h = await makeHarness({ mockMode: 'silent', readyTimeoutMs: 300 });
    const started = Date.now();
    await expect(h.pool.acquire({ id: 'quiet', dir: '/unused' })).rejects.toThrow(
      /did not become ready within 300 ms/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.pool.entry('quiet')).toBeUndefined();
  });

  it('a host that exits before ready fails with its stderr', async () => {
    h = await makeHarness({
      mockMode: 'ok',
      launchArgs: () => ['-e', 'console.error("kaboom"); process.exit(2)'],
    });
    const err = await h.pool.acquire({ id: 'dead', dir: '/unused' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostStartError);
    expect(String(err)).toMatch(/exited \(code 2\) before it was ready: kaboom/);
  });

  it(
    'a plugin that fails to load is reported, not half-loaded',
    async () => {
      h = await makeHarness();
      await expect(
        h.pool.acquire({ id: 'nope', dir: '/definitely/not/a/plugin' }),
      ).rejects.toThrow();
      expect(h.pool.entry('nope')).toBeUndefined();
    },
    SLOW,
  );

  it(
    'two loops leasing one plugin spawn one host and run activate once',
    async () => {
      h = await makeHarness();
      const a = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      const b = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      expect(h.pool.leasesOf('echo')).toBe(2);
      expect(eventsOf(h, 'plugin_host.spawned')).toHaveLength(1);
      const pids = [await callTool(a, 'echo_pid'), await callTool(b, 'echo_pid')];
      expect(pids[0]).toEqual(pids[1]);
      expect(await callTool(a, 'echo_activations')).toEqual({ ok: true, value: '1' });
      expect(b.registrations).toEqual(a.registrations);
    },
    SLOW,
  );

  it('concurrent first acquires share one spawn', async () => {
    h = await makeHarness({ mockMode: 'ok' });
    await Promise.all([
      h.pool.acquire({ id: 'm', dir: '/unused' }),
      h.pool.acquire({ id: 'm', dir: '/unused' }),
    ]);
    expect(eventsOf(h, 'plugin_host.spawned')).toHaveLength(1);
    expect(h.pool.leasesOf('m')).toBe(2);
  });

  it('builds the tsx launch argv for a .ts child and a bare path for a bundle', () => {
    expect(defaultLaunchArgs('/x/child.js')).toEqual(['/x/child.js']);
    const ts = defaultLaunchArgs('/x/child.ts');
    expect(ts[0]).toBe('--import');
    expect(ts.at(-1)).toBe('/x/child.ts');
  });
});

describe('crash handling', () => {
  it(
    'a crash mid-call returns execution_failed with "may or may not have taken effect"',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'crashy', dir: fixtureDir('crashy') });
      const result = await callTool(lease, 'exit_now');
      expect(result).toEqual({
        ok: false,
        code: 'execution_failed',
        error:
          "Plugin 'crashy' host exited (code 3) while 'exit_now' was running, so it may or may not have taken effect.",
      });
      expect(eventsOf(h, 'plugin_host.crashed')[0]?.payload).toMatchObject({
        plugin_id: 'crashy',
        code: 3,
        in_flight: 1,
      });
    },
    SLOW,
  );

  it(
    'a SIGKILL mid-call reports the signal',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'crashy', dir: fixtureDir('crashy') });
      const result = await callTool(lease, 'kill_self');
      expect(result).toMatchObject({ ok: false, code: 'execution_failed' });
      expect(result.ok ? '' : result.error).toMatch(/host exited \(SIGKILL\) while 'kill_self'/);
    },
    SLOW,
  );

  it(
    'the next call respawns once the backoff has passed',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'crashy', dir: fixtureDir('crashy') });
      const before = h.pool.pidOf('crashy');
      await callTool(lease, 'exit_now');
      const early = await callTool(lease, 'ok');
      expect(early).toMatchObject({ ok: false, code: 'not_available' });
      expect(early.ok ? '' : early.error).toMatch(/restarting after a crash \(retry in 1s\)/);
      h.clock.ms += 1_000;
      expect(await callTool(lease, 'ok')).toEqual({ ok: true, value: 'ok' });
      expect(h.pool.pidOf('crashy')).not.toBe(before);
      // backoff_ms is the delay recordCrash chose (1 s, jitter 0 with random() = 0.5), not the respawn time.
      expect(eventsOf(h, 'plugin_host.restarted').map((e) => e.payload)).toEqual([
        { plugin_id: 'crashy', attempt: 1, backoff_ms: 1_000 },
      ]);
    },
    SLOW,
  );

  it(
    'registration drift marks the changed tool not_available and records an event',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'crashy', dir: fixtureDir('crashy') });
      await callTool(lease, 'kill_self');
      h.clock.ms += 1_000;
      expect(await callTool(lease, 'ok')).toEqual({ ok: true, value: 'ok' });
      const drift = eventsOf(h, 'plugin_host.registration_drift');
      expect(drift[0]?.payload).toMatchObject({ plugin_id: 'crashy', changed: ['tool:counter'] });
      const counter = await callTool(lease, 'counter');
      expect(counter).toMatchObject({ ok: false, code: 'not_available' });
      expect(lease.isToolAvailable('counter')).toBe(false);
      expect(lease.isToolAvailable('ok')).toBe(true);
    },
    SLOW,
  );
});

describe('backoff and circuit', () => {
  it('backoff is 1/2/4 s doubling, capped at 60 s, with +/-20% jitter', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelay(n, mid))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
    expect(backoffDelay(1, () => 0)).toBe(800);
    expect(backoffDelay(1, () => 1)).toBe(1_200);
    expect(backoffDelay(3, () => 0)).toBe(3_200);
    expect(backoffDelay(9, () => 1)).toBe(72_000);
  });

  it(
    'consecutive crashes wait 1 s, then 2 s, then 4 s before a restart',
    async () => {
      h = await makeHarness({ mockMode: 'ok' });
      const lease = await h.pool.acquire({ id: 'm', dir: '/unused' });
      for (const [wait, text] of [
        [1, '1s'],
        [2, '2s'],
        [4, '4s'],
      ] as const) {
        const crashed = await callTool(lease, 't', { die: true });
        expect(crashed).toMatchObject({ ok: false, code: 'execution_failed' });
        const early = await callTool(lease, 't');
        expect(early.ok ? '' : early.error).toContain(`retry in ${text}`);
        h.clock.ms += wait * 1_000 - 1;
        expect(await callTool(lease, 't')).toMatchObject({ ok: false, code: 'not_available' });
        h.clock.ms += 1;
        expect(await callTool(lease, 't')).toEqual({ ok: true, value: 'mock-ok' });
      }
    },
    SLOW,
  );

  it(
    '5 crashes in 10 minutes open the circuit and calls fail fast with not_available',
    async () => {
      h = await makeHarness({ mockMode: 'ok' });
      const lease = await h.pool.acquire({ id: 'm', dir: '/unused' });
      for (let i = 0; i < 5; i++) {
        await callTool(lease, 't', { die: true });
        if (i < 4) h.clock.ms += 70_000;
      }
      expect(eventsOf(h, 'plugin_host.circuit_open')).toHaveLength(1);
      const started = Date.now();
      const blocked = await callTool(lease, 't');
      expect(blocked).toEqual({
        ok: false,
        code: 'not_available',
        error: 'plugin host disabled after repeated crashes',
      });
      expect(Date.now() - started).toBeLessThan(100);
      expect(lease.isToolAvailable('t')).toBe(false);
      h.clock.ms += 30 * 60_000;
      expect(await callTool(lease, 't')).toEqual({ ok: true, value: 'mock-ok' });
    },
    SLOW,
  );

  it(
    'crashes spread over more than 10 minutes never open the circuit',
    async () => {
      h = await makeHarness({ mockMode: 'ok' });
      const lease = await h.pool.acquire({ id: 'm', dir: '/unused' });
      for (let i = 0; i < 6; i++) {
        await callTool(lease, 't', { die: true });
        h.clock.ms += 3 * 60_000;
      }
      expect(eventsOf(h, 'plugin_host.circuit_open')).toHaveLength(0);
    },
    SLOW,
  );
});

describe('health and cancel', () => {
  it(
    'a missed ping kills the host (SIGKILL) and the next call restarts it',
    async () => {
      h = await makeHarness({ mockMode: 'noping', pingIntervalMs: 50, pingTimeoutMs: 100 });
      const lease = await h.pool.acquire({ id: 'm', dir: '/unused' });
      const pid = h.pool.pidOf('m');
      await waitFor(() => eventsOf(h as Harness, 'plugin_host.crashed').length > 0);
      expect(eventsOf(h, 'plugin_host.crashed')[0]?.payload).toMatchObject({ signal: 'SIGKILL' });
      expect(isAlive(pid)).toBe(false);
      h.clock.ms += 1_000;
      expect(await callTool(lease, 't')).toEqual({ ok: true, value: 'mock-ok' });
      expect(h.pool.pidOf('m')).not.toBe(pid);
    },
    SLOW,
  );

  it(
    'a ping refreshes the availability snapshot',
    async () => {
      h = await makeHarness({ pingIntervalMs: 50 });
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      expect(lease.isToolAvailable('echo')).toBe(true);
      expect(lease.isToolAvailable('echo_unavailable')).toBe(false);
      h.pool.entry('echo')?.toolAvailable.set('echo', false);
      await waitFor(() => lease.isToolAvailable('echo'));
    },
    SLOW,
  );

  it(
    'an honored cancel returns the host answer without killing the host',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'slow', dir: fixtureDir('slow') });
      const ac = new AbortController();
      const pending = callTool(lease, 'sleep', { ms: 20_000 }, ac.signal);
      setTimeout(() => ac.abort(), 100);
      expect(await pending).toEqual({
        ok: false,
        code: 'execution_failed',
        error: 'stopped by abort',
      });
      expect(eventsOf(h, 'plugin_host.crashed')).toHaveLength(0);
      expect(await callTool(lease, 'sleep', { ms: 10 })).toEqual({ ok: true, value: 'slept' });
    },
    SLOW,
  );

  it(
    'an ignored cancel resolves as aborted after the grace, and a second one kills the host',
    async () => {
      h = await makeHarness({ mockMode: 'ok', cancelGraceMs: 100 });
      const lease = await h.pool.acquire({ id: 'm', dir: '/unused' });
      const abortAfterStart = async () => {
        const ac = new AbortController();
        const pending = callTool(lease, 't', { hang: true }, ac.signal);
        setTimeout(() => ac.abort(), 30);
        return pending;
      };
      const first = await abortAfterStart();
      expect(first).toMatchObject({ ok: false, code: 'execution_failed' });
      expect(first.ok ? '' : first.error).toMatch(/^Aborted .*did not stop 't' within 100 ms/);
      expect(eventsOf(h, 'plugin_host.crashed')).toHaveLength(0);
      await abortAfterStart();
      await waitFor(() => eventsOf(h as Harness, 'plugin_host.crashed').length > 0);
      expect(eventsOf(h, 'plugin_host.crashed')[0]?.payload).toMatchObject({ signal: 'SIGKILL' });
    },
    SLOW,
  );
});

describe('dispose and lifetime', () => {
  it(
    'dispose is memoised, escalates to SIGKILL on the process group, and finishes within 3 s',
    async () => {
      h = await makeHarness({ mockMode: 'stubborn' });
      await h.pool.acquire({ id: 'm', dir: '/unused' });
      const pid = h.pool.pidOf('m');
      expect(isAlive(pid)).toBe(true);
      const started = Date.now();
      const first = h.pool.dispose();
      expect(h.pool.dispose()).toBe(first);
      await first;
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(isAlive(pid)).toBe(false);
      await h.pool.dispose();
      expect(eventsOf(h, 'plugin_host.stopped')).toHaveLength(1);
      await expect(h.pool.acquire({ id: 'm2', dir: '/unused' })).rejects.toBeInstanceOf(
        HostUnavailableError,
      );
    },
    SLOW,
  );

  it('a cooperative host stops on ethos/shutdown without being signalled', async () => {
    h = await makeHarness({ mockMode: 'ok' });
    await h.pool.acquire({ id: 'm', dir: '/unused' });
    const pid = h.pool.pidOf('m');
    const started = Date.now();
    await h.pool.dispose();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(isAlive(pid)).toBe(false);
  });

  it('a lease release does not stop the host; only pool dispose does', async () => {
    h = await makeHarness({ mockMode: 'ok' });
    const lease = await h.pool.acquire({ id: 'm', dir: '/unused' });
    const pid = h.pool.pidOf('m');
    lease.release();
    lease.release();
    expect(h.pool.leasesOf('m')).toBe(0);
    expect(isAlive(pid)).toBe(true);
    expect(await callTool(lease, 't')).toEqual({ ok: true, value: 'mock-ok' });
    await h.pool.dispose();
    expect(isAlive(pid)).toBe(false);
  });

  it(
    'a parent stdin EOF makes the child exit',
    async () => {
      const entry = new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', defaultLaunchArgs(CHILD_ENTRY)[1] ?? 'tsx', CHILD_ENTRY],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              PATH: process.env.PATH ?? '',
              TSX_TSCONFIG_PATH: `${process.cwd()}/tsconfig.json`,
            },
          },
        );
        child.on('error', reject);
        child.on('exit', (code) => resolve(code));
        child.stdout.once('data', () => child.stdin.end());
        setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
      });
      expect(await entry).toBe(0);
    },
    SLOW,
  );
});
