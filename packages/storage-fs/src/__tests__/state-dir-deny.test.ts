import { homedir } from 'node:os';
import { join } from 'node:path';
import { BoundaryError } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAlwaysDeny } from '../default-deny';
import { InMemoryStorage } from '../in-memory-storage';
import { ScopedStorage } from '../scoped-storage';
import { ethosStateDirs, sensitiveDenyPaths } from '../sensitive-paths';

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
});
