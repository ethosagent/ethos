import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryError } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAlwaysDeny } from '../default-deny';
import { InMemoryStorage } from '../in-memory-storage';
import { ScopedStorage } from '../scoped-storage';
import { ethosStateDirs, personalityDefinitionFloor, sensitiveDenyPaths } from '../sensitive-paths';

// PST-001 (plan openclaw-2026.9.6-gaps): the always-deny floor covered only
// `keys.json` and `secrets/` under the state dir, while `process.cwd()` is in a
// personality's default read/write reach. A personality launched from `~` could
// then read `sessions.db` (every personality's transcript) or rewrite `mcp.json`
// (an MCP server is a process the next boot spawns).
describe('always-deny floor — Ethos state dir (PST-001)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const home = join(homedir(), '.ethos');

  it.each([
    'config.yaml',
    'web-token',
    'mcp.json',
    'scripts',
    'plugins',
    'sessions.db',
    'sessions.db-wal',
    'sessions.db-shm',
    'observability.db',
    'observability.db-wal',
    'memory.db',
    // plan personality-memory-boundary G2-pre B — read AND write.
    'learning',
    // verification round F1 — operator policy, read AND write.
    'constitution.yaml',
    'evolve-config.json',
    'allowlist.json',
    'approval-leases.json',
  ])('denies ~/.ethos/%s', (entry) => {
    expect(sensitiveDenyPaths()).toContain(join(home, entry));
  });

  it('follows ETHOS_STATE_DIR as well as ~/.ethos', () => {
    vi.stubEnv('ETHOS_STATE_DIR', '/srv/ethos-state');
    expect(ethosStateDirs()).toEqual([home, '/srv/ethos-state']);
    expect(sensitiveDenyPaths()).toContain('/srv/ethos-state/sessions.db');
    expect(sensitiveDenyPaths()).toContain('/srv/ethos-state/keys.json');
    expect(sensitiveDenyPaths()).toContain(join(home, 'keys.json'));
  });

  it('a reach that covers the whole home dir still cannot read sessions.db or write mcp.json', async () => {
    const inner = new InMemoryStorage();
    await inner.mkdir(home);
    await inner.write(join(home, 'sessions.db'), 'transcripts');
    await inner.write(join(home, 'mcp.json'), '[]');
    const scoped = new ScopedStorage(inner, {
      read: [`${homedir()}/`],
      write: [`${homedir()}/`],
      alwaysDeny: defaultAlwaysDeny(),
    });
    await expect(scoped.read(join(home, 'sessions.db'))).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.write(join(home, 'mcp.json'), '[{}]')).rejects.toBeInstanceOf(
      BoundaryError,
    );
  });

  it("leaves the personality's own directory reachable (MEMORY.md, files/)", async () => {
    const inner = new InMemoryStorage();
    const own = join(home, 'personalities', 'researcher');
    await inner.mkdir(join(own, 'files'));
    await inner.write(join(own, 'MEMORY.md'), 'mine');
    const scoped = new ScopedStorage(inner, {
      read: [`${own}/`],
      write: [`${own}/`],
      alwaysDeny: defaultAlwaysDeny(),
    });
    expect(await scoped.read(join(own, 'MEMORY.md'))).toBe('mine');
    await scoped.write(join(own, 'files', 'note.md'), 'ok');
  });

  it('the personality-definition write floor follows ETHOS_STATE_DIR as well as ~/.ethos', () => {
    vi.stubEnv('ETHOS_STATE_DIR', '/srv/ethos-state');
    const floor = personalityDefinitionFloor();
    for (const dir of ['/srv/ethos-state', home]) {
      expect(floor(join(dir, 'personalities', 'any', 'toolset.yaml'), 'access')).toBe(true);
      expect(floor(join(dir, 'personalities', 'any', 'skills', 'x', 'SKILL.md'), 'access')).toBe(
        true,
      );
      expect(floor(join(dir, 'personalities', 'any', 'MEMORY.md'), 'access')).toBe(false);
      expect(floor(join(dir, 'personalities', 'any', 'files', 'toolset.yaml'), 'access')).toBe(
        false,
      );
      expect(floor(join(dir, 'personalities', 'any'), 'subtree')).toBe(true);
    }
    expect(floor('/srv/other/personalities/any/toolset.yaml', 'access')).toBe(false);
  });

  it('a reach covering the whole home dir cannot read learning/ or write another toolset.yaml', async () => {
    const inner = new InMemoryStorage();
    const other = join(home, 'personalities', 'alice');
    await inner.mkdir(join(home, 'learning'));
    await inner.mkdir(other);
    await inner.write(join(home, 'learning', 'audit.jsonl'), '{}');
    await inner.write(join(other, 'toolset.yaml'), '- read_file\n');
    const scoped = new ScopedStorage(inner, {
      read: [`${homedir()}/`],
      write: [`${homedir()}/`],
      alwaysDeny: defaultAlwaysDeny(),
    });
    await expect(scoped.read(join(home, 'learning', 'audit.jsonl'))).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.write(join(other, 'toolset.yaml'), '- terminal\n')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    expect(await scoped.read(join(other, 'toolset.yaml'))).toBe('- read_file\n');
  });
});

