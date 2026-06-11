import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSkillsCatalogDir } from '../lib/resolve-skills-catalog-dir';

describe('resolveSkillsCatalogDir', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-skills-catalog-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('resolves the packaged layout: <pkg>/dist → <pkg>/skills', () => {
    const pkg = makeTempDir();
    mkdirSync(join(pkg, 'dist'));
    mkdirSync(join(pkg, 'skills', 'dummy-skill'), { recursive: true });

    expect(resolveSkillsCatalogDir(join(pkg, 'dist'), {})).toBe(join(pkg, 'skills'));
  });

  it('resolves the dev layout: <repo>/apps/ethos/src/commands → <repo>/skills', () => {
    const repo = makeTempDir();
    const commandsDir = join(repo, 'apps', 'ethos', 'src', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(join(repo, 'skills'));

    expect(resolveSkillsCatalogDir(commandsDir, {})).toBe(join(repo, 'skills'));
  });

  it('prefers ETHOS_SKILLS_CATALOG_DIR over existing candidates', () => {
    const pkg = makeTempDir();
    mkdirSync(join(pkg, 'dist'));
    mkdirSync(join(pkg, 'skills'));

    const override = join(pkg, 'custom-catalog');
    expect(resolveSkillsCatalogDir(join(pkg, 'dist'), { ETHOS_SKILLS_CATALOG_DIR: override })).toBe(
      override,
    );
  });

  it('returns undefined and warns when no candidate exists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const empty = makeTempDir();

    expect(resolveSkillsCatalogDir(join(empty, 'dist'), {})).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('ETHOS_SKILLS_CATALOG_DIR');
  });
});
