// Containment 3a — `ScopedFsImpl`'s fifth constructor argument, the write-only
// deny list. The same cases as the `writeDeny` block in
// packages/storage-fs/src/__tests__/scoped-storage.test.ts, through the
// capability path the file tools (`ctx.scopedFs`) actually use.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAlwaysDeny, FsStorage, personalityDefinitionFloor } from '@ethosagent/storage-fs';
import { privateMemoryPathDeny } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCapabilities } from '../capability-resolver';
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

// plan personality-memory-boundary G1-5 — `ScopedFsImpl`'s sixth constructor
// argument, the shared-turn private memory deny. The same cases as the
// `denyWhen` block in packages/storage-fs/src/__tests__/scoped-storage.test.ts,
// through the capability path the file tools (`ctx.scopedFs`) actually use.
describe('ScopedFsImpl — denyWhen (shared-turn private memory)', () => {
  let home: string;
  let own: string;
  let cwd: string;
  let fs: ScopedFsImpl;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scopedfs-denywhen-')));
    own = join(home, 'personalities', 'bob');
    cwd = join(home, 'work');
    await mkdir(join(own, 'files'), { recursive: true });
    await mkdir(join(own, 'ui'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(own, 'MEMORY.md'), 'canary: interview at ACME');
    await writeFile(join(own, 'files', 'logo.txt'), 'asset');
    await writeFile(join(own, 'ui', 'report.html'), '<p>hi</p>');
    fs = new ScopedFsImpl(
      new FsStorage(),
      new Set([`${own}/`, `${cwd}/`]),
      new Set([`${own}/`, `${cwd}/`]),
      [],
      [],
      privateMemoryPathDeny({ stateDirs: [home] }),
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('refuses reading and writing MEMORY.md / USER.md with the PATH_NOT_REACHABLE: prefix', async () => {
    await expect(fs.read(join(own, 'MEMORY.md'))).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*shared conversation/,
    );
    await expect(fs.write(join(own, 'USER.md'), 'x')).rejects.toThrow(/^PATH_NOT_REACHABLE:/);
    await expect(fs.exists(join(own, 'MEMORY.md'))).rejects.toThrow(/^PATH_NOT_REACHABLE:/);
  });

  it('keeps the asset folder and Canvas templates readable', async () => {
    await expect(fs.read(join(own, 'files', 'logo.txt'))).resolves.toBe('asset');
    await expect(fs.read(join(own, 'ui', 'report.html'))).resolves.toBe('<p>hi</p>');
  });

  it('refuses an innocently named symlink in the cwd that lands on MEMORY.md (verify item 20)', async () => {
    await symlink(join(own, 'MEMORY.md'), join(cwd, 'notes.txt'));
    await expect(fs.read(join(cwd, 'notes.txt'))).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*shared conversation/,
    );
  });

  it('without denyWhen (a private turn) the same read succeeds', async () => {
    const open = new ScopedFsImpl(new FsStorage(), new Set([`${own}/`]), new Set());
    await expect(open.read(join(own, 'MEMORY.md'))).resolves.toBe('canary: interview at ACME');
  });
});

// plan personality-memory-boundary G2-pre B — `ScopedFsImpl`'s seventh
// constructor argument, the all-personality definition write floor, built from
// the SAME predicate every `ScopedStorage` applies on its own
// (`personalityDefinitionFloor`, packages/storage-fs/src/sensitive-paths.ts).
// Mirror of the floor block in packages/storage-fs/src/__tests__/scoped-storage.test.ts.
describe('ScopedFsImpl — definitionWriteFloor (every personality)', () => {
  let state: string;
  let own: string;
  let other: string;
  let cwd: string;
  let fs: ScopedFsImpl;

  beforeEach(async () => {
    state = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scopedfs-floor-')));
    vi.stubEnv('ETHOS_STATE_DIR', state);
    own = join(state, 'personalities', 'bob');
    other = join(state, 'personalities', 'alice');
    cwd = join(state, 'work');
    await mkdir(join(own, 'files'), { recursive: true });
    await mkdir(join(other, 'files'), { recursive: true });
    await mkdir(join(state, 'learning'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(other, 'toolset.yaml'), '- read_file\n');
    await writeFile(join(other, 'config.yaml'), 'name: Alice\n');
    await writeFile(join(state, 'learning', 'audit.jsonl'), '{}\n');
    // A reach spanning the whole state dir — the default reach when the
    // process cwd IS the state dir — with the caller's own write-deny list.
    fs = new ScopedFsImpl(
      new FsStorage(),
      new Set([`${state}/`]),
      new Set([`${state}/`]),
      defaultAlwaysDeny(),
      personalityWriteDeny(state, 'bob'),
      undefined,
      personalityDefinitionFloor(),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(state, { recursive: true, force: true });
  });

  it("refuses a write to ANOTHER personality's toolset.yaml, and still reads it", async () => {
    await expect(fs.write(join(other, 'toolset.yaml'), '- terminal\n')).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*personality definition is operator-owned/,
    );
    await expect(fs.read(join(other, 'toolset.yaml'))).resolves.toBe('- read_file\n');
  });

  it('refuses the definition files of a personality directory created mid-turn', async () => {
    await expect(fs.mkdir(join(state, 'personalities', 'new'))).resolves.toBeUndefined();
    await expect(
      fs.write(join(state, 'personalities', 'new', 'toolset.yaml'), '- terminal\n'),
    ).rejects.toThrow(/^PATH_NOT_REACHABLE: .*operator-owned/);
    await expect(
      fs.write(join(state, 'personalities', 'new', 'skills', 'x', 'SKILL.md'), 'x'),
    ).rejects.toThrow(/^PATH_NOT_REACHABLE:/);
  });

  it("refuses a symlink in the cwd that lands on another personality's config.yaml, on the hop", async () => {
    await symlink(join(other, 'config.yaml'), join(cwd, 'notes.txt'));
    await expect(fs.write(join(cwd, 'notes.txt'), 'name: Evil\n')).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*operator-owned/,
    );
    await symlink(other, join(cwd, 'p'));
    await expect(fs.write(join(cwd, 'p', 'config.yaml'), 'x')).rejects.toThrow(
      /^PATH_NOT_REACHABLE:/,
    );
    expect(await readFile(join(other, 'config.yaml'), 'utf8')).toBe('name: Alice\n');
  });

  it("leaves another personality's non-definition files writable", async () => {
    await expect(fs.write(join(other, 'files', 'a.txt'), 'x')).resolves.toBeUndefined();
  });

  it('refuses reading learning/ (the always-deny floor)', async () => {
    await expect(fs.read(join(state, 'learning', 'audit.jsonl'))).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*always-deny floor/,
    );
  });

  it('resolveCapabilities hands the injected floor to every scopedFs it builds', async () => {
    const { scopedFs } = resolveCapabilities(
      'write_file',
      { fs_reach: { read: 'from-personality', write: 'from-personality' } },
      { sessionId: 's', personalityId: 'bob' },
      {
        storage: new FsStorage(),
        personalityFsReach: () => ({ read: [`${state}/`], write: [`${state}/`] }),
        definitionWriteFloor: personalityDefinitionFloor(),
      },
    );
    await expect(scopedFs?.write(join(other, 'toolset.yaml'), 'x')).rejects.toThrow(
      /^PATH_NOT_REACHABLE: .*operator-owned/,
    );
    await expect(scopedFs?.write(join(other, 'files', 'b.txt'), 'x')).resolves.toBeUndefined();
  });
});
