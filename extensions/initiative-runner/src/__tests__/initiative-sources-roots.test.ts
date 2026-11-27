import { homedir } from 'node:os';
import { sensitiveDenyPaths } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { checkSources } from '../index';

const HOME = homedir();
const ctx = (over: Partial<Parameters<typeof checkSources>[1]> = {}) => ({
  readableRoots: [`${HOME}/code`],
  blocked: sensitiveDenyPaths(),
  ...over,
});

const repo = (p: string) => ({ repo: p });

describe('checkSources', () => {
  it('R5 blocked and out-of-root sources refused', () => {
    const ssh = checkSources([repo('~/.ssh')], ctx({ readableRoots: [HOME] }));
    expect(ssh).toEqual({ ok: false, error: expect.stringContaining('~/.ssh') });
    const env = checkSources([repo('~/code/app/.env')], ctx());
    expect(env).toEqual({ ok: false, error: expect.stringContaining('.env') });
    const etc = checkSources([repo('/etc')], ctx());
    expect(etc).toEqual({ ok: false, error: expect.stringContaining('readableRoots') });
    const outside = checkSources([repo(`${HOME}/other/app`)], ctx());
    expect(outside).toEqual({ ok: false, error: expect.stringContaining('outside readableRoots') });
  });

  it('refuses .pem and id_* files even inside a root', () => {
    expect(checkSources([repo('~/code/certs/server.pem')], ctx()).ok).toBe(false);
    expect(checkSources([repo('~/code/keys/id_ed25519')], ctx()).ok).toBe(false);
  });

  it('refuses an ancestor of a blocked path and a traversal out of the root', () => {
    expect(checkSources([repo(HOME)], ctx({ readableRoots: [HOME] })).ok).toBe(false);
    expect(checkSources([repo(`${HOME}/code/../.ssh`)], ctx({ readableRoots: [HOME] })).ok).toBe(
      false,
    );
    expect(checkSources([repo(`${HOME}/code/../other`)], ctx()).ok).toBe(false);
  });

  it('refuses a relative path and a repo source when no readableRoots are set', () => {
    expect(checkSources([repo('code/app')], ctx()).ok).toBe(false);
    const r = checkSources([repo('~/code/app')], ctx({ readableRoots: [] }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining('readableRoots') });
  });

  it('accepts the bare kinds without roots', () => {
    expect(checkSources(['web', 'memory'], ctx({ readableRoots: [] }))).toEqual({ ok: true });
  });
});
