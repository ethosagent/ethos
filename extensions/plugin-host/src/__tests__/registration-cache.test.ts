import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginHostPool, type PluginHostPoolOptions } from '../pool';
import { PROTOCOL_VERSION, type Registration } from '../protocol';
import {
  computeCacheKey,
  mustSpawnEagerly,
  readRegistrationCache,
  writeRegistrationCache,
} from '../registration-cache';
import {
  CHILD_ENTRY,
  callTool,
  eventsOf,
  fixtureDir,
  type Harness,
  makeHarness,
  waitFor,
} from './helpers/harness';

// Plan §5.4.3 (Part 7): a matching registrations cache registers proxies with no spawn; the first
// call spawns, activates and compares (the drift rule of §5.4.2) and rewrites the cache.

let h: Harness | undefined;
const extra: PluginHostPool[] = [];
afterEach(async () => {
  await Promise.all(extra.splice(0).map((p) => p.dispose()));
  await h?.cleanup();
  h = undefined;
});

const SLOW = 40_000;

const spec = (id: string, fixture: string, more: Record<string, string> = {}) => ({
  id,
  dir: fixtureDir(fixture),
  ...more,
});

const cachePath = (hh: Harness, id: string): string =>
  join(hh.dataDir, 'plugin-hosts', id, 'registrations.json');

/** A second pool over the same data dir: what the next process boot would build. */
function nextBoot(hh: Harness, opts: Partial<PluginHostPoolOptions> = {}): PluginHostPool {
  const pool = new PluginHostPool({
    storage: new FsStorage(),
    dataDir: hh.dataDir,
    childEntry: CHILD_ENTRY,
    onEvent: (category, payload) => hh.events.push({ category, payload }),
    now: () => hh.clock.ms,
    random: () => 0.5,
    statsIntervalMs: 0,
    ...opts,
  });
  extra.push(pool);
  return pool;
}

/** First boot: activates for real and leaves the cache behind; events are cleared afterwards. */
async function seed(hh: Harness, s: ReturnType<typeof spec>): Promise<void> {
  await hh.pool.acquire(s);
  await hh.pool.dispose();
  hh.events.length = 0;
}

const activations = async (hh: Harness, id: string): Promise<number> => {
  try {
    return (await readFile(join(hh.dataDir, 'plugin-hosts', id, 'home', 'activations.log'), 'utf8'))
      .length;
  } catch {
    return 0;
  }
};

