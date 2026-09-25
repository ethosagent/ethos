// `ethos doctor` — the state-directory filesystem check (openclaw-9.6-gaps R4).
//
// SQLite's WAL locking is unsafe on FUSE and network filesystems. Docker
// Desktop's bind mounts (virtiofs / gRPC-FUSE on macOS, 9p on Windows) are
// exactly that, so a state dir on one is a corruption risk the doctor names.

import type { StatsFs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkStateDirFilesystem } from '../doctor';

function statfsReturning(type: number): (path: string) => StatsFs {
  return () =>
    ({
      type,
      bsize: 4096,
      frsize: 4096,
      blocks: 1,
      bfree: 1,
      bavail: 1,
      files: 1,
      ffree: 1,
    }) as StatsFs;
}

describe('doctor — state dir filesystem', () => {
  it('warns on FUSE (virtiofs and gRPC-FUSE both report FUSE_SUPER_MAGIC)', () => {
    const result = checkStateDirFilesystem('/data', {
      statfs: statfsReturning(0x65735546),
      platform: 'linux',
    });
    expect(result.status).toBe('warn');
    expect(result.fsType).toBe('fuse');
    expect(result.message).toContain('SQLite');
  });

  it.each([
    [0x01021997, '9p'],
    [0x6969, 'nfs'],
    [0xff534d42, 'cifs'],
    [0xfe534d42, 'smb2'],
    [0x517b, 'smb'],
  ])('warns on network filesystem magic %s (%s)', (magic, name) => {
    const result = checkStateDirFilesystem('/data', {
      statfs: statfsReturning(magic),
      platform: 'linux',
    });
    expect(result.status).toBe('warn');
    expect(result.fsType).toBe(name);
  });

  it('is ok on a native filesystem (ext4)', () => {
    const result = checkStateDirFilesystem('/data', {
      statfs: statfsReturning(0xef53),
      platform: 'linux',
    });
    expect(result.status).toBe('ok');
  });

  it('does not classify on macOS, where statfs reports a per-boot type number', () => {
    // 0x65735546 is FUSE on Linux; on Darwin the same field is vfc_typenum,
    // which carries no stable meaning — the check must not pretend it does.
    const result = checkStateDirFilesystem('/data', {
      statfs: statfsReturning(0x65735546),
      platform: 'darwin',
    });
    expect(result.status).toBe('unknown');
  });

  it('reports absent when the directory does not exist', () => {
    const result = checkStateDirFilesystem('/nope', {
      statfs: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      platform: 'linux',
    });
    expect(result.status).toBe('absent');
  });
});