// Verification round F1 — operator policy files a turn could otherwise rewrite
// to widen its own power: the constitution, `evolve-config.json`'s
// `autoApprove`, and the approval allowlist and leases. Refused for read and
// write, in any letter case.
describe('always-deny floor — operator policy (verification round F1)', () => {
  const home = join(homedir(), '.ethos');

  it.each(['constitution.yaml', 'evolve-config.json', 'allowlist.json', 'approval-leases.json'])(
    'a reach covering the home dir cannot read or write %s, in any case',
    async (entry) => {
      const inner = new InMemoryStorage();
      await inner.mkdir(home);
      await inner.write(join(home, entry), 'policy');
      const scoped = new ScopedStorage(inner, {
        read: [`${homedir()}/`],
        write: [`${homedir()}/`],
        alwaysDeny: defaultAlwaysDeny(),
      });
      await expect(scoped.read(join(home, entry))).rejects.toBeInstanceOf(BoundaryError);
      await expect(scoped.write(join(home, entry), 'widened')).rejects.toBeInstanceOf(
        BoundaryError,
      );
      await expect(scoped.write(join(home, entry.toUpperCase()), 'x')).rejects.toBeInstanceOf(
        BoundaryError,
      );
      expect(await inner.read(join(home, entry))).toBe('policy');
    },
  );
});

// Verification round F2 — a data dir wiring knows and the environment does not
// (the desktop app's custom data folder) is floored when it is passed in.
describe('state dirs — a data dir outside ~/.ethos (verification round F2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const custom = '/srv/desktop-data';

  it('is not a state dir unless passed, and is floored when it is', async () => {
    expect(ethosStateDirs()).not.toContain(custom);
    expect(ethosStateDirs([custom])).toContain(custom);
    expect(sensitiveDenyPaths([custom])).toContain(join(custom, 'sessions.db'));
    expect(defaultAlwaysDeny([custom])).toContain(join(custom, 'constitution.yaml'));
    const floor = personalityDefinitionFloor([custom]);
    expect(floor(join(custom, 'personalities', 'a', 'toolset.yaml'), 'access')).toBe(true);
    expect(
      personalityDefinitionFloor()(join(custom, 'personalities', 'a', 'toolset.yaml'), 'access'),
    ).toBe(false);
  });

  it('ScopedStorage applies both floors to a data dir named in its scope', async () => {
    const inner = new InMemoryStorage();
    await inner.mkdir(join(custom, 'personalities', 'a'));
    await inner.write(join(custom, 'sessions.db'), 'transcripts');
    const scoped = new ScopedStorage(inner, {
      read: [`${custom}/`],
      write: [`${custom}/`],
      alwaysDeny: defaultAlwaysDeny([custom]),
      stateDirs: [custom],
    });
    await expect(scoped.read(join(custom, 'sessions.db'))).rejects.toBeInstanceOf(BoundaryError);
    await expect(
      scoped.write(join(custom, 'personalities', 'a', 'toolset.yaml'), '- terminal\n'),
    ).rejects.toBeInstanceOf(BoundaryError);
    // Without the scope field, the same write passes: the floor is what stops it.
    const unfloored = new ScopedStorage(inner, { read: [`${custom}/`], write: [`${custom}/`] });
    await unfloored.write(join(custom, 'personalities', 'a', 'toolset.yaml'), '- terminal\n');
  });

  it('dedupes a passed dir that ETHOS_STATE_DIR already names', () => {
    vi.stubEnv('ETHOS_STATE_DIR', custom);
    expect(ethosStateDirs([custom]).filter((d) => d === custom)).toHaveLength(1);
  });
});

// Verification round A2 — a state dir that is a symlink is also listed by its
// real name, so the always-deny floor and the definition floor match a path
// spelled through the real directory.
describe('state dirs — symlinked (verification round A2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists the realpath beside the lexical form, and the floors cover both', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'ethos-state-link-')));
    try {
      const real = join(tmp, 'dot', 'ethos');
      const link = join(tmp, '.ethos');
      await mkdir(real, { recursive: true });
      await symlink(real, link);
      vi.stubEnv('ETHOS_STATE_DIR', link);
      const dirs = ethosStateDirs();
      expect(dirs.indexOf(link)).toBeGreaterThan(-1);
      expect(dirs.indexOf(real)).toBeGreaterThan(dirs.indexOf(link));
      expect(sensitiveDenyPaths()).toContain(join(real, 'keys.json'));
      expect(sensitiveDenyPaths()).toContain(join(real, 'learning'));
      const floor = personalityDefinitionFloor();
      expect(floor(join(real, 'personalities', 'a', 'toolset.yaml'), 'access')).toBe(true);
      expect(floor(join(link, 'personalities', 'a', 'toolset.yaml'), 'access')).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
