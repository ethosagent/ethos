import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findInstalledPkgDir } from '../commands/plugin';

let testDir;
beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-plugin-install-test-${Date.now()}-${process.pid}`);
  await mkdir(testDir, { recursive: true });
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});
describe('findInstalledPkgDir', () => {
  it('returns the installed package directory when it exists', async () => {
    // Simulate a successful npm install --prefix tmpDir my-plugin:
    // npm writes tmpDir/package.json with {dependencies: {my-plugin: ...}}
    // and installs the package to tmpDir/node_modules/my-plugin/
    await writeFile(
      join(testDir, 'package.json'),
      JSON.stringify({ dependencies: { 'my-plugin': '^1.0.0' } }),
    );
    await mkdir(join(testDir, 'node_modules', 'my-plugin'), { recursive: true });
    await writeFile(
      join(testDir, 'node_modules', 'my-plugin', 'package.json'),
      JSON.stringify({ name: 'my-plugin', version: '1.0.0' }),
    );
    const dir = await findInstalledPkgDir(testDir, 'my-plugin');
    expect(dir).toBe(join(testDir, 'node_modules', 'my-plugin'));
  });
  it('fails closed when the npm manifest lists a package but node_modules dir is absent', async () => {
    // npm wrote the manifest but the directory is missing (unusual spec, corrupted install, etc.)
    await writeFile(
      join(testDir, 'package.json'),
      JSON.stringify({ dependencies: { 'unresolvable-pkg': 'git+https://example.com/repo' } }),
    );
    // Deliberately do NOT create node_modules/unresolvable-pkg/
    await expect(findInstalledPkgDir(testDir, 'unresolvable-pkg')).rejects.toThrow(EthosError);
  });
  it('fails closed when the npm manifest is absent', async () => {
    // No package.json at all — npm may not have run, or tarballs / unusual paths
    await expect(findInstalledPkgDir(testDir, 'some-pkg')).rejects.toThrow(EthosError);
  });
  it('fails closed when manifest has no dependencies', async () => {
    await writeFile(join(testDir, 'package.json'), JSON.stringify({ dependencies: {} }));
    await expect(findInstalledPkgDir(testDir, 'some-pkg')).rejects.toThrow(EthosError);
  });
  it('fails closed when manifest has multiple dependencies (ambiguous)', async () => {
    await writeFile(
      join(testDir, 'package.json'),
      JSON.stringify({ dependencies: { 'pkg-a': '1.0.0', 'pkg-b': '2.0.0' } }),
    );
    await expect(findInstalledPkgDir(testDir, 'pkg-a')).rejects.toThrow(EthosError);
  });
  it('lifecycle scripts cannot bypass the scan: both temp and final npm install use --ignore-scripts', () => {
    // Regression guard: verify the plugin.ts source includes --ignore-scripts in
    // the final npm install invocation (not just the temp scan install).
    // If someone accidentally removes the flag, this test catches it.
    // We read the source rather than mocking spawnSync because the important
    // invariant is that the flag is present in both call sites — a structural
    // property of the code, not a runtime behavior.
    const { readFileSync } = require('node:fs');
    const { join: pathJoin } = require('node:path');
    const src = readFileSync(pathJoin(import.meta.dirname, '../commands/plugin.ts'), 'utf-8');
    // Count occurrences of '--ignore-scripts' in npm install calls
    const matches = src.match(/['"]--ignore-scripts['"]/g) ?? [];
    // Should appear at least twice: once for the temp scan install, once for the final install
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
