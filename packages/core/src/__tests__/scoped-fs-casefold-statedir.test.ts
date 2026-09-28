// UBP-008 — deny comparisons fold case on case-insensitive filesystems.
// UBP-047 — a grant that is an ANCESTOR of the Ethos state dir (cwd `~` or
// `/`) does not reach into it, and a default cwd AT the state dir is dropped.
// Mirror of packages/storage-fs/src/__tests__/scoped-storage-casefold-statedir.test.ts.

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveFsReachPaths, personalityWriteDeny } from '../fs-reach';
import { CASE_INSENSITIVE_FS, foldDenyKey, ScopedFsImpl } from '../scoped/scoped-fs';

describe('foldDenyKey (UBP-008)', () => {
  it('folds case, including characters whose lowercase alone would miss', () => {
    expect(foldDenyKey('/h/.ethos/personalities/x/TOOLSET.yaml', true)).toBe(
      '/h/.ethos/personalities/x/toolset.yaml',
    );
    expect(foldDenyKey('/h/.SSH/id', true)).toBe(foldDenyKey('/h/.ssh/id', true));
    // U+017F LATIN SMALL LETTER LONG S and U+212A KELVIN SIGN case-fold to s / k.
    expect(foldDenyKey('/h/ſoul.md', true)).toBe(foldDenyKey('/h/SOUL.md', true));
    expect(foldDenyKey('/h/Keys.json', true)).toBe(foldDenyKey('/h/keys.json', true));
  });

  it('is the identity on a case-sensitive filesystem', () => {
    expect(foldDenyKey('/h/TOOLSET.yaml', false, false)).toBe('/h/TOOLSET.yaml');
  });

  // V-ES-1: U+1E9E CAPITAL SHARP S lowercases to ß and never reaches `ss`, but
  // APFS opens `.ẞh` as `.ssh`. A full fold (lower, upper, lower) lands it.
  it('folds U+1E9E and U+00DF onto ss, and NFD onto NFC', () => {
    expect(foldDenyKey('/h/.ẞh/id', true)).toBe(foldDenyKey('/h/.ssh/id', true));
    expect(foldDenyKey('/h/.ßh/id', true)).toBe(foldDenyKey('/h/.ssh/id', true));
    expect(foldDenyKey('/h/seẞions.db', true)).toBe(foldDenyKey('/h/sessions.db', true));
    expect(foldDenyKey('/h/cafe\u0301', true)).toBe(foldDenyKey('/h/caf\u00e9', true));
  });

  // V-ES-3: /System/Volumes/Data/<p> is the same file as /<p> on macOS.
  it('maps the macOS data-volume firmlink spelling onto the plain path', () => {
    expect(foldDenyKey('/System/Volumes/Data/Users/u/.ethos/x', true, true)).toBe(
      foldDenyKey('/Users/u/.ethos/x', true, true),
    );
    expect(foldDenyKey('/SYSTEM/volumes/DATA/Users/u/.ssh', true, true)).toBe('/users/u/.ssh');
    expect(foldDenyKey('/System/Volumes/Data', true, true)).toBe('/');
    expect(foldDenyKey('/System/Volumes/Database/x', true, true)).toBe(
      '/system/volumes/database/x',
    );
    expect(foldDenyKey('/System/Volumes/Data/Users/u', false, false)).toBe(
      '/System/Volumes/Data/Users/u',
    );
  });
});

// V-ES-1 / V-ES-3 against the real volume. Gated on darwin (not on
// CASE_INSENSITIVE_FS) so a Mac run cannot silently skip them.
describe.skipIf(process.platform !== 'darwin')('ScopedFsImpl on APFS (V-ES-1, V-ES-3)', () => {
  let home: string;
  let fs: ScopedFsImpl;
  const saved = process.env.ETHOS_STATE_DIR;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scopedfs-apfs-')));
    await mkdir(join(home, '.ssh'), { recursive: true });
    await writeFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE-KEY');
    await writeFile(join(home, 'sessions.db'), 'SESSIONS');
    await mkdir(join(home, 'caf\u00e9'), { recursive: true });
    await writeFile(join(home, 'caf\u00e9', 'k'), 'NFC');
    const state = join(home, '.ethos');
    await mkdir(join(state, 'personalities', 'therapist'), { recursive: true });
    await mkdir(join(state, 'personalities', 'bob'), { recursive: true });
    await writeFile(join(state, 'personalities', 'therapist', 'MEMORY.md'), 'THERAPIST-PRIVATE');
    process.env.ETHOS_STATE_DIR = state;
    fs = new ScopedFsImpl(
      new FsStorage(),
      new Set(['/']),
      new Set(['/']),
      [join(home, '.ssh'), join(home, 'sessions.db'), join(home, 'caf\u00e9')],
      [],
    );
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = saved;
    await rm(home, { recursive: true, force: true });
  });

  it('refuses the capital-sharp-s and NFD spellings of deny entries', async () => {
    for (const p of [
      join(home, '.ẞh', 'id_ed25519'),
      join(home, 'seẞions.db'),
      join(home, 'cafe\u0301', 'k'),
    ]) {
      await expect(fs.read(p)).rejects.toThrow(/always-deny floor/);
    }
  });

  it('refuses the /System/Volumes/Data alias of the deny floor and the state dir', async () => {
    const alias = (p: string) => `/System/Volumes/Data${p}`;
    await expect(fs.read(alias(join(home, '.ssh', 'id_ed25519')))).rejects.toThrow(
      /always-deny floor/,
    );
    const other = join(home, '.ethos', 'personalities', 'therapist', 'MEMORY.md');
    await expect(fs.read(alias(other))).rejects.toThrow(/^PATH_NOT_REACHABLE:/);
    await expect(fs.write(alias(other), 'x')).rejects.toThrow(/^PATH_NOT_REACHABLE:/);
    expect(await readFile(other, 'utf8')).toBe('THERAPIST-PRIVATE');
  });
});

