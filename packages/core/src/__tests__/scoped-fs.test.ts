// Containment 3a — `ScopedFsImpl`'s fifth constructor argument, the write-only
// deny list. The same cases as the `writeDeny` block in
// packages/storage-fs/src/__tests__/scoped-storage.test.ts, through the
// capability path the file tools (`ctx.scopedFs`) actually use.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAlwaysDeny, FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { personalityWriteDeny } from '../fs-reach';
import { ScopedFsImpl } from '../scoped/scoped-fs';

describe('ScopedFsImpl — writeDenyPaths (personality definition)', () => {
  let home: string;
  let own: string;
  let fs: ScopedFsImpl;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scopedfs-deny-')));
    own = join(home, 'personalities', 'bob');
    await mkdir(join(own, 'files'), { recursive: true });
    await mkdir(join(own, 'skills', 'x'), { recursive: true });
    await writeFile(join(own, 'toolset.yaml'), '- read_file\n');
    fs = new ScopedFsImpl(
      new FsStorage(),
      new Set([`${own}/`]),
      new Set([`${own}/`]),
      [],
      personalityWriteDeny(home, 'bob'),
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('refuses a write to ownDir/toolset.yaml with the PATH_NOT_REACHABLE: prefix', async () => {
    await expect(fs.write(join(own, 'toolset.yaml'), '- terminal\n')).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*personality definition is operator-owned/,
    );
  });

  it('still reads the same path', async () => {
    await expect(fs.read(join(own, 'toolset.yaml'))).resolves.toBe('- read_file\n');
  });

  it('allows the asset folder and memory files', async () => {
    await expect(fs.write(join(own, 'files', 'a.png'), 'png')).resolves.toBeUndefined();
    await expect(fs.write(join(own, 'MEMORY.md'), 'note')).resolves.toBeUndefined();
  });

  it('refuses a write under ownDir/skills/', async () => {
    await expect(fs.write(join(own, 'skills', 'x', 'SKILL.md'), 'x')).rejects.toThrow(
      /^PATH_NOT_REACHABLE:/,
    );
    await expect(fs.mkdir(join(own, 'skills', 'y'))).rejects.toThrow(/^PATH_NOT_REACHABLE:/);
  });

  it('refuses a write that reaches toolset.yaml through a symlink in files/, on the hop', async () => {
    await symlink('../toolset.yaml', join(own, 'files', 't'));
    await expect(fs.write(join(own, 'files', 't'), '- terminal\n')).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*personality definition is operator-owned/,
    );
    expect(await readFile(join(own, 'toolset.yaml'), 'utf8')).toBe('- read_file\n');
  });
});

// PST-001 — the always-deny floor wiring hands `ScopedFsImpl`
// (`alwaysDenyPaths: defaultAlwaysDeny()`, packages/wiring/src/build-infrastructure.ts)
// covers the state dir's shared stores, so a reach that spans the state dir
// (the default reach when the process cwd IS the state dir) still stops at them.
describe('ScopedFsImpl — always-deny floor over the Ethos state dir', () => {
  let state: string;
  let fs: ScopedFsImpl;

  beforeEach(async () => {
    state = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scopedfs-state-')));
    vi.stubEnv('ETHOS_STATE_DIR', state);
    await mkdir(join(state, 'personalities', 'bob'), { recursive: true });
    await writeFile(join(state, 'sessions.db'), 'transcripts');
    await writeFile(join(state, 'personalities', 'bob', 'MEMORY.md'), 'mine');
    fs = new ScopedFsImpl(
      new FsStorage(),
      new Set([`${state}/`]),
      new Set([`${state}/`]),
      defaultAlwaysDeny(),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(state, { recursive: true, force: true });
  });

  it('refuses sessions.db and mcp.json but still reads the personality MEMORY.md', async () => {
    await expect(fs.read(join(state, 'sessions.db'))).rejects.toThrow(/PATH_NOT_REACHABLE/);
    await expect(fs.write(join(state, 'mcp.json'), '[]')).rejects.toThrow(/PATH_NOT_REACHABLE/);
    expect(await fs.read(join(state, 'personalities', 'bob', 'MEMORY.md'))).toBe('mine');
  });
});
