// Verification round A1 — the fold every deny comparison uses. Pins that it
// folds case and Unicode normalization, and the characters whose plain
// `toLowerCase()` would miss the letter a case-insensitive file system maps
// them to.

import { describe, expect, it } from 'vitest';
import { foldForDeny, isUnmappablePathAlias } from '../deny-fold';

describe('foldForDeny', () => {
  it('folds ASCII case', () => {
    expect(foldForDeny('/Users/U/.ETHOS/Personalities/A/TOOLSET.yaml')).toBe(
      '/users/u/.ethos/personalities/a/toolset.yaml',
    );
  });

  it('folds Unicode normalization (NFD and NFC compare equal)', () => {
    expect(foldForDeny('/home/José/.ethos')).toBe(foldForDeny('/home/josé/.ethos'));
  });

  it('folds the Kelvin sign and the long s to their plain letters', () => {
    expect(foldForDeny('Keys.json')).toBe('keys.json');
    expect(foldForDeny('ſoul.md')).toBe('soul.md');
  });

  // verification round E3 — `/System/Volumes/Data` is a firmlink on macOS.
  it('drops a leading /System/Volumes/Data firmlink root, in any case', () => {
    expect(foldForDeny('/System/Volumes/Data/Users/u/.ethos/MEMORY.md')).toBe(
      '/users/u/.ethos/memory.md',
    );
    expect(foldForDeny('/SYSTEM/volumes/DATA/Users/u')).toBe('/users/u');
    expect(foldForDeny('/System/Volumes/Data')).toBe('/');
    expect(foldForDeny('/System/Volumes/Data/')).toBe('/');
    expect(foldForDeny('/System/Volumes/DataX/u')).toBe('/system/volumes/datax/u');
    expect(foldForDeny('/opt/System/Volumes/Data/x')).toBe('/opt/system/volumes/data/x');
  });

  // verification round G3 — macOS `/.nofollow/<abs>` IS `<abs>`.
  it('drops a leading /.nofollow, in any case, before the firmlink', () => {
    expect(foldForDeny('/.nofollow/Users/u/.ethos/config.yaml')).toBe(
      '/users/u/.ethos/config.yaml',
    );
    expect(foldForDeny('/.NoFollow/System/Volumes/Data/Users/u')).toBe('/users/u');
    expect(foldForDeny('/.nofollow')).toBe('/');
    expect(foldForDeny('/.nofollowx/u')).toBe('/.nofollowx/u');
    expect(foldForDeny('/opt/.nofollow/u')).toBe('/opt/.nofollow/u');
  });
});

// verification round G3 — paths that name a file by device and inode (or a
// second `/.nofollow`) cannot be judged lexically; both boundaries refuse them.
describe('isUnmappablePathAlias', () => {
  it('is true for /.vol, /.resolve and a doubled /.nofollow, in any case', () => {
    for (const p of [
      '/.vol/16777220/2/Users/u/.ethos/sessions.db',
      '/.VOL/1/2',
      '/.resolve/1/2',
      '/.nofollow/.nofollow/Users/u',
      '/.nofollow/.vol/1/2',
      '/System/Volumes/Data/.vol/1/2',
    ]) {
      expect([p, isUnmappablePathAlias(p)]).toEqual([p, true]);
    }
  });

  it('is false for ordinary paths, a single /.nofollow, and those names deeper down', () => {
    for (const p of ['/Users/u/.ethos', '/.nofollow/Users/u', '/opt/.vol/1', '/.volume/x', '/']) {
      expect([p, isUnmappablePathAlias(p)]).toEqual([p, false]);
    }
  });
});