describe('registration cache across boots', () => {
  it(
    'writes the cache after the first activation, keyed by id, version, integrity and protocol',
    async () => {
      h = await makeHarness();
      await seed(h, spec('echo', 'echo', { version: '1.0.0', integrity: 'sha512-aaa' }));
      const raw = JSON.parse(await readFile(cachePath(h, 'echo'), 'utf8'));
      expect(raw.key).toEqual({
        id: 'echo',
        version: '1.0.0',
        integrity: 'lock:sha512-aaa',
        protocolVersion: PROTOCOL_VERSION,
      });
      expect(raw.holdsLongLived).toBe(false);
      expect(raw.registrations.map((r: Registration) => r.kind === 'tool' && r.name)).toContain(
        'echo',
      );
    },
    SLOW,
  );

  it(
    'a cache hit registers proxies with no spawn; the first call spawns, activates and works',
    async () => {
      h = await makeHarness();
      await seed(h, spec('echo', 'echo'));
      expect(await activations(h, 'echo')).toBe(1);

      const pool = nextBoot(h);
      const lease = await pool.acquire(spec('echo', 'echo'));
      expect(lease.registrations.some((r) => r.kind === 'tool' && r.name === 'echo')).toBe(true);
      expect(lease.isToolAvailable('echo')).toBe(true);
      expect(pool.pidOf('echo')).toBeUndefined();
      expect(eventsOf(h, 'plugin_host.spawned')).toHaveLength(0);
      expect(await activations(h, 'echo')).toBe(1);

      expect(await callTool(lease, 'echo', { text: 'hi' })).toEqual({ ok: true, value: 'hi' });
      expect(pool.pidOf('echo')).toBeDefined();
      expect(eventsOf(h, 'plugin_host.spawned')).toHaveLength(1);
      expect(await activations(h, 'echo')).toBe(2);
      // A faithful cache is not drift, and a lazy start is not a crash restart.
      expect(eventsOf(h, 'plugin_host.registration_drift')).toHaveLength(0);
      expect(eventsOf(h, 'plugin_host.restarted')).toHaveLength(0);
      expect(eventsOf(h, 'plugin_host.crashed')).toHaveLength(0);
    },
    SLOW,
  );

  it(
    'a hook fired on a cold cached host starts it and sees the plugin',
    async () => {
      h = await makeHarness();
      await seed(h, spec('hooks', 'hooks'));
      const pool = nextBoot(h);
      const lease = await pool.acquire(spec('hooks', 'hooks'));
      expect(pool.pidOf('hooks')).toBeUndefined();
      const out = await lease.fireModifying('before_prompt_build', {});
      expect(out).not.toBeNull();
      expect(pool.pidOf('hooks')).toBeDefined();

      lease.fireVoid('agent_done', { text: 'late' });
      await waitFor(() => lease.isToolAvailable('hook_log'));
      const seen = await callTool(lease, 'hook_log');
      expect(seen.ok ? seen.value : '').toContain('late');
    },
    SLOW,
  );

  it(
    'drift after a cache hit: changed tool is not_available, an event is recorded, the cache is rewritten',
    async () => {
      h = await makeHarness();
      await seed(h, spec('echo', 'echo'));
      const stale = JSON.parse(await readFile(cachePath(h, 'echo'), 'utf8'));
      for (const r of stale.registrations) {
        if (r.kind === 'tool' && r.name === 'echo') r.description = 'an older description';
      }
      await writeFile(cachePath(h, 'echo'), JSON.stringify(stale));

      const pool = nextBoot(h);
      const lease = await pool.acquire(spec('echo', 'echo'));
      expect(pool.pidOf('echo')).toBeUndefined();
      expect(await callTool(lease, 'echo_pid')).toMatchObject({ ok: true });
      const drift = eventsOf(h, 'plugin_host.registration_drift');
      expect(drift[0]?.payload).toMatchObject({ plugin_id: 'echo', changed: ['tool:echo'] });
      expect(await callTool(lease, 'echo', { text: 'x' })).toMatchObject({
        ok: false,
        code: 'not_available',
      });
      expect(lease.isToolAvailable('echo')).toBe(false);
      expect(lease.isToolAvailable('echo_pid')).toBe(true);

      await pool.dispose(); // flushes the cache write
      const fresh = JSON.parse(await readFile(cachePath(h, 'echo'), 'utf8'));
      const echo = fresh.registrations.find(
        (r: Registration) => r.kind === 'tool' && r.name === 'echo',
      );
      expect(echo.description).toBe('Echo the text argument');

      // The next boot is faithful again: no drift.
      h.events.length = 0;
      const again = nextBoot(h);
      const lease2 = await again.acquire(spec('echo', 'echo'));
      expect(await callTool(lease2, 'echo', { text: 'ok' })).toEqual({ ok: true, value: 'ok' });
      expect(eventsOf(h, 'plugin_host.registration_drift')).toHaveLength(0);
    },
    SLOW,
  );

  it(
    'a corrupt cache is a miss: the plugin spawns normally and the cache is rewritten',
    async () => {
      h = await makeHarness();
      await seed(h, spec('echo', 'echo'));
      await writeFile(cachePath(h, 'echo'), '{ not json');
      const pool = nextBoot(h);
      const lease = await pool.acquire(spec('echo', 'echo'));
      expect(pool.pidOf('echo')).toBeDefined();
      expect(await callTool(lease, 'echo', { text: 'a' })).toEqual({ ok: true, value: 'a' });
      await pool.dispose();
      expect(JSON.parse(await readFile(cachePath(h, 'echo'), 'utf8')).key.id).toBe('echo');
    },
    SLOW,
  );

  it(
    'a cache with an unparseable registration is a miss',
    async () => {
      h = await makeHarness();
      await seed(h, spec('echo', 'echo'));
      const bad = JSON.parse(await readFile(cachePath(h, 'echo'), 'utf8'));
      bad.registrations.push({ kind: 'tool' });
      await writeFile(cachePath(h, 'echo'), JSON.stringify(bad));
      const pool = nextBoot(h);
      await pool.acquire(spec('echo', 'echo'));
      expect(pool.pidOf('echo')).toBeDefined();
    },
    SLOW,
  );

  it(
    'a version change is a miss; so is an integrity change; the same key is a hit',
    async () => {
      h = await makeHarness();
      await seed(h, spec('echo', 'echo', { version: '1.0.0', integrity: 'sha512-aaa' }));

      const bumped = nextBoot(h);
      await bumped.acquire(spec('echo', 'echo', { version: '1.0.1', integrity: 'sha512-aaa' }));
      expect(bumped.pidOf('echo')).toBeDefined();
      await bumped.dispose();

      const reinstalled = nextBoot(h);
      await reinstalled.acquire(
        spec('echo', 'echo', { version: '1.0.1', integrity: 'sha512-bbb' }),
      );
      expect(reinstalled.pidOf('echo')).toBeDefined();
      await reinstalled.dispose();

      const same = nextBoot(h);
      await same.acquire(spec('echo', 'echo', { version: '1.0.1', integrity: 'sha512-bbb' }));
      expect(same.pidOf('echo')).toBeUndefined();
    },
    SLOW,
  );

  it(
    'a different set of secret key names is a miss, so a newly added key cannot leave a tool hidden',
    async () => {
      h = await makeHarness();
      await seed(h, spec('echo', 'echo'));
      const pool = nextBoot(h);
      await pool.acquire({ ...spec('echo', 'echo'), secretKeys: ['api_key'] });
      expect(pool.pidOf('echo')).toBeDefined();
    },
    SLOW,
  );

  it(
    'a host with a route spawns eagerly even with a matching cache',
    async () => {
      h = await makeHarness();
      await seed(h, spec('ll', 'longlived'));
      const pool = nextBoot(h);
      await pool.acquire(spec('ll', 'longlived'));
      expect(pool.pidOf('ll')).toBeDefined();
    },
    SLOW,
  );

  it(
    'a bus subscription made after activation is persisted, so the next boot spawns eagerly',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire(spec('echo', 'echo'));
      await callTool(lease, 'echo_subscribe');
      await waitFor(() => h?.pool.entry('echo')?.holdsLongLived === true);
      await h.pool.dispose();
      expect(JSON.parse(await readFile(cachePath(h, 'echo'), 'utf8')).holdsLongLived).toBe(true);
      const pool = nextBoot(h);
      await pool.acquire(spec('echo', 'echo'));
      expect(pool.pidOf('echo')).toBeDefined();
    },
    SLOW,
  );
});

