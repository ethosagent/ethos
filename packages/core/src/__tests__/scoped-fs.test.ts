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
import { sharedTurnDenyFor } from '../agent-loop/audience';
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

// Verification round A1/A2 — the deny layers fail closed on case variants
// (on a case-insensitive file system `Toolset.yaml` IS `toolset.yaml`) and on
// a state dir reached through a symlink. Mirror of the same block in
// packages/storage-fs/src/__tests__/scoped-storage.test.ts.
describe('ScopedFsImpl — case variants and a symlinked state dir', () => {
  let tmp: string;
  let state: string;
  let own: string;
  let other: string;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scopedfs-case-')));
    state = join(tmp, '.ethos');
    vi.stubEnv('ETHOS_STATE_DIR', state);
    own = join(state, 'personalities', 'bob');
    other = join(state, 'personalities', 'alice');
    await mkdir(join(own, 'files'), { recursive: true });
    await mkdir(join(other, 'files'), { recursive: true });
    await writeFile(join(other, 'toolset.yaml'), '- read_file\n');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  const everything = (root: string) => new Set([`${root}/`]);

  it('refuses case variants of every definition entry through the floor and writeDeny', async () => {
    const fs = new ScopedFsImpl(
      new FsStorage(),
      everything(tmp),
      everything(tmp),
      defaultAlwaysDeny(),
      personalityWriteDeny(state, 'bob'),
      undefined,
      personalityDefinitionFloor(),
    );
    for (const entry of ['toolset.yaml', 'TOOLSET.yaml', 'Toolset.yaml', 'SOUL.md', 'soul.md']) {
      await expect(fs.write(join(other, entry), '- terminal\n'), entry).rejects.toThrow(
        /^PATH_NOT_REACHABLE: .*operator-owned/,
      );
    }
    // The caller's own list alone (no floor injected) folds too.
    const ownOnly = new ScopedFsImpl(
      new FsStorage(),
      everything(own),
      everything(own),
      [],
      personalityWriteDeny(state, 'bob'),
    );
    for (const entry of ['Toolset.yaml', 'CONFIG.YAML', 'Skills/x/SKILL.md']) {
      await expect(ownOnly.write(join(own, entry), 'x'), entry).rejects.toThrow(
        /^PATH_NOT_REACHABLE: .*operator-owned/,
      );
    }
    expect(await readFile(join(other, 'toolset.yaml'), 'utf8')).toBe('- read_file\n');
  });

  it('refuses case variants of the state dir and its always-deny entries', async () => {
    const fs = new ScopedFsImpl(
      new FsStorage(),
      everything(tmp),
      everything(tmp),
      defaultAlwaysDeny(),
    );
    for (const p of [
      join(tmp, '.ETHOS', 'keys.json'),
      join(state, 'KEYS.JSON'),
      join(state, 'LEARNING', 'audit.jsonl'),
      join(tmp, '.Ethos', 'learning', 'audit.jsonl'),
    ]) {
      await expect(fs.read(p), p).rejects.toThrow(/^PATH_NOT_REACHABLE: .*always-deny floor/);
    }
  });

  it('refuses case variants of private memory on a shared turn', async () => {
    const fs = new ScopedFsImpl(
      new FsStorage(),
      everything(tmp),
      everything(tmp),
      [],
      [],
      sharedTurnDenyFor('shared', { stateDirs: [state] }, 'bob'),
    );
    for (const p of [
      join(own, 'MEMORY.md'),
      join(own, 'memory.md'),
      join(own, 'Memory.MD'),
      join(state, 'Users', 'u1', 'USER.md'),
      join(tmp, '.ETHOS', 'users', 'u1', 'user.md'),
    ]) {
      await expect(fs.read(p), p).rejects.toThrow(/^PATH_NOT_REACHABLE: .*private memory/);
    }
  });

  it('judges the real target when the state dir or the reach is reached through a symlink', async () => {
    // `ETHOS_STATE_DIR` names a LINK; the turn writes by the real name, and
    // through a second link whose own path is the allowed prefix.
    const link = join(tmp, 'linked-ethos');
    await symlink(state, link);
    vi.stubEnv('ETHOS_STATE_DIR', link);
    const reachLink = join(tmp, 'work');
    await symlink(other, reachLink);
    const fs = new ScopedFsImpl(
      new FsStorage(),
      new Set([`${state}/`, `${reachLink}/`]),
      new Set([`${state}/`, `${reachLink}/`]),
      defaultAlwaysDeny(),
      [],
      sharedTurnDenyFor('shared', { stateDirs: [link] }, 'alice'),
      personalityDefinitionFloor(),
    );
    await expect(fs.write(join(other, 'toolset.yaml'), 'x')).rejects.toThrow(/operator-owned/);
    await expect(fs.write(join(reachLink, 'toolset.yaml'), 'x')).rejects.toThrow(/operator-owned/);
    await expect(fs.read(join(reachLink, 'MEMORY.md'))).rejects.toThrow(/private memory/);
    await expect(fs.read(join(state, 'keys.json'))).rejects.toThrow(/always-deny floor/);
    await expect(fs.write(join(reachLink, 'files', 'ok.txt'), 'x')).resolves.toBeUndefined();
    expect(await readFile(join(other, 'toolset.yaml'), 'utf8')).toBe('- read_file\n');
  });
});
