import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  eventsOf,
  fixtureDir,
  type Harness,
  isAlive,
  makeHarness,
  waitFor,
} from './helpers/harness';

// Plan §5.4.3: a host with no monitors, routes or subscriptions and no in-flight call stops after
// plugins.host.idle_stop_minutes (0 = never) and respawns on the next call. The clock is injected
// (`now`); only the check interval is real time.

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const SLOW = 40_000;
const MIN = 60_000;
const idleOpts = { idleStopMinutes: 1, idleCheckIntervalMs: 40, statsIntervalMs: 0 } as const;
const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stoppedIdle = (hh: Harness) =>
  eventsOf(hh, 'plugin_host.stopped').filter((e) => e.payload.reason === 'idle');

describe('idle stop', () => {
  it(
    'stops after idle_stop_minutes and records plugin_host.stopped {reason: idle}',
    async () => {
      h = await makeHarness(idleOpts);
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      await callTool(lease, 'echo', { text: 'x' });
      const pid = h.pool.pidOf('echo');
      h.clock.ms += 30_000;
      await settle();
      expect(isAlive(pid)).toBe(true);
      expect(stoppedIdle(h)).toHaveLength(0);
      h.clock.ms += 31_000;
      await waitFor(() => stoppedIdle(h as Harness).length === 1);
      expect(stoppedIdle(h)[0]?.payload).toMatchObject({ plugin_id: 'echo', reason: 'idle' });
      expect(isAlive(pid)).toBe(false);
      expect(h.pool.pidOf('echo')).toBeUndefined();
    },
    SLOW,
  );

  it(
    '0 means never',
    async () => {
      h = await makeHarness({ ...idleOpts, idleStopMinutes: 0 });
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      await callTool(lease, 'echo', { text: 'x' });
      h.clock.ms += 600 * MIN;
      await settle();
      expect(h.pool.pidOf('echo')).toBeDefined();
      expect(stoppedIdle(h)).toHaveLength(0);
    },
    SLOW,
  );

  it(
    'an in-flight call prevents the stop; the host idles only after it has finished',
    async () => {
      h = await makeHarness(idleOpts);
      const lease = await h.pool.acquire({ id: 'slow', dir: fixtureDir('slow') });
      const pid = h.pool.pidOf('slow');
      const call = callTool(lease, 'sleep', { ms: 1_500 });
      await settle(100);
      h.clock.ms += 5 * MIN;
      await settle();
      expect(isAlive(pid)).toBe(true);
      expect(stoppedIdle(h)).toHaveLength(0);
      expect(await call).toEqual({ ok: true, value: 'slept' });
      // The finished call counts as activity: the idle period starts over.
      await settle();
      expect(stoppedIdle(h)).toHaveLength(0);
      h.clock.ms += 2 * MIN;
      await waitFor(() => stoppedIdle(h as Harness).length === 1);
    },
    SLOW,
  );

  it(
    'a host holding something long-lived never idles',
    async () => {
      h = await makeHarness(idleOpts);
      await h.pool.acquire({ id: 'll', dir: fixtureDir('longlived') });
      h.clock.ms += 60 * MIN;
      await settle();
      expect(h.pool.pidOf('ll')).toBeDefined();
      expect(stoppedIdle(h)).toHaveLength(0);
    },
    SLOW,
  );

  it(
    'a bus subscription made after activation also stops it idling',
    async () => {
      h = await makeHarness(idleOpts);
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      await callTool(lease, 'echo_subscribe');
      await waitFor(() => h?.pool.entry('echo')?.holdsLongLived === true);
      h.clock.ms += 60 * MIN;
      await settle();
      expect(stoppedIdle(h)).toHaveLength(0);
    },
    SLOW,
  );

  it(
    'the next call respawns transparently: not a crash, no backoff, no circuit',
    async () => {
      h = await makeHarness(idleOpts);
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      const first = h.pool.pidOf('echo');
      for (let cycle = 0; cycle < 6; cycle++) {
        h.clock.ms += 2 * MIN;
        await waitFor(() => stoppedIdle(h as Harness).length === cycle + 1);
        // No clock advance for a backoff: an idle stop leaves no gate behind.
        expect(await callTool(lease, 'echo', { text: `n${cycle}` })).toEqual({
          ok: true,
          value: `n${cycle}`,
        });
      }
      expect(h.pool.pidOf('echo')).not.toBe(first);
      expect(eventsOf(h, 'plugin_host.crashed')).toHaveLength(0);
      expect(eventsOf(h, 'plugin_host.restarted')).toHaveLength(0);
      expect(eventsOf(h, 'plugin_host.circuit_open')).toHaveLength(0);
      expect(eventsOf(h, 'plugin_host.spawned')).toHaveLength(7);
      expect(h.pool.entry('echo')?.stats.restarts).toBe(0);
    },
    SLOW,
  );

  it(
    'a void hook fired on an idle-stopped host respawns it and is delivered',
    async () => {
      h = await makeHarness(idleOpts);
      const lease = await h.pool.acquire({ id: 'hooks', dir: fixtureDir('hooks') });
      h.clock.ms += 2 * MIN;
      await waitFor(() => stoppedIdle(h as Harness).length === 1);
      lease.fireVoid('agent_done', { text: 'after-idle' });
      await waitFor(() => h?.pool.pidOf('hooks') !== undefined);
      const seen = await (async () => {
        for (let i = 0; i < 50; i++) {
          const r = await callTool(lease, 'hook_log');
          if (r.ok && r.value.includes('after-idle')) return r.value;
          await settle(50);
        }
        return '';
      })();
      expect(seen).toContain('after-idle');
      expect(h.pool.entry('hooks')?.stats.droppedVoid).toBe(0);
    },
    SLOW,
  );

  it(
    'dispose during an idle stop does not resurrect the host',
    async () => {
      h = await makeHarness(idleOpts);
      await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      h.clock.ms += 2 * MIN;
      await waitFor(() => stoppedIdle(h as Harness).length === 1);
      await h.pool.dispose();
      expect(h.pool.pidOf('echo')).toBeUndefined();
    },
    SLOW,
  );
});
