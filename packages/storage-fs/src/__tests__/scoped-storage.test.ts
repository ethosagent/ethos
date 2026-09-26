import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
