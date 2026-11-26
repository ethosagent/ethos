import { join } from 'node:path';
import { sensitiveDenyPaths } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { shareLinksDbPath } from '../share';

describe('shareLinksDbPath', () => {
  it('is <dataDir>/share-links.db, the file name the deny lists and backup exclusion carry', () => {
    const dir = join('/tmp', 'ethos-data');
    expect(shareLinksDbPath(dir)).toBe(join(dir, 'share-links.db'));
    expect(sensitiveDenyPaths().some((p) => p.endsWith('share-links.db'))).toBe(true);
  });
});
