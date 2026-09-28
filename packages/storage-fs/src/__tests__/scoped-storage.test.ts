import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryError, privateMemoryPathDeny } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAlwaysDeny } from '../default-deny';
import { FsStorage } from '../fs-storage';
import { InMemoryStorage } from '../in-memory-storage';
import { ScopedStorage } from '../scoped-storage';

describe('ScopedStorage', () => {
  let inner: InMemoryStorage;

  beforeEach(async () => {
    inner = new InMemoryStorage();
    await inner.mkdir('/ethos');
    await inner.mkdir('/ethos/personalities');
    await inner.mkdir('/ethos/personalities/researcher');
    await inner.mkdir('/ethos/personalities/engineer');
    await inner.mkdir('/cwd');
    await inner.write('/ethos/personalities/researcher/MEMORY.md', 'mine');
    await inner.write('/ethos/personalities/engineer/MEMORY.md', 'theirs');
  });

  it('allows reads inside the read allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    expect(await scoped.read('/ethos/personalities/researcher/MEMORY.md')).toBe('mine');
  });

  it('blocks reads outside the read allowlist with BoundaryError', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    await expect(scoped.read('/ethos/personalities/engineer/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
  });

  it('allows writes inside the write allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    await scoped.write('/ethos/personalities/researcher/note.md', 'hello');
    expect(await inner.read('/ethos/personalities/researcher/note.md')).toBe('hello');
  });

  it('blocks writes outside the write allowlist with BoundaryError', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    await expect(
      scoped.write('/ethos/personalities/engineer/note.md', 'hi'),
    ).rejects.toBeInstanceOf(BoundaryError);
  });

  it('write-only path is readable too only when in the read allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: [],
      write: ['/cwd/'],
    });
    await scoped.write('/cwd/out.txt', 'ok');
    await expect(scoped.read('/cwd/out.txt')).rejects.toBeInstanceOf(BoundaryError);
  });

  it('exists / mtime / list / listEntries respect read allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    expect(await scoped.exists('/ethos/personalities/researcher/MEMORY.md')).toBe(true);
    await expect(scoped.exists('/ethos/personalities/engineer/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.list('/ethos/personalities/engineer')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.listEntries('/ethos/personalities/engineer')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.mtime('/ethos/personalities/engineer/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
  });

  it('mkdir / remove / rename respect write allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    await expect(scoped.mkdir('/ethos/personalities/engineer/sub')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.remove('/ethos/personalities/engineer/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(
      scoped.rename(
        '/ethos/personalities/researcher/MEMORY.md',
        '/ethos/personalities/engineer/MEMORY.md',
      ),
    ).rejects.toBeInstanceOf(BoundaryError);
  });

  it('matches prefix on directory boundary, not raw substring', async () => {
    // `/ethos/personalities/research/` must NOT also allow `/ethos/personalities/researcher/`
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/research/'],
      write: ['/ethos/personalities/research/'],
    });
    await expect(scoped.read('/ethos/personalities/researcher/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
  });

  it('accepts prefixes both with and without trailing slash', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher'],
      write: ['/ethos/personalities/researcher'],
    });
    expect(await scoped.read('/ethos/personalities/researcher/MEMORY.md')).toBe('mine');
  });

  it('BoundaryError carries kind and path for surface translation', async () => {
    const scoped = new ScopedStorage(inner, { read: [], write: [] });
    try {
      await scoped.read('/blocked');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BoundaryError);
      expect((err as BoundaryError).kind).toBe('read');
      expect((err as BoundaryError).path).toBe('/blocked');
      expect((err as BoundaryError).code).toBe('storage-boundary');
    }
  });

  // Ch.5 — universal always-deny floor
  describe('alwaysDeny floor', () => {
    beforeEach(async () => {
      await inner.mkdir('/home');
      await inner.mkdir('/home/.ssh');
      await inner.mkdir('/home/proj');
      await inner.write('/home/.ssh/id_rsa', 'PRIVATE KEY');
      await inner.write('/home/proj/notes.md', 'project notes');
    });

    it('blocks reads matching alwaysDeny even when allow grants the parent', async () => {
      const scoped = new ScopedStorage(inner, {
        read: ['/home/'],
        write: ['/home/'],
        alwaysDeny: ['/home/.ssh'],
      });
      await expect(scoped.read('/home/.ssh/id_rsa')).rejects.toBeInstanceOf(BoundaryError);
      await expect(scoped.read('/home/proj/notes.md')).resolves.toBe('project notes');
    });

    it('blocks writes matching alwaysDeny even when write grants the parent', async () => {
      const scoped = new ScopedStorage(inner, {
        read: ['/home/'],
        write: ['/home/'],
        alwaysDeny: ['/home/.ssh'],
      });
      await expect(
        scoped.write('/home/.ssh/authorized_keys', 'attacker-key'),
      ).rejects.toBeInstanceOf(BoundaryError);
    });

    it('alwaysDeny error message names the floor', async () => {
      const scoped = new ScopedStorage(inner, {
        read: ['/home/'],
        write: ['/home/'],
        alwaysDeny: ['/home/.ssh'],
      });
      await expect(scoped.read('/home/.ssh/id_rsa')).rejects.toThrow(/always-deny floor/);
    });

    it('passes through when alwaysDeny is absent', async () => {
      const scoped = new ScopedStorage(inner, {
        read: ['/home/'],
        write: ['/home/'],
      });
      await expect(scoped.read('/home/.ssh/id_rsa')).resolves.toBe('PRIVATE KEY');
    });
  });

  // G11 — symbolic containment. The allow/deny layers above are lexical, and
  // `resolve()` cannot see a symlink. These cases run against real temp dirs
  // (a symlink is a filesystem fact, not a string) with a real FsStorage
  // underneath, so an escape that slipped past `check()` would actually read
  // the out-of-bounds bytes.
  describe('symbolic containment', () => {
    let root: string;
    let outside: string;

    beforeEach(async () => {
      // realpath: on macOS /var is a symlink to /private/var, and the allow
      // prefixes must share canonical form with the request paths for the
      // lexical layer. Everything below `root` is what the walk inspects.
      root = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scoped-symlink-')));
      outside = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scoped-outside-')));
      await writeFile(join(root, 'inside.txt'), 'mine');
      await writeFile(join(outside, 'secret.txt'), 'theirs');
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });

    const scopedAt = (readPaths: string[], writePaths: string[], alwaysDeny?: string[]) =>
      new ScopedStorage(new FsStorage(), {
        read: readPaths,
        write: writePaths,
        ...(alwaysDeny ? { alwaysDeny } : {}),
      });

    it('rejects a symlink inside the allowlist that points outside it', async () => {
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
      const scoped = scopedAt([root], []);
      await expect(scoped.read(join(root, 'link.txt'))).rejects.toBeInstanceOf(BoundaryError);
      await expect(scoped.read(join(root, 'link.txt'))).rejects.toThrow(/symbolic link/);
    });

    it('rejects a symlinked parent directory reached through an ordinary leaf', async () => {
      await symlink(outside, join(root, 'sub'));
      const scoped = scopedAt([root], []);
      await expect(scoped.read(join(root, 'sub', 'secret.txt'))).rejects.toThrow(/symbolic link/);
    });

    it('does not leak the resolved target in the rejection message', async () => {
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
      const scoped = scopedAt([root], []);
      await expect(scoped.read(join(root, 'link.txt'))).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(outside) }),
      );
    });

    it('allows a symlink whose target stays inside the allowlist, unrewritten', async () => {
      // `check()` decides reachability; it is not a canonicalizer. The inner
      // Storage must still receive the path the caller asked for.
      await symlink(join(root, 'inside.txt'), join(root, 'alias.txt'));
      const fs = new FsStorage();
      const readSpy = vi.spyOn(fs, 'read');
      const scoped = new ScopedStorage(fs, { read: [root], write: [] });
      await expect(scoped.read(join(root, 'alias.txt'))).resolves.toBe('mine');
      expect(readSpy).toHaveBeenCalledWith(join(root, 'alias.txt'));
    });

    it('allows a write to a path that does not exist yet (ENOENT is not a symlink)', async () => {
      const scoped = scopedAt([], [root]);
      await scoped.mkdir(join(root, 'nested'));
      await scoped.write(join(root, 'nested', 'new.txt'), 'body');
      await expect(new FsStorage().read(join(root, 'nested', 'new.txt'))).resolves.toBe('body');
    });

    it('re-applies the deny floor to the resolved target, not just the link path', async () => {
      // The allowlist covers the link AND its target; only the floor rejects.
      const vault = join(outside, 'vault');
      await symlink(vault, join(root, 'shortcut'));
      const scoped = scopedAt([root, outside], [], [vault]);
      await expect(scoped.read(join(root, 'shortcut'))).rejects.toThrow(/symbolic link/);
    });

    it('refuses a symlink cycle instead of following it forever', async () => {
      await symlink(join(root, 'b'), join(root, 'a'));
      await symlink(join(root, 'a'), join(root, 'b'));
      const scoped = scopedAt([root], []);
      // BoundaryError specifically, not the ELOOP the kernel would raise if
      // the walk let the read through — Node's ELOOP message happens to
      // contain the same words, so the instance check is what has teeth.
      await expect(scoped.read(join(root, 'a'))).rejects.toBeInstanceOf(BoundaryError);
      await expect(scoped.read(join(root, 'a'))).rejects.toThrow(/too many symbolic links/);
    });

    it('leaves an ordinary in-bounds read untouched', async () => {
      const scoped = scopedAt([root], []);
      await expect(scoped.read(join(root, 'inside.txt'))).resolves.toBe('mine');
    });
  });
});

