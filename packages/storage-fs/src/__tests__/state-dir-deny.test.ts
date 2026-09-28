import { homedir } from 'node:os';
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
