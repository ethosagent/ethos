import type { AgentLoop } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { type TeamLoopHandle, TeamLoopRegistry, type TeamMembership } from '../team-loops';

// The registry is pure bookkeeping over an injected factory, so the loops are
// opaque sentinels — nothing here runs a turn.

function fakeLoop(name: string): AgentLoop {
  return { name } as unknown as AgentLoop;
}

const TEAMS: TeamMembership[] = [
  { name: 'alpha', members: ['coordinator', 'writer'], coordinator: 'coordinator' },
  { name: 'research', members: ['writer', 'analyst'], coordinator: null },
];

function makeRegistry(overrides: Partial<ConstructorParameters<typeof TeamLoopRegistry>[0]> = {}) {
  let builds = 0;
  let lists = 0;
  const registry = new TeamLoopRegistry({
    factory: async (teamName) => {
      builds++;
      return { loop: fakeLoop(teamName) };
    },
    listTeams: async () => {
      lists++;
      return TEAMS;
    },
    ...overrides,
  });
  return { registry, builds: () => builds, lists: () => lists };
}

describe('TeamLoopRegistry.loopFor', () => {
  it('builds a team loop once and memoises it', async () => {
    const { registry, builds } = makeRegistry();
    const first = await registry.loopFor('alpha');
    const second = await registry.loopFor('alpha');
    expect(second).toBe(first);
    expect(builds()).toBe(1);
  });

  it('is single-flight: concurrent callers share one build', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let builds = 0;
    const registry = new TeamLoopRegistry({
      factory: async (teamName) => {
        builds++;
        await gate;
        return { loop: fakeLoop(teamName) };
      },
      listTeams: async () => TEAMS,
    });
    const a = registry.loopFor('alpha');
    const b = registry.loopFor('alpha');
    release?.();
    const [ha, hb] = await Promise.all([a, b]);
    expect(ha).toBe(hb);
    expect(builds).toBe(1);
  });

  it('keeps one loop per team and calls onCreate once per built loop', async () => {
    const created: string[] = [];
    const { registry, builds } = makeRegistry({
      onCreate: (teamName) => {
        created.push(teamName);
      },
    });
    const alpha = await registry.loopFor('alpha');
    const research = await registry.loopFor('research');
    await registry.loopFor('alpha');
    expect(alpha).not.toBe(research);
    expect(builds()).toBe(2);
    expect(created).toEqual(['alpha', 'research']);
  });

  it('does not poison the slot when a build fails — the next call retries', async () => {
    let attempts = 0;
    const registry = new TeamLoopRegistry({
      factory: async (teamName) => {
        attempts++;
        if (attempts === 1) throw new Error('manifest broken');
        return { loop: fakeLoop(teamName) };
      },
      listTeams: async () => TEAMS,
    });
    await expect(registry.loopFor('alpha')).rejects.toThrow('manifest broken');
    const handle = await registry.loopFor('alpha');
    expect(handle.loop).toBeDefined();
    expect(attempts).toBe(2);
  });
});

describe('TeamLoopRegistry.teamFor', () => {
  it('resolves members and coordinators to the first team in manifest order', async () => {
    const { registry } = makeRegistry();
    expect(await registry.teamFor('coordinator')).toBe('alpha');
    // `writer` is on both teams — manifest order wins.
    expect(await registry.teamFor('writer')).toBe('alpha');
    expect(await registry.teamFor('analyst')).toBe('research');
  });

  it('resolves an independent personality to null', async () => {
    const { registry } = makeRegistry();
    expect(await registry.teamFor('researcher')).toBeNull();
  });

  it('skips the team the main loop already runs as', async () => {
    const { registry } = makeRegistry({ mainLoopTeam: 'alpha' });
    expect(await registry.teamFor('coordinator')).toBeNull();
    // Still a member of the second team, which the registry does own.
    expect(await registry.teamFor('writer')).toBe('research');
  });

  it('caches membership for the TTL and re-reads after it or on invalidate()', async () => {
    let clock = 0;
    const { registry, lists } = makeRegistry({ membershipTtlMs: 5_000, now: () => clock });
    await registry.teamFor('coordinator');
    await registry.teamFor('writer');
    expect(lists()).toBe(1);

    clock = 4_999;
    await registry.teamFor('coordinator');
    expect(lists()).toBe(1);

    clock = 5_000;
    await registry.teamFor('coordinator');
    expect(lists()).toBe(2);

    registry.invalidate();
    await registry.teamFor('coordinator');
    expect(lists()).toBe(3);
  });

  it('shares one in-flight membership read between concurrent callers', async () => {
    const { registry, lists } = makeRegistry();
    await Promise.all([registry.teamFor('coordinator'), registry.teamFor('analyst')]);
    expect(lists()).toBe(1);
  });
});

describe('TeamLoopRegistry.handleFor', () => {
  it('returns the team handle for a member and null for an independent personality', async () => {
    const { registry } = makeRegistry();
    const handle = await registry.handleFor('writer');
    expect(handle?.loop).toBe((await registry.loopFor('alpha')).loop);
    expect(await registry.handleFor('researcher')).toBeNull();
  });
});

describe('TeamLoopRegistry.disposeAll', () => {
  it('disposes every built handle and forgets it', async () => {
    const disposed: string[] = [];
    let builds = 0;
    const { registry } = makeRegistry({
      factory: async (teamName): Promise<TeamLoopHandle> => {
        builds++;
        return {
          loop: fakeLoop(teamName),
          dispose: async () => {
            disposed.push(teamName);
          },
        };
      },
    });
    await registry.loopFor('alpha');
    await registry.loopFor('research');
    await registry.disposeAll();
    expect(disposed.sort()).toEqual(['alpha', 'research']);
    expect(builds).toBe(2);
    // Terminal (F06): disposeAll is the owning surface's shutdown, so a
    // request that arrives afterwards builds nothing to leak.
    await expect(registry.loopFor('alpha')).rejects.toThrow(/after dispose/);
    expect(builds).toBe(2);
  });
});

// F06 follow-up — a lazy team-loop build that races the web API's dispose.
describe('TeamLoopRegistry lifetime (F06)', () => {
  it('disposes a freshly built handle whose onCreate throws, instead of losing it', async () => {
    let disposed = 0;
    const registry = new TeamLoopRegistry({
      factory: async (teamName) => ({
        loop: fakeLoop(teamName),
        dispose: async () => {
          disposed++;
        },
      }),
      listTeams: async () => TEAMS,
      onCreate: () => {
        throw new Error('cannot register cleanup: this runtime is already disposed');
      },
    });
    await expect(registry.loopFor('alpha')).rejects.toThrow(/already disposed/);
    expect(disposed).toBe(1);
  });

  it('builds nothing once disposed', async () => {
    const { registry, builds } = makeRegistry();
    await registry.disposeAll();
    await expect(registry.loopFor('alpha')).rejects.toThrow(/after dispose/);
    expect(builds()).toBe(0);
  });

  it('disposes a build that was still in flight when disposeAll ran', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let disposed = 0;
    const registry = new TeamLoopRegistry({
      factory: async (teamName) => {
        await gate;
        return {
          loop: fakeLoop(teamName),
          dispose: async () => {
            disposed++;
          },
        };
      },
      listTeams: async () => TEAMS,
    });
    const building = registry.loopFor('alpha');
    const disposing = registry.disposeAll();
    release?.();
    await disposing;
    await building.catch(() => {});
    expect(disposed).toBe(1);
  });
});
