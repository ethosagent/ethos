import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  eventsOf,
  fixtureDir,
  type Harness,
  makeHarness,
  waitFor,
} from './helpers/harness';

// Plan §5.4.2 / D15: a host restarts on the next call, unless it holds monitors, routes or bus
// subscriptions, in which case it restarts at once on the backoff schedule.

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const SLOW = 40_000;

describe('holdsLongLived and eager restart', () => {
  it(
    'a host with a route is reported long-lived and restarts by itself after a crash',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'll', dir: fixtureDir('longlived') });
      expect(lease.holdsLongLived).toBe(true);
      const first = h.pool.pidOf('ll');
      expect(first).toBeDefined();
      process.kill(first ?? 0, 'SIGKILL');
      await waitFor(() => eventsOf(h as Harness, 'plugin_host.crashed').length === 1);
      // The backoff gate reads the injected clock; the restart timer itself is real.
      h.clock.ms += 10_000;
      await waitFor(() => eventsOf(h as Harness, 'plugin_host.restarted').length === 1, 15_000);
      expect(h.pool.pidOf('ll')).not.toBe(first);
      // Nothing called the plugin: the restart was eager.
      expect((await callTool(lease, 'll_pid')).ok).toBe(true);
    },
    SLOW,
  );

  it(
    'a host holding nothing long-lived stays down until the next call',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      expect(lease.holdsLongLived).toBe(false);
      process.kill(h.pool.pidOf('echo') ?? 0, 'SIGKILL');
      await waitFor(() => eventsOf(h as Harness, 'plugin_host.crashed').length === 1);
      h.clock.ms += 10_000;
      await new Promise((r) => setTimeout(r, 1_800));
      expect(h.pool.pidOf('echo')).toBeUndefined();
      expect(eventsOf(h, 'plugin_host.restarted')).toHaveLength(0);
      // The next call restarts it.
      expect((await callTool(lease, 'echo', { text: 'back' })).ok).toBe(true);
      expect(h.pool.pidOf('echo')).toBeDefined();
    },
    SLOW,
  );

  it(
    'a bus subscription made after activation flips the flag through ethos/long-lived',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      expect(lease.holdsLongLived).toBe(false);
      await callTool(lease, 'echo_subscribe');
      await waitFor(() => h?.pool.entry('echo')?.holdsLongLived === true);
    },
    SLOW,
  );
});
