// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentsService } from '../../services/documents.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

// `reachable`'s symlink walk must fail CLOSED: an `lstat` that errors with
// anything but ENOENT is "I could not look", not "nothing to see". The same
// rule its three siblings enforce (`followFirstSymlink` in
// packages/core/src/scoped/scoped-fs.ts, packages/storage-fs/src/scoped-storage.ts
// and packages/wiring/src/backup/restore.ts). An unreadable segment is simulated
// by making `lstat` throw EACCES for exactly one path; every other call goes to
// the real implementation.

const failing = vi.hoisted(() => ({ path: null as string | null, code: 'EACCES' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: (async (path: Parameters<typeof real.lstat>[0], ...rest: unknown[]) => {
      if (failing.path !== null && String(path) === failing.path) {
        throw Object.assign(new Error(`${failing.code}: simulated, lstat '${String(path)}'`), {
          code: failing.code,
        });
      }
      return (real.lstat as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.lstat,
  };
});

function personality(workdir: string): PersonalityConfig {
  return { id: 'writer', name: 'Writer', fs_reach: { workdir } } as PersonalityConfig;
}

describe('DocumentsService symlink walk fails closed', () => {
  let dataDir: string;
  let workdir: string;
  let service: DocumentsService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-documents-fc-'));
    workdir = join(dataDir, 'workspace', 'writer');
    await mkdir(join(workdir, 'real'), { recursive: true });
    await writeFile(join(workdir, 'real', 'f.txt'), 'hello');
    // A link that stays INSIDE the root: ScopedStorage's own symbolic check
    // passes it, so the Documents walk is the only layer that refuses it.
    await symlink(join(workdir, 'real'), join(workdir, 'alias'));
    service = new DocumentsService({
      personalities: makeStubPersonalityRegistry([personality('${ETHOS_HOME}/workspace/${self}')]),
      dataDir,
      storage: new FsStorage(),
    });
  });

  afterEach(async () => {
    failing.path = null;
    failing.code = 'EACCES';
    await rm(dataDir, { recursive: true, force: true });
  });

  it('refuses a path whose segment cannot be lstat-ed (EACCES) instead of serving it', async () => {
    failing.path = join(workdir, 'alias');
    await expect(
      service.resolveDownload({ root: '0', path: join('alias', 'f.txt') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses on ENOTDIR too, matching the sibling walks', async () => {
    failing.path = join(workdir, 'real');
    failing.code = 'ENOTDIR';
    await expect(
      service.resolveDownload({ root: '0', path: join('real', 'f.txt') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('never leaks the absolute path in the uncheckable refusal', async () => {
    failing.path = join(workdir, 'alias');
    const err = await service
      .resolveDownload({ root: '0', path: join('alias', 'f.txt') })
      .then(() => null)
      .catch((e: unknown) => e as { cause?: string; action?: string });
    expect(err).not.toBeNull();
    expect(`${err?.cause} ${err?.action}`).not.toContain(workdir);
  });

  it('still treats a missing segment (ENOENT) as the end of the walk', async () => {
    const entry = await service.createFolder({}, '0', 'fresh');
    expect(entry).toMatchObject({ name: 'fresh', isDir: true });
    await expect(service.list({ root: '0', path: join('nope', 'deeper') })).resolves.toEqual({
      entries: [],
    });
  });
});