// Containment 3a — `writeDeny` is a WRITE-only list: the personality's own
// definition is readable but never writable, even though `write` covers
// `ownDir`. Mirror cases through `ScopedFsImpl` live in
// packages/core/src/__tests__/scoped-fs.test.ts — the two boundaries change together.
describe('ScopedStorage — writeDeny (personality definition)', () => {
  let home: string;
  let own: string;
  let scoped: ScopedStorage;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-write-deny-')));
    own = join(home, 'personalities', 'bob');
    const fs = new FsStorage();
    await fs.mkdir(join(own, 'files'));
    await fs.mkdir(join(own, 'skills', 'x'));
    await fs.write(join(own, 'toolset.yaml'), '- read_file\n');
    scoped = new ScopedStorage(fs, {
      read: [`${own}/`],
      write: [`${own}/`],
      writeDeny: [
        join(own, 'SOUL.md'),
        join(own, 'config.yaml'),
        join(own, 'toolset.yaml'),
        join(own, 'mcp.yaml'),
        join(own, 'tools.yaml'),
        join(own, 'ETHOS.md'),
        `${join(own, 'skills')}/`,
      ],
    });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('refuses a write to ownDir/toolset.yaml with the operator-owned reason', async () => {
    const err = await scoped.write(join(own, 'toolset.yaml'), '- terminal\n').catch((e) => e);
    expect(err).toBeInstanceOf(BoundaryError);
    expect((err as BoundaryError).kind).toBe('write');
    expect((err as BoundaryError).message).toContain('personality definition is operator-owned');
    await expect(scoped.append(join(own, 'toolset.yaml'), '- x\n')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.writeAtomic(join(own, 'toolset.yaml'), 'x')).rejects.toBeInstanceOf(
      BoundaryError,
    );
  });

  it('still reads the same path', async () => {
    await expect(scoped.read(join(own, 'toolset.yaml'))).resolves.toBe('- read_file\n');
  });

  it('refuses CREATING a missing definition file', async () => {
    await expect(scoped.write(join(own, 'mcp.yaml'), 'x')).rejects.toBeInstanceOf(BoundaryError);
  });

  it('allows the asset folder and memory files', async () => {
    await expect(scoped.write(join(own, 'files', 'a.png'), 'png')).resolves.toBeUndefined();
    await expect(scoped.write(join(own, 'MEMORY.md'), 'note')).resolves.toBeUndefined();
  });

  it('refuses a write under ownDir/skills/', async () => {
    await expect(scoped.write(join(own, 'skills', 'x', 'SKILL.md'), 'x')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.mkdir(join(own, 'skills', 'y'))).rejects.toBeInstanceOf(BoundaryError);
  });

  it('refuses a write that reaches toolset.yaml through a symlink in files/, on the hop', async () => {
    await symlink('../toolset.yaml', join(own, 'files', 't'));
    const err = await scoped.write(join(own, 'files', 't'), '- terminal\n').catch((e) => e);
    expect(err).toBeInstanceOf(BoundaryError);
    expect((err as BoundaryError).message).toContain('personality definition is operator-owned');
    await expect(new FsStorage().read(join(own, 'toolset.yaml'))).resolves.toBe('- read_file\n');
  });

  it('refuses removing or renaming a directory that contains a definition entry', async () => {
    await expect(scoped.remove(own, { recursive: true })).rejects.toBeInstanceOf(BoundaryError);
    await expect(
      scoped.rename(join(own, 'skills'), join(own, 'files', 's')),
    ).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.remove(join(own, 'files'), { recursive: true })).resolves.toBeUndefined();
  });

  it('without writeDeny the same write succeeds (the list is opt-in per scope)', async () => {
    const open = new ScopedStorage(new FsStorage(), { read: [`${own}/`], write: [`${own}/`] });
    await expect(open.write(join(own, 'toolset.yaml'), '- terminal\n')).resolves.toBeUndefined();
  });
});

