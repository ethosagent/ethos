import { join } from 'node:path';
import { sensitiveDenyPaths } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { isWriteBlocked } from '../index';

// Parity: the write tools must block every path in the canonical manifest
// (and, since each is a prefix, everything beneath it). Fails if
// BLOCKED_WRITE_* stops covering a manifest path.
describe('deny-manifest parity — tools-file write blocklist', () => {
  it.each(sensitiveDenyPaths())('write-blocks the manifest path %s', (path) => {
    expect(isWriteBlocked(path)).toBe(true);
    expect(isWriteBlocked(join(path, 'child'))).toBe(true);
  });
});
