// Standing intents with limits (plan personality-presence-and-initiative §5):
// expiry, cooldown and a fire budget that is ON by default, all enforced in
// `WatcherManager.dispatchChange`.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WATCHER_MAX_FIRES,
  effectiveMaxFires,
  MAX_AGENT_WATCHER_FIRES,
  MAX_WATCHERS_PER_OWNER,
  type WatcherCreateInput,
  WatcherManager,
  type WatcherRecord,
  type WatcherWakeEvent,
} from '../index';

const DIR = '/ethos/watchers';

let storage: InMemoryStorage;
let manager: WatcherManager;
let woken: WatcherWakeEvent[];
let version: number;

function wakeWatcher(overrides: Partial<WatcherCreateInput> = {}): WatcherCreateInput {
  return {
    id: 'standing',
    kind: 'file',
    target: '/watched/app.log',
    intervalSeconds: 60,
    onChange: { wake: { personalityId: 'ops' } },
    ...overrides,
  };
}

/** Write a new version of the watched file and tick — one real change. */
async function change(id = 'standing'): Promise<void> {
  version += 1;
  await storage.write('/watched/app.log', `v${version}`);
  await manager.tick(id);
}

beforeEach(async () => {
  storage = new InMemoryStorage();
  woken = [];
  version = 0;
  await storage.mkdir('/watched');
  await storage.write('/watched/app.log', 'v0');
  manager = new WatcherManager({
    storage,
    watchersDir: DIR,
    wake: async (event) => {
      woken.push(event);
    },
  });
});

describe('fire budget', () => {
  it('a watcher with maxFires: 2 wakes twice, then pauses on the third change', async () => {
    await manager.createWatcher(wakeWatcher({ limits: { maxFires: 2 } }));
    await manager.tick('standing'); // seed

    await change();
    await change();
    expect(woken).toHaveLength(2);
    expect((await manager.getWatcher('standing'))?.enabled).toBe(true);

    await change();
    expect(woken).toHaveLength(2);
    const record = await manager.getWatcher('standing');
    expect(record?.enabled).toBe(false);
    expect(record?.firesUsed).toBe(2);
    expect(record?.lastFiredAt).toEqual(expect.any(String));
    expect(record?.stopped?.reason).toContain('fire budget');
  });

  it('a change that neither wakes nor delivers costs nothing', async () => {
    // Foreign wake on an owned record is refused at fire time — no fire.
    await manager.createWatcher(
      wakeWatcher({
        limits: { maxFires: 1 },
        onChange: { wake: { personalityId: 'someone-else' } },
        owner: { personalityId: 'ops' },
      }),
    );
    await manager.tick('standing');
    await change();
    await change();
    const record = await manager.getWatcher('standing');
    expect(record?.firesUsed ?? 0).toBe(0);
    expect(record?.enabled).toBe(true);
  });

  it('an agent-owned watcher created without maxFires gets the default budget', async () => {
    const record = await manager.createWatcher(wakeWatcher({ owner: { personalityId: 'ops' } }));
    expect(DEFAULT_WATCHER_MAX_FIRES).toBe(20);
    expect(record.limits?.maxFires).toBe(DEFAULT_WATCHER_MAX_FIRES);
  });

  it('owned records written before limits existed load and get the default budget', async () => {
    const legacy = {
      id: 'legacy',
      kind: 'file',
      target: '/watched/app.log',
      intervalSeconds: 60,
      onChange: { wake: { personalityId: 'ops' } },
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      owner: { personalityId: 'ops' },
    };
    await storage.mkdir(DIR);
    await storage.write(`${DIR}/watchers.json`, JSON.stringify([legacy]));

    const loaded = await manager.getWatcher('legacy');
    expect(loaded).not.toBeNull();
    expect(effectiveMaxFires(loaded as WatcherRecord)).toBe(DEFAULT_WATCHER_MAX_FIRES);

    // The default is enforced, not only reported: a legacy record whose count
    // reached the default pauses on its next change.
    await storage.write(
      `${DIR}/watchers.json`,
      JSON.stringify([{ ...legacy, firesUsed: DEFAULT_WATCHER_MAX_FIRES }]),
    );
    await manager.tick('legacy'); // seed
    await change('legacy');
    expect(woken).toHaveLength(0);
    expect((await manager.getWatcher('legacy'))?.enabled).toBe(false);
  });

  it('only an operator (no owner) may set maxFires: 0 — unlimited', async () => {
    await expect(
      manager.createWatcher(
        wakeWatcher({ limits: { maxFires: 0 }, owner: { personalityId: 'ops' } }),
      ),
    ).rejects.toThrow('maxFires: 0');

    await manager.createWatcher(wakeWatcher({ limits: { maxFires: 0 } }));
    await storage.write(
      `${DIR}/watchers.json`,
      JSON.stringify([
        {
          ...(await manager.getWatcher('standing')),
          firesUsed: DEFAULT_WATCHER_MAX_FIRES + 5,
        },
      ]),
    );
    await manager.tick('standing');
    await change();
    expect(woken).toHaveLength(1);
    expect((await manager.getWatcher('standing'))?.enabled).toBe(true);
  });
});

