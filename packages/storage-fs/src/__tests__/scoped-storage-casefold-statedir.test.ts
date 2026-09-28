// UBP-008 — deny comparisons fold case on case-insensitive filesystems.
// UBP-047 — a grant that is an ANCESTOR of the Ethos state dir does not reach
// into it. Mirror of packages/core/src/__tests__/scoped-fs-casefold-statedir.test.ts.

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(foldDenyKey('/h/Keys.json', false)).toBe('/h/Keys.json');
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
