import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isExistingDirectory } from '../sensitive-paths';

describe('isExistingDirectory', () => {
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'is-dir-')));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('is true for a directory and for a symlink to one', () => {
    mkdirSync(join(base, 'd'));
    symlinkSync(join(base, 'd'), join(base, 'link'));
    expect(isExistingDirectory(join(base, 'd'))).toBe(true);
    expect(isExistingDirectory(join(base, 'link'))).toBe(true);
  });

  it('is false for a file, a missing path and a path under a file', () => {
    writeFileSync(join(base, 'f'), 'x');
    expect(isExistingDirectory(join(base, 'f'))).toBe(false);
    expect(isExistingDirectory(join(base, 'nope'))).toBe(false);
    expect(isExistingDirectory(join(base, 'f', 'child'))).toBe(false);
  });
});