describe('expiry', () => {
  it('a watcher past expiresAt never wakes, and is paused with the reason', async () => {
    await manager.createWatcher(
      wakeWatcher({ limits: { expiresAt: new Date(Date.now() - 60_000).toISOString() } }),
    );
    await manager.tick('standing');
    await change();
    expect(woken).toHaveLength(0);
    const record = await manager.getWatcher('standing');
    expect(record?.enabled).toBe(false);
    expect(record?.stopped?.reason).toContain('expired');
  });
});

describe('cooldown', () => {
  it('two changes inside the cooldown wake once, and only the wake is counted', async () => {
    await manager.createWatcher(wakeWatcher({ limits: { cooldownSeconds: 3600 } }));
    await manager.tick('standing');
    await change();
    await change();
    expect(woken).toHaveLength(1);
    const record = await manager.getWatcher('standing');
    expect(record?.firesUsed).toBe(1);
    expect(record?.enabled).toBe(true);
  });
});

describe('validation', () => {
  it('rejects malformed limits', async () => {
    await expect(
      manager.createWatcher(wakeWatcher({ limits: { expiresAt: 'tomorrow-ish' } })),
    ).rejects.toThrow('expiresAt');
    await expect(
      manager.createWatcher(wakeWatcher({ limits: { cooldownSeconds: -1 } })),
    ).rejects.toThrow('cooldownSeconds');
    await expect(manager.createWatcher(wakeWatcher({ limits: { maxFires: 1.5 } }))).rejects.toThrow(
      'maxFires',
    );
  });
});

// ---------------------------------------------------------------------------
// Review fix pass (C1b, C2, C3, C4, C5, C6, C7)
// ---------------------------------------------------------------------------