// plan personality-memory-boundary G1-5 — `denyWhen`, the shared-turn private
// memory deny. Read AND write, on the lexical path AND on where a symlink
// lands. Mirror cases through `ScopedFsImpl` live in
// packages/core/src/__tests__/scoped-fs.test.ts — the two boundaries change together.
describe('ScopedStorage — denyWhen (shared-turn private memory)', () => {
  let home: string;
  let own: string;
  let cwd: string;
  let scoped: ScopedStorage;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-deny-when-')));
    own = join(home, 'personalities', 'bob');
    cwd = join(home, 'work');
    const fs = new FsStorage();
    await fs.mkdir(join(own, 'files'));
    await fs.mkdir(join(own, 'ui'));
    await fs.mkdir(cwd);
    await fs.write(join(own, 'MEMORY.md'), 'canary: interview at ACME');
    await fs.write(join(own, 'files', 'logo.txt'), 'asset');
    await fs.write(join(own, 'ui', 'report.html'), '<p>hi</p>');
    scoped = new ScopedStorage(fs, {
      read: [`${own}/`, `${cwd}/`],
      write: [`${own}/`, `${cwd}/`],
      denyWhen: privateMemoryPathDeny({ stateDirs: [home] }),
    });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('refuses reading and writing MEMORY.md with the shared-audience reason', async () => {
    const err = await scoped.read(join(own, 'MEMORY.md')).catch((e) => e);
    expect(err).toBeInstanceOf(BoundaryError);
    expect((err as BoundaryError).kind).toBe('read');
    expect((err as BoundaryError).message).toContain('shared-audience memory');
    await expect(scoped.write(join(own, 'MEMORY.md'), 'x')).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.append(join(own, 'USER.md'), 'x')).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.exists(join(own, 'MEMORY.md'))).rejects.toBeInstanceOf(BoundaryError);
  });

  it('keeps the asset folder and Canvas templates readable', async () => {
    await expect(scoped.read(join(own, 'files', 'logo.txt'))).resolves.toBe('asset');
    await expect(scoped.read(join(own, 'ui', 'report.html'))).resolves.toBe('<p>hi</p>');
    await expect(scoped.list(own)).resolves.toContain('MEMORY.md');
  });

  it('refuses an innocently named symlink in the cwd that lands on MEMORY.md (verify item 20)', async () => {
    await symlink(join(own, 'MEMORY.md'), join(cwd, 'notes.txt'));
    const err = await scoped.read(join(cwd, 'notes.txt')).catch((e) => e);
    expect(err).toBeInstanceOf(BoundaryError);
    expect((err as BoundaryError).message).toContain('shared-audience memory');
    // The refusal never names where the link landed.
    expect((err as BoundaryError).message).not.toContain('MEMORY.md');
  });

  it('refuses a symlinked PARENT that lands in the personality dir, on the hop', async () => {
    await symlink(own, join(cwd, 'p'));
    await expect(scoped.read(join(cwd, 'p', 'MEMORY.md'))).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.read(join(cwd, 'p', 'files', 'logo.txt'))).resolves.toBe('asset');
  });

  it('refuses removing or renaming a directory that contains memory', async () => {
    await expect(scoped.remove(own, { recursive: true })).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.rename(own, join(cwd, 'moved'))).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.remove(join(own, 'files'), { recursive: true })).resolves.toBeUndefined();
  });

  it('without denyWhen (a private turn) the same read succeeds', async () => {
    const open = new ScopedStorage(new FsStorage(), { read: [`${own}/`], write: [`${own}/`] });
    await expect(open.read(join(own, 'MEMORY.md'))).resolves.toBe('canary: interview at ACME');
  });
});

