import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBuiltinPersonalitiesDir } from '../builtin-personalities-dir';

const mainDir = '/App/Contents/Resources/app.asar/dist/main';
const packaged = join(mainDir, '..', '..', 'node_modules', '@ethosagent', 'personalities', 'data');
const srcNear = join(mainDir, '..', '..', 'extensions', 'personalities', 'data');
const srcFar = join(mainDir, '..', '..', '..', '..', 'extensions', 'personalities', 'data');

const only =
  (...present: string[]) =>
  (p: string) =>
    present.includes(p);

describe('resolveBuiltinPersonalitiesDir', () => {
  it('finds the packaged asar node_modules copy', () => {
    expect(resolveBuiltinPersonalitiesDir(mainDir, only(packaged))).toBe(packaged);
  });

  it('prefers the source-tree candidate over node_modules (dev unchanged)', () => {
    expect(resolveBuiltinPersonalitiesDir(mainDir, only(packaged, srcNear))).toBe(srcNear);
  });

  it('finds the four-levels-up source-tree candidate', () => {
    expect(resolveBuiltinPersonalitiesDir(mainDir, only(srcFar))).toBe(srcFar);
  });

  it('returns undefined when nothing exists', () => {
    expect(resolveBuiltinPersonalitiesDir(mainDir, () => false)).toBeUndefined();
  });
});