describe.skipIf(!CASE_INSENSITIVE_FS)('ScopedFsImpl on a case-insensitive volume (UBP-008)', () => {
  let home: string;
  let own: string;
  let fs: ScopedFsImpl;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scopedfs-fold-')));
    own = join(home, 'personalities', 'bob');
    await mkdir(join(own, 'skills'), { recursive: true });
    await writeFile(join(own, 'toolset.yaml'), '- read_file\n');
    fs = new ScopedFsImpl(
      new FsStorage(),
      new Set([`${own}/`, home]),
      new Set([`${own}/`]),
      [join(home, '.ssh'), join(home, 'keys.json')],
      personalityWriteDeny(home, 'bob'),
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('refuses TOOLSET.yaml, Soul.md and SKILLS/x as personality definition', async () => {
    for (const p of ['TOOLSET.yaml', 'Soul.md', join('SKILLS', 'x')]) {
      await expect(fs.write(join(own, p), '- terminal\n')).rejects.toThrow(
        /^PATH_NOT_REACHABLE: .*personality definition is operator-owned/,
      );
    }
    expect(await readFile(join(own, 'toolset.yaml'), 'utf8')).toBe('- read_file\n');
  });

  it('refuses case variants of the deny floor', async () => {
    await expect(fs.read(join(home, '.SSH', 'x'))).rejects.toThrow(/always-deny floor/);
    await expect(fs.read(join(home, 'Keys.json'))).rejects.toThrow(/always-deny floor/);
  });
});

describe('state dir under an ancestor grant (UBP-047)', () => {
  let root: string;
  let state: string;
  let own: string;
  const saved = process.env.ETHOS_STATE_DIR;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'ethos-statedir-')));
    state = join(root, '.ethos');
    own = join(state, 'personalities', 'bob');
    await mkdir(own, { recursive: true });
    await mkdir(join(state, 'personalities', 'therapist'), { recursive: true });
    await mkdir(join(root, 'project'), { recursive: true });
    await writeFile(join(own, 'MEMORY.md'), 'mine');
    await writeFile(join(state, 'personalities', 'therapist', 'MEMORY.md'), 'private');
    await writeFile(join(root, 'project', 'a.txt'), 'work');
    process.env.ETHOS_STATE_DIR = state;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = saved;
    await rm(root, { recursive: true, force: true });
  });

  function scopedFor(cwd: string): ScopedFsImpl {
    const reach = deriveFsReachPaths(
      { id: 'bob', name: 'bob' } as Parameters<typeof deriveFsReachPaths>[0],
      { ethosHome: state, self: 'bob', cwd },
    );
    return new ScopedFsImpl(
      new FsStorage(),
      new Set(reach.read),
      new Set(reach.write),
      [],
      reach.writeDeny,
    );
  }

  it('with cwd at an ancestor, refuses another personality and keeps ownDir and cwd', async () => {
    const fs = scopedFor(root);
    await expect(fs.read(join(state, 'personalities', 'therapist', 'MEMORY.md'))).rejects.toThrow(
      /^PATH_NOT_REACHABLE:/,
    );
    await expect(
      fs.write(join(state, 'personalities', 'therapist', 'MEMORY.md'), 'x'),
    ).rejects.toThrow(/^PATH_NOT_REACHABLE:/);
    await expect(fs.read(join(own, 'MEMORY.md'))).resolves.toBe('mine');
    await expect(fs.read(join(root, 'project', 'a.txt'))).resolves.toBe('work');
  });

  it('with cwd AT the state dir, the default reach drops it', async () => {
    const reach = deriveFsReachPaths(
      { id: 'bob', name: 'bob' } as Parameters<typeof deriveFsReachPaths>[0],
      { ethosHome: state, self: 'bob', cwd: state },
    );
    expect(reach.read).not.toContain(state);
    expect(reach.write).not.toContain(state);
    const fs = scopedFor(state);
    await expect(fs.read(join(state, 'personalities', 'therapist', 'MEMORY.md'))).rejects.toThrow(
      /^PATH_NOT_REACHABLE:/,
    );
    await expect(fs.read(join(own, 'MEMORY.md'))).resolves.toBe('mine');
  });

  it('an explicit grant OF the state dir is still honoured', async () => {
    const fs = new ScopedFsImpl(new FsStorage(), new Set([`${state}/`]), new Set(), [], []);
    await expect(fs.read(join(state, 'personalities', 'therapist', 'MEMORY.md'))).resolves.toBe(
      'private',
    );
  });
});