const legacyOwnerless = {
  id: 'legacy',
  kind: 'file',
  target: '/watched/app.log',
  intervalSeconds: 60,
  onChange: { wake: { personalityId: 'ops' } },
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('operator (owner-less) watchers keep the old unlimited behavior (C7)', () => {
  it('a legacy owner-less record past the default count is not paused', async () => {
    await storage.mkdir(DIR);
    await storage.write(
      `${DIR}/watchers.json`,
      JSON.stringify([{ ...legacyOwnerless, firesUsed: DEFAULT_WATCHER_MAX_FIRES }]),
    );
    expect(effectiveMaxFires((await manager.getWatcher('legacy')) as WatcherRecord)).toBe(0);
    await manager.tick('legacy'); // seed
    await change('legacy');
    expect(woken).toHaveLength(1);
    const record = await manager.getWatcher('legacy');
    expect(record?.enabled).toBe(true);
    expect(record?.firesUsed).toBe(DEFAULT_WATCHER_MAX_FIRES + 1);
  });

  it('an owner-less record with an explicit maxFires still honors it', async () => {
    await storage.mkdir(DIR);
    await storage.write(
      `${DIR}/watchers.json`,
      JSON.stringify([{ ...legacyOwnerless, limits: { maxFires: 1 }, firesUsed: 1 }]),
    );
    await manager.tick('legacy');
    expect((await manager.getWatcher('legacy'))?.enabled).toBe(false);
  });

  it('an operator watcher created with no limits is unlimited', async () => {
    const record = await manager.createWatcher(wakeWatcher());
    expect(effectiveMaxFires(record)).toBe(0);
  });
});

describe('agent fire budget ceiling (C2)', () => {
  it('an owned watcher may not carry more than MAX_AGENT_WATCHER_FIRES', async () => {
    const owner = { personalityId: 'ops' };
    await expect(
      manager.createWatcher(wakeWatcher({ owner, limits: { maxFires: 1e308 } })),
    ).rejects.toThrow(String(MAX_AGENT_WATCHER_FIRES));
    await expect(
      manager.createWatcher(
        wakeWatcher({ owner, limits: { maxFires: MAX_AGENT_WATCHER_FIRES + 1 } }),
      ),
    ).rejects.toThrow('maxFires');
    await manager.createWatcher(
      wakeWatcher({ owner, limits: { maxFires: MAX_AGENT_WATCHER_FIRES } }),
    );
    // Operator paths are unaffected.
    await manager.createWatcher(wakeWatcher({ id: 'op', limits: { maxFires: 10_000 } }));
  });
});

describe('per-owner active watcher cap (C1b)', () => {
  it('refuses a new owned watcher past MAX_WATCHERS_PER_OWNER active, and a resume past it', async () => {
    const owner = { personalityId: 'ops' };
    for (let i = 0; i < MAX_WATCHERS_PER_OWNER; i++) {
      await manager.createWatcher(wakeWatcher({ id: `w${i}`, owner }));
    }
    await expect(manager.createWatcher(wakeWatcher({ id: 'one-more', owner }))).rejects.toThrow(
      String(MAX_WATCHERS_PER_OWNER),
    );
    // Another owner and the operator are not counted against ops.
    await manager.createWatcher(wakeWatcher({ id: 'other', owner: { personalityId: 'eng' } }));
    await manager.createWatcher(wakeWatcher({ id: 'operator' }));

    // A paused watcher does not count; resuming it back over the cap is refused.
    await manager.pauseWatcher('w0');
    await manager.createWatcher(wakeWatcher({ id: 'replacement', owner }));
    await expect(manager.resumeWatcher('w0')).rejects.toThrow(String(MAX_WATCHERS_PER_OWNER));
    expect((await manager.getWatcher('w0'))?.enabled).toBe(false);
  });
});

describe('expiry and a spent budget are checked on every tick (C4)', () => {
  it('an expired watcher pauses on a tick with no change', async () => {
    await manager.createWatcher(
      wakeWatcher({ limits: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }),
    );
    await manager.tick('standing'); // seed, not yet expired
    await storage.write(
      `${DIR}/watchers.json`,
      JSON.stringify([
        {
          ...(await manager.getWatcher('standing')),
          limits: { expiresAt: new Date(Date.now() - 1_000).toISOString() },
        },
      ]),
    );
    await manager.tick('standing'); // no change on disk
    const record = await manager.getWatcher('standing');
    expect(record?.enabled).toBe(false);
    expect(record?.stopped?.reason).toContain('expired');
  });

  it('a spent budget pauses on a tick with no change, before the differ runs', async () => {
    let fetches = 0;
    manager = new WatcherManager({
      storage,
      watchersDir: DIR,
      wake: async () => true,
      fetchFn: (async () => {
        fetches += 1;
        return new Response('x');
      }) as typeof fetch,
    });
    await manager.createWatcher({
      id: 'spent',
      kind: 'http',
      target: 'https://example.test/',
      intervalSeconds: 60,
      onChange: { wake: { personalityId: 'ops' } },
      owner: { personalityId: 'ops' },
      limits: { maxFires: 1 },
    });
    const record = await manager.getWatcher('spent');
    await storage.write(`${DIR}/watchers.json`, JSON.stringify([{ ...record, firesUsed: 1 }]));
    await manager.tick('spent');
    expect(fetches).toBe(0);
    const after = await manager.getWatcher('spent');
    expect(after?.enabled).toBe(false);
    expect(after?.stopped?.reason).toContain('fire budget');
  });
});

describe('expiresAt is strict ISO-8601 with a zone (C5)', () => {
  it('refuses a human date and an offset-less date-time; accepts Z and an offset', async () => {
    await expect(
      manager.createWatcher(wakeWatcher({ limits: { expiresAt: 'October 1' } })),
    ).rejects.toThrow('expiresAt');
    await expect(
      manager.createWatcher(wakeWatcher({ limits: { expiresAt: '2099-10-01T09:00:00' } })),
    ).rejects.toThrow('expiresAt');
    await expect(
      manager.createWatcher(wakeWatcher({ limits: { expiresAt: '2099-10-01' } })),
    ).rejects.toThrow('expiresAt');
    await manager.createWatcher(
      wakeWatcher({ id: 'z', limits: { expiresAt: '2099-10-01T09:00:00Z' } }),
    );
    await manager.createWatcher(
      wakeWatcher({ id: 'off', limits: { expiresAt: '2099-10-01T09:00:00.000+05:30' } }),
    );
  });
});

describe('a wake that delivered nothing costs nothing (C6)', () => {
  it('counts only wakes the callback reports delivered', async () => {
    let deliverWake = false;
    manager = new WatcherManager({
      storage,
      watchersDir: DIR,
      wake: async (event) => {
        if (!deliverWake) return false;
        woken.push(event);
        return true;
      },
    });
    await manager.createWatcher(
      wakeWatcher({ owner: { personalityId: 'ops' }, limits: { maxFires: 2 } }),
    );
    await manager.tick('standing');
    await change();
    await change();
    expect((await manager.getWatcher('standing'))?.firesUsed ?? 0).toBe(0);
    deliverWake = true;
    await change();
    const record = await manager.getWatcher('standing');
    expect(record?.firesUsed).toBe(1);
    expect(record?.enabled).toBe(true);
  });
});

describe('watchers.json read-modify-writes are serialized (C3)', () => {
  it('concurrent creates all land', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => manager.createWatcher(wakeWatcher({ id: `c${i}` }))),
    );
    expect(await manager.listWatchers()).toHaveLength(8);
  });

  it('a pause racing a fire is not undone, and the fire is still counted', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    manager = new WatcherManager({
      storage,
      watchersDir: DIR,
      wake: async () => {
        await gate;
        return true;
      },
    });
    await manager.createWatcher(wakeWatcher({ owner: { personalityId: 'ops' } }));
    await manager.tick('standing');
    version += 1;
    await storage.write('/watched/app.log', `v${version}`);
    const ticking = manager.tick('standing');
    await new Promise((r) => setTimeout(r, 10));
    await manager.pauseWatcher('standing');
    release();
    await ticking;
    const record = await manager.getWatcher('standing');
    expect(record?.enabled).toBe(false);
    expect(record?.firesUsed).toBe(1);
  });

  it('two overlapping ticks of one change never exceed the budget', async () => {
    manager = new WatcherManager({
      storage,
      watchersDir: DIR,
      wake: async (event) => {
        woken.push(event);
        return true;
      },
    });
    await manager.createWatcher(
      wakeWatcher({ owner: { personalityId: 'ops' }, limits: { maxFires: 1 } }),
    );
    await manager.tick('standing');
    version += 1;
    await storage.write('/watched/app.log', `v${version}`);
    await Promise.all([manager.tick('standing'), manager.tick('standing')]);
    expect(woken.length).toBeLessThanOrEqual(1);
    expect((await manager.getWatcher('standing'))?.firesUsed).toBe(1);
  });
});
