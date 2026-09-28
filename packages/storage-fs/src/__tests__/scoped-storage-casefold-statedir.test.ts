// UBP-008 — deny comparisons fold case on case-insensitive filesystems.
// UBP-047 — a grant that is an ANCESTOR of the Ethos state dir does not reach
// into it. Mirror of packages/core/src/__tests__/scoped-fs-casefold-statedir.test.ts.

import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryError, isUnmappablePathAlias } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsStorage } from '../fs-storage';
import { ScopedStorage } from '../scoped-storage';
import { CASE_INSENSITIVE_FS, foldDenyKey } from '../sensitive-paths';

describe('foldDenyKey (UBP-008)', () => {
  it('folds case, including characters whose lowercase alone would miss', () => {
    expect(foldDenyKey('/h/.SSH/id_rsa', true)).toBe('/h/.ssh/id_rsa');
    expect(foldDenyKey('/h/Keys.json', true)).toBe(foldDenyKey('/h/keys.json', true));
    expect(foldDenyKey('/h/ſoul.md', true)).toBe(foldDenyKey('/h/SOUL.md', true));
  });

  it('is the identity on a case-sensitive filesystem', () => {
    expect(foldDenyKey('/h/Keys.json', false, false)).toBe('/h/Keys.json');
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

  // V2-SEC-1: /.nofollow/<p> and /.resolve/<n>/<p> open /<p> on macOS.
  it('maps the macOS /.nofollow and /.resolve/<n> alias prefixes onto the plain path', () => {
    const plain = foldDenyKey('/Users/u/.ssh/id', true, true);
    for (const alias of [
      '/.nofollow/Users/u/.ssh/id',
      '/.resolve/1/Users/u/.ssh/id',
      '/.resolve/0/Users/u/.ssh/id',
      '/.resolve/16/Users/u/.ssh/id',
      '/.resolve/1/System/Volumes/Data/.nofollow/Users/u/.ssh/id',
      '/System/Volumes/Data/.nofollow/Users/u/.ssh/id',
      '/.NOFOLLOW/Users/u/.ssh/id',
    ]) {
      expect(foldDenyKey(alias, true, true)).toBe(plain);
    }
    expect(foldDenyKey('/.nofollow', true, true)).toBe('/');
    expect(foldDenyKey('/.nofollowx/a', true, true)).toBe('/.nofollowx/a');
    expect(foldDenyKey('/.resolve/x/a', true, true)).toBe('/.resolve/x/a');
    expect(foldDenyKey('/.nofollow/a', false, false)).toBe('/.nofollow/a');
  });

  // The boundary's refusal of an inode alias is `isUnmappablePathAlias`
  // (@ethosagent/types, applied by `matchesDenyPrefix`), on every platform.
  it('names /.vol/<dev>/<inode> as an alias a string cannot resolve', () => {
    expect(isUnmappablePathAlias('/.vol/16777232/2')).toBe(true);
    expect(isUnmappablePathAlias('/.VOL')).toBe(true);
    expect(isUnmappablePathAlias('/.nofollow/.vol/1/2')).toBe(true);
    expect(isUnmappablePathAlias('/.volume/x')).toBe(false);
  });
});

// V-ES-1 / V-ES-3 against the real volume. Gated on darwin (not on
// CASE_INSENSITIVE_FS) so a Mac run cannot silently skip them.
describe.skipIf(process.platform !== 'darwin')('ScopedStorage on APFS (V-ES-1, V-ES-3)', () => {
  let home: string;
  let scoped: ScopedStorage;
  const saved = process.env.ETHOS_STATE_DIR;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scoped-apfs-')));
    await mkdir(join(home, '.ssh'), { recursive: true });
    await writeFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE-KEY');
    await writeFile(join(home, 'sessions.db'), 'SESSIONS');
    await mkdir(join(home, 'caf\u00e9'), { recursive: true });
    await writeFile(join(home, 'caf\u00e9', 'k'), 'NFC');
    const state = join(home, '.ethos');
    await mkdir(join(state, 'personalities', 'therapist'), { recursive: true });
    await writeFile(join(state, 'personalities', 'therapist', 'MEMORY.md'), 'THERAPIST-PRIVATE');
    process.env.ETHOS_STATE_DIR = state;
    scoped = new ScopedStorage(new FsStorage(), {
      read: ['/'],
      write: ['/'],
      alwaysDeny: [join(home, '.ssh'), join(home, 'sessions.db'), join(home, 'caf\u00e9')],
    });
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
      await expect(scoped.read(p)).rejects.toThrow(/always-deny floor/);
    }
  });

  it('refuses the /System/Volumes/Data alias of the deny floor and the state dir', async () => {
    const alias = (p: string) => `/System/Volumes/Data${p}`;
    await expect(scoped.read(alias(join(home, '.ssh', 'id_ed25519')))).rejects.toThrow(
      /always-deny floor/,
    );
    const other = join(home, '.ethos', 'personalities', 'therapist', 'MEMORY.md');
    await expect(scoped.read(alias(other))).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.write(alias(other), 'x')).rejects.toBeInstanceOf(BoundaryError);
    expect(await readFile(other, 'utf8')).toBe('THERAPIST-PRIVATE');
  });

  // V2-SEC-1 (verify2-sec/firm2.mts): the kernel opens every one of these as
  // the plain path, so each must hit the same deny key.
  it('refuses the /.nofollow, /.resolve/<n> and /.vol aliases of the floor and the state dir', async () => {
    const key = join(home, '.ssh', 'id_ed25519');
    const other = join(home, '.ethos', 'personalities', 'therapist', 'MEMORY.md');
    expect(await readFile(`/.nofollow${key}`, 'utf8')).toBe('PRIVATE-KEY');
    const st = await stat(other);
    const vol = `/.vol/${st.dev}/${st.ino}`;
    expect(await readFile(vol, 'utf8')).toBe('THERAPIST-PRIVATE');
    for (const prefix of ['/.nofollow', '/.resolve/1', '/.resolve/0', '/.resolve/1/.nofollow']) {
      await expect(scoped.read(`${prefix}${key}`)).rejects.toThrow(/always-deny floor/);
      await expect(scoped.exists(`${prefix}${join(home, '.ssh')}`)).rejects.toThrow(
        /always-deny floor/,
      );
      await expect(scoped.read(`${prefix}${other}`)).rejects.toBeInstanceOf(BoundaryError);
      await expect(scoped.write(`${prefix}${other}`, 'OVERWRITTEN')).rejects.toBeInstanceOf(
        BoundaryError,
      );
    }
    await expect(scoped.read(vol)).rejects.toThrow(/always-deny floor/);
    await expect(scoped.write(vol, 'OVERWRITTEN')).rejects.toThrow(/always-deny floor/);
    expect(await readFile(other, 'utf8')).toBe('THERAPIST-PRIVATE');
  });
});