// plan personality-memory-boundary G2-pre B — the personality-definition WRITE
// floor every `ScopedStorage` applies on its own (`personalityDefinitionFloor`,
// ../sensitive-paths.ts): ANY personality's definition entries under ANY Ethos
// state dir, not only the caller's (`writeDeny` above), including a directory
// created mid-turn. No scope field turns it on or off. Mirror cases through
// `ScopedFsImpl` live in packages/core/src/__tests__/scoped-fs.test.ts.
describe('ScopedStorage — definition floor (every personality)', () => {
  let state: string;
  let other: string;
  let cwd: string;
  let scoped: ScopedStorage;

  beforeEach(async () => {
    state = await realpath(await mkdtemp(join(tmpdir(), 'ethos-def-floor-')));
    // Read at construction, like `defaultAlwaysDeny()` — stub first.
    vi.stubEnv('ETHOS_STATE_DIR', state);
    other = join(state, 'personalities', 'alice');
    cwd = join(state, 'work');
    const fs = new FsStorage();
    await fs.mkdir(join(state, 'personalities', 'bob', 'files'));
    await fs.mkdir(join(other, 'files'));
    await fs.mkdir(join(state, 'learning', 'candidates'));
    await fs.mkdir(cwd);
    await fs.write(join(other, 'toolset.yaml'), '- read_file\n');
    await fs.write(join(other, 'config.yaml'), 'name: Alice\n');
    await fs.write(join(state, 'learning', 'candidates', 'c1.json'), '{}');
    // No `writeDeny` at all: the floor needs none.
    scoped = new ScopedStorage(fs, {
      read: [`${state}/`],
      write: [`${state}/`],
      alwaysDeny: defaultAlwaysDeny(),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(state, { recursive: true, force: true });
  });

  it("refuses a write to another personality's toolset.yaml, and still reads it", async () => {
    const err = await scoped.write(join(other, 'toolset.yaml'), '- terminal\n').catch((e) => e);
    expect(err).toBeInstanceOf(BoundaryError);
    expect((err as BoundaryError).kind).toBe('write');
    expect((err as BoundaryError).message).toContain('personality definition is operator-owned');
    await expect(scoped.writeAtomic(join(other, 'toolset.yaml'), 'x')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.append(join(other, 'SOUL.md'), 'x')).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.read(join(other, 'toolset.yaml'))).resolves.toBe('- read_file\n');
  });

  it('refuses personalities/new/toolset.yaml created mid-turn (a predicate, not a list)', async () => {
    const fresh = join(state, 'personalities', 'new');
    await expect(scoped.mkdir(fresh)).resolves.toBeUndefined();
    await expect(scoped.write(join(fresh, 'toolset.yaml'), '- terminal\n')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.mkdir(join(fresh, 'skills'))).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.mkdir(join(fresh, 'files'))).resolves.toBeUndefined();
    await expect(scoped.write(join(fresh, 'files', 'a.txt'), 'x')).resolves.toBeUndefined();
  });

  it("refuses a symlink to another personality's config.yaml, and a symlinked parent, on the hop", async () => {
    await symlink(join(other, 'config.yaml'), join(cwd, 'notes.txt'));
    const err = await scoped.write(join(cwd, 'notes.txt'), 'name: Evil\n').catch((e) => e);
    expect(err).toBeInstanceOf(BoundaryError);
    expect((err as BoundaryError).message).toContain('personality definition is operator-owned');
    await symlink(other, join(cwd, 'p'));
    await expect(scoped.write(join(cwd, 'p', 'toolset.yaml'), 'x')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(new FsStorage().read(join(other, 'config.yaml'))).resolves.toBe('name: Alice\n');
  });

  it("refuses removing or renaming another personality's directory, or personalities/", async () => {
    await expect(scoped.remove(other, { recursive: true })).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.rename(other, join(cwd, 'moved'))).rejects.toBeInstanceOf(BoundaryError);
    await expect(
      scoped.remove(join(state, 'personalities'), { recursive: true }),
    ).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.remove(join(other, 'files'), { recursive: true })).resolves.toBeUndefined();
  });

  it("leaves another personality's non-definition files writable", async () => {
    await expect(scoped.write(join(other, 'files', 'a.txt'), 'x')).resolves.toBeUndefined();
    await expect(scoped.write(join(other, 'MEMORY.md'), 'x')).resolves.toBeUndefined();
  });

  it('refuses reading learning/ on a turn (always-deny floor), and writing into it', async () => {
    const err = await scoped.read(join(state, 'learning', 'candidates', 'c1.json')).catch((e) => e);
    expect(err).toBeInstanceOf(BoundaryError);
    expect((err as BoundaryError).kind).toBe('read');
    await expect(scoped.list(join(state, 'learning'))).rejects.toBeInstanceOf(BoundaryError);
    await expect(
      scoped.write(join(state, 'learning', 'candidates', 'planted.json'), '{}'),
    ).rejects.toBeInstanceOf(BoundaryError);
  });

  it('does not reach a directory outside every state dir', async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'ethos-not-state-')));
    try {
      const fs = new FsStorage();
      await fs.mkdir(join(elsewhere, 'personalities', 'x'));
      const open = new ScopedStorage(fs, { read: [`${elsewhere}/`], write: [`${elsewhere}/`] });
      await expect(
        open.write(join(elsewhere, 'personalities', 'x', 'toolset.yaml'), 'x'),
      ).resolves.toBeUndefined();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