describe('registration cache primitives', () => {
  const tool = (available: boolean): Registration => ({
    kind: 'tool',
    name: 't',
    description: 'd',
    schema: {},
    capabilities: {},
    available,
  });

  it('mustSpawnEagerly: long-lived or a route; an unavailable tool alone is deferrable', () => {
    expect(mustSpawnEagerly({ registrations: [tool(true)], holdsLongLived: false })).toBe(false);
    expect(mustSpawnEagerly({ registrations: [tool(true)], holdsLongLived: true })).toBe(true);
    expect(mustSpawnEagerly({ registrations: [tool(false)], holdsLongLived: false })).toBe(false);
    expect(
      mustSpawnEagerly({
        registrations: [{ kind: 'route', index: 0, method: 'POST', path: '/x' }],
        holdsLongLived: false,
      }),
    ).toBe(true);
  });

  it('computeCacheKey: a plugin with no lock integrity and no entry mtime is never cached', async () => {
    const storage = new InMemoryStorage();
    expect(await computeCacheKey(storage, { id: 'p', dir: '/nowhere' })).toBeUndefined();
    expect(await computeCacheKey(storage, { id: 'p', dir: '/nowhere', integrity: 'i' })).toEqual({
      id: 'p',
      version: '',
      integrity: 'lock:i',
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it('readRegistrationCache never throws: missing, non-object and a throwing storage are misses', async () => {
    const storage = new InMemoryStorage();
    const key = { id: 'p', version: '1', integrity: 'lock:i', protocolVersion: PROTOCOL_VERSION };
    expect(await readRegistrationCache(storage, '/c/r.json', key, [])).toBeUndefined();
    await storage.mkdir('/c');
    await storage.write('/c/r.json', '[]');
    expect(await readRegistrationCache(storage, '/c/r.json', key, [])).toBeUndefined();
    expect(
      await writeRegistrationCache(storage, '/c/r.json', {
        key,
        registrations: [],
        holdsLongLived: false,
        secretKeys: [],
      }),
    ).toBe(true);
    expect(await readRegistrationCache(storage, '/c/r.json', key, [])).toMatchObject({
      registrations: [],
    });
    expect(
      await readRegistrationCache(
        storage,
        '/c/r.json',
        { ...key, protocolVersion: PROTOCOL_VERSION + 1 },
        [],
      ),
    ).toBeUndefined();
    const broken = {
      ...storage,
      read: () => Promise.reject(new Error('io')),
    } as unknown as InMemoryStorage;
    expect(await readRegistrationCache(broken, '/c/r.json', key, [])).toBeUndefined();
  });
});