describe.skipIf(!CASE_INSENSITIVE_FS)(
  'ScopedStorage on a case-insensitive volume (UBP-008)',
  () => {
    let home: string;
    let own: string;
    let scoped: ScopedStorage;

    beforeEach(async () => {
      home = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scoped-fold-')));
      own = join(home, 'personalities', 'bob');
      await mkdir(own, { recursive: true });
      await writeFile(join(own, 'toolset.yaml'), '- read_file\n');
      scoped = new ScopedStorage(new FsStorage(), {
        read: [`${home}/`],
        write: [`${own}/`],
        alwaysDeny: [join(home, '.ssh'), join(home, 'keys.json')],
        writeDeny: [join(own, 'toolset.yaml'), join(own, 'SOUL.md'), `${join(own, 'skills')}/`],
      });
    });

    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it('refuses case variants of the write-deny list', async () => {
      for (const p of ['TOOLSET.yaml', 'Soul.md', join('SKILLS', 'x')]) {
        await expect(scoped.write(join(own, p), '- terminal\n')).rejects.toBeInstanceOf(
          BoundaryError,
        );
      }
      await expect(
        scoped.remove(join(home, 'PERSONALITIES', 'bob'), { recursive: true }),
      ).rejects.toBeInstanceOf(BoundaryError);
      expect(await readFile(join(own, 'toolset.yaml'), 'utf8')).toBe('- read_file\n');
    });

    it('refuses case variants of the always-deny floor', async () => {
      await expect(scoped.read(join(home, '.SSH', 'x'))).rejects.toThrow(/always-deny floor/);
      await expect(scoped.read(join(home, 'Keys.json'))).rejects.toThrow(/always-deny floor/);
    });
  },
);

describe('state dir under an ancestor grant (UBP-047)', () => {
  let root: string;
  let state: string;
  let own: string;
  const saved = process.env.ETHOS_STATE_DIR;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'ethos-scoped-statedir-')));
    state = join(root, '.ethos');
    own = join(state, 'personalities', 'bob');
    await mkdir(own, { recursive: true });
    await mkdir(join(state, 'personalities', 'therapist'), { recursive: true });
    await writeFile(join(own, 'MEMORY.md'), 'mine');
    await writeFile(join(state, 'personalities', 'therapist', 'MEMORY.md'), 'private');
    await writeFile(join(state, 'delivery-ledger.db'), 'db');
    await writeFile(join(root, 'a.txt'), 'work');
    process.env.ETHOS_STATE_DIR = state;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = saved;
    await rm(root, { recursive: true, force: true });
  });

  it('refuses other personalities and unlisted stores; keeps ownDir and the ancestor', async () => {
    const scoped = new ScopedStorage(new FsStorage(), {
      read: [`${own}/`, `${join(state, 'skills')}/`, root],
      write: [`${own}/`, root],
    });
    await expect(
      scoped.read(join(state, 'personalities', 'therapist', 'MEMORY.md')),
    ).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.read(join(state, 'delivery-ledger.db'))).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(
      scoped.write(join(state, 'personalities', 'therapist', 'MEMORY.md'), 'x'),
    ).rejects.toBeInstanceOf(BoundaryError);
    await expect(scoped.read(join(own, 'MEMORY.md'))).resolves.toBe('mine');
    await expect(scoped.read(join(root, 'a.txt'))).resolves.toBe('work');
  });

  it('an explicit grant OF the state dir is still honoured', async () => {
    const scoped = new ScopedStorage(new FsStorage(), { read: [`${state}/`], write: [] });
    await expect(scoped.read(join(state, 'personalities', 'therapist', 'MEMORY.md'))).resolves.toBe(
      'private',
    );
  });
});

// Post-merge round I — the state-dir exclusion judges the scope's `stateDirs`
// (I1), holds on the real target (I2), and folds case whatever the platform
// (I3). Mirror of the same block in
// packages/core/src/__tests__/scoped-fs-casefold-statedir.test.ts.
describe('state-dir exclusion — scope stateDirs, real target, platform (post-merge round I)', () => {
  let root: string;
  let dataDir: string;
  const saved = { HOME: process.env.HOME, ETHOS_STATE_DIR: process.env.ETHOS_STATE_DIR };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'ethos-statedir-i-')));
    dataDir = join(root, 'desktop-data');
    await mkdir(join(dataDir, 'personalities', 'therapist'), { recursive: true });
    await writeFile(join(dataDir, 'personalities', 'therapist', 'MEMORY.md'), 'private');
    await mkdir(join(root, 'project'), { recursive: true });
    await writeFile(join(root, 'project', 'a.txt'), 'work');
    // Neither `~/.ethos` nor ETHOS_STATE_DIR names the data dir.
    process.env.HOME = join(root, 'home');
    delete process.env.ETHOS_STATE_DIR;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const other = () => join(dataDir, 'personalities', 'therapist', 'MEMORY.md');
  const scopedFor = (reach: string[], stateDirs: string[] = [dataDir]) =>
    new ScopedStorage(new FsStorage(), { read: reach, write: reach, stateDirs });

  it('I1: an ancestor grant does not reach into a scope-only state dir', async () => {
    await expect(scopedFor([root]).read(other())).rejects.toBeInstanceOf(BoundaryError);
    await expect(scopedFor([root]).read(join(root, 'project', 'a.txt'))).resolves.toBe('work');
    // Control: without `stateDirs` the environment does not know the dir.
    await expect(scopedFor([root], []).read(other())).resolves.toBe('private');
  });

  it('I2: a granted symlink to an ancestor of a state dir does not reach into it', async () => {
    await mkdir(join(root, 'x'), { recursive: true });
    await symlink(root, join(root, 'x', 'link'));
    const link = join(root, 'x', 'link');
    const scoped = scopedFor([link]);
    const through = join(link, 'desktop-data', 'personalities', 'therapist', 'MEMORY.md');
    await expect(scoped.read(through)).rejects.toThrow(/state dir/);
    await expect(scoped.write(through, 'x')).rejects.toBeInstanceOf(BoundaryError);
    expect(await readFile(other(), 'utf8')).toBe('private');
    await expect(scoped.read(join(link, 'project', 'a.txt'))).resolves.toBe('work');
    // A grant whose realpath is AT the state dir is honoured through the link.
    await symlink(dataDir, join(root, 'x', 'data-link'));
    await expect(
      scopedFor([join(root, 'x', 'data-link')]).read(
        join(root, 'x', 'data-link', 'personalities', 'therapist', 'MEMORY.md'),
      ),
    ).resolves.toBe('private');
  });

  describe('I3: on a case-sensitive platform', () => {
    const platform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      vi.resetModules();
    });

    it('the exclusion still refuses a case variant of the state dir', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      vi.resetModules();
      const paths = await import('../sensitive-paths');
      const mod = await import('../scoped-storage');
      expect(paths.CASE_INSENSITIVE_FS).toBe(false);
      const variant = join(root, 'DESKTOP-DATA', 'personalities', 'therapist', 'MEMORY.md');
      const scoped = new mod.ScopedStorage(new FsStorage(), {
        read: [root],
        write: [root],
        stateDirs: [dataDir],
      });
      await expect(scoped.read(variant)).rejects.toThrow(/not permitted/);
    });
  });
});
