import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  draftPluginGrant,
  type PluginGrant,
  readGrants,
  readLockfile,
  recordGrant,
  writeLockfile,
} from '@ethosagent/plugin-loader';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findInstalledPkgDir,
  type InstallScannedPluginInput,
  installScannedPlugin,
  PluginInstallUndoneError,
  readScannedIntegrity,
} from '../commands/plugin';

let testDir: string;

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

  it('the scan download does not run lifecycle scripts', () => {
    // The final install's --ignore-scripts is pinned by behaviour below
    // (`installScannedPlugin`); the scan download is a spawnSync call in
    // `installPlugin`, so its flag is pinned on the source.
    const src = readFileSync(join(import.meta.dirname, '../commands/plugin.ts'), 'utf-8');
    expect(src).toContain("['install', '--prefix', tmpDir, '--ignore-scripts', '--no-audit', pkg]");
  });
});

// ---------------------------------------------------------------------------
// FU-1 — the CLI installs the bytes it scanned, from a verified tarball
// ---------------------------------------------------------------------------

const PKG = '@ethos-plugins/demo';
const VERSION = '2.0.1';
const EARLIER = '1.0.0';
const PLUGINS_DIR = '/data/plugins';
const PERSONALITIES_DIR = '/data/personalities';
const PERSONALITY_DIR = '/data/personalities/researcher';
const TARBALL = Buffer.from('published tarball bytes for @ethos-plugins/demo@2.0.1');
const TARBALL_NAME = tarballName(VERSION);

function tarballName(version: string): string {
  return `ethos-plugins-demo-${version}.tgz`;
}

/** The bytes the fake `npm pack` writes for a version: TARBALL for VERSION, a fixed per-version buffer otherwise. */
function tarballFor(version: string): Buffer {
  return version === VERSION ? TARBALL : Buffer.from(`${PKG}@${version} tarball`);
}

function sri(bytes: string | Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

const { draft } = draftPluginGrant({
  pkgJson: { name: PKG, version: VERSION },
  requestedSpec: PKG,
  scan: { tier: 'community', findings: [], hasRed: false, hasYellow: false },
});

/** The grant `installPlugin` hands `installScannedPlugin` once consent is taken. */
const GRANT: PluginGrant = { ...draft, grantedAt: '2026-09-13T00:00:00.000Z', consent: 'flag' };

interface FakeNpmOptions {
  packFails?: boolean;
  /** `npm install <tgz>` exits non-zero before writing anything. */
  installFails?: boolean;
  /** `npm uninstall` exits non-zero and removes nothing. */
  uninstallFails?: boolean;
}

/**
 * npm, as far as these tests need it. `pack <pkg>@<v>` writes that version's
 * tarball into its destination. `install <tgz>` puts the package in
 * `node_modules` and records the tarball the way npm 11.12.1 does: a `file:`
 * spec in the prefix's package.json and a `file:` `resolved` in its
 * package-lock.json. `uninstall` removes the package and its record. A bare
 * `install` of the prefix fails ENOENT on a `file:` reference whose file is gone
 * — what real npm does with no node_modules and an empty cache — and otherwise
 * keeps what is recorded.
 */
function fakeNpm(storage: InMemoryStorage, opts: FakeNpmOptions = {}) {
  const calls: string[][] = [];
  let packDest = '';
  const run = async (args: string[]): Promise<void> => {
    calls.push(args);
    if (args[0] === 'pack') {
      packDest = args[args.indexOf('--pack-destination') + 1] ?? '';
      if (opts.packFails) throw new Error('npm error 404 Not Found');
      const version = (args[1] ?? '').slice(`${PKG}@`.length);
      writeFileSync(join(packDest, tarballName(version)), tarballFor(version));
      return;
    }
    const prefix = args[args.indexOf('--prefix') + 1] ?? '';
    await storage.mkdir(prefix);
    const manifestPath = join(prefix, 'package.json');
    const lockPath = join(prefix, 'package-lock.json');
    const pkgDir = join(prefix, 'node_modules', PKG);
    const manifest = JSON.parse((await storage.read(manifestPath)) ?? '{"dependencies":{}}');
    const lock = JSON.parse(
      (await storage.read(lockPath)) ?? '{"packages":{"":{"dependencies":{}}}}',
    );
    if (args[0] === 'uninstall') {
      if (opts.uninstallFails) throw new Error('npm error EACCES');
      if (await storage.exists(pkgDir)) await storage.remove(pkgDir, { recursive: true });
      delete manifest.dependencies[PKG];
      delete lock.packages[''].dependencies[PKG];
      delete lock.packages[`node_modules/${PKG}`];
      await storage.write(manifestPath, JSON.stringify(manifest));
      await storage.write(lockPath, JSON.stringify(lock));
      return;
    }
    const last = args.at(-1) ?? '';
    if (last.endsWith('.tgz')) {
      if (opts.installFails) throw new Error('npm error code EBADPLATFORM');
      const version = last.match(/-(\d+\.\d+\.\d+)\.tgz$/)?.[1] ?? '';
      const spec = `file:${relative(prefix, last)}`;
      await storage.mkdir(pkgDir);
      await storage.write(join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version }));
      manifest.dependencies[PKG] = spec;
      lock.packages[''].dependencies[PKG] = spec;
      lock.packages[`node_modules/${PKG}`] = {
        version,
        resolved: spec,
        integrity: sri(readFileSync(last)),
      };
      await storage.write(manifestPath, JSON.stringify(manifest));
      await storage.write(lockPath, JSON.stringify(lock));
      return;
    }
    const refs = [
      ...Object.values(manifest.dependencies),
      ...Object.values(lock.packages).map((p) => (p as { resolved?: unknown }).resolved),
    ];
    for (const ref of refs) {
      if (typeof ref === 'string' && ref.startsWith('file:')) {
        if (!existsSync(resolve(prefix, ref.slice('file:'.length)))) {
          throw new Error(`npm error enoent ${ref}`);
        }
      }
    }
  };
  return { calls, run, packDest: () => packDest };
}

type FakeNpm = ReturnType<typeof fakeNpm>;

async function personalityStorage(storage = new InMemoryStorage()): Promise<InMemoryStorage> {
  await storage.mkdir(PERSONALITY_DIR);
  await storage.write(join(PERSONALITY_DIR, 'config.yaml'), 'name: researcher\n');
  return storage;
}

function install(
  storage: InMemoryStorage,
  npm: FakeNpm,
  extra: Partial<InstallScannedPluginInput> = {},
) {
  return installScannedPlugin({
    storage,
    pluginsDir: PLUGINS_DIR,
    grant: GRANT,
    scannedIntegrity: sri(TARBALL),
    personalitiesDir: PERSONALITIES_DIR,
    runNpm: npm.run,
    ...extra,
  });
}

async function rejection(attempt: Promise<unknown>): Promise<PluginInstallUndoneError> {
  const err = await attempt.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PluginInstallUndoneError);
  return err as PluginInstallUndoneError;
}

function steps(npm: FakeNpm): string[] {
  return npm.calls.map((args) => args[0] ?? '');
}

describe('installScannedPlugin — the commit half of ethos plugin install', () => {
  it('packs, checks the tarball against the scanned integrity, installs that file with --ignore-scripts, and pins the same SRI', async () => {
    const storage = await personalityStorage();
    const npm = fakeNpm(storage);

    const entry = await install(storage, npm, { personalityId: 'researcher' });

    // One pack: the pin is the SRI of the tarball installed, not a second fetch.
    expect(npm.calls).toEqual([
      ['pack', `${PKG}@${VERSION}`, '--pack-destination', npm.packDest(), '--ignore-scripts'],
      [
        'install',
        '--prefix',
        PLUGINS_DIR,
        '--ignore-scripts',
        '--no-audit',
        join(npm.packDest(), TARBALL_NAME),
      ],
    ]);
    expect(entry).toEqual({
      package: PKG,
      version: VERSION,
      registry: 'https://registry.npmjs.org',
      integrity: sri(TARBALL),
      integrityOf: 'tarball',
    });
    expect((await readLockfile(storage, PERSONALITY_DIR)).demo).toEqual(entry);
    expect((await readGrants(storage, PLUGINS_DIR)).demo).toEqual(GRANT);
  });

  it('records the grant before npm install runs', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);
    let grantAtInstall: PluginGrant | undefined;
    await install(storage, {
      ...npm,
      run: async (args) => {
        if (args[0] === 'install') grantAtInstall = (await readGrants(storage, PLUGINS_DIR)).demo;
        await npm.run(args);
      },
    });
    expect(grantAtInstall).toEqual(GRANT);
  });

  it('installs nothing and pins nothing when the tarball differs from the scanned copy', async () => {
    const storage = await personalityStorage();
    const npm = fakeNpm(storage);

    const err = await rejection(
      install(storage, npm, {
        scannedIntegrity: sri('the bytes the scan read'),
        personalityId: 'researcher',
      }),
    );

    expect(err.message).toContain('the safety scan read');
    expect(steps(npm)).toEqual(['pack']);
    expect(await storage.read(join(PLUGINS_DIR, 'package.json'))).toBeNull();
    expect(await storage.read(join(PERSONALITY_DIR, 'plugins.lock'))).toBeNull();
  });

  it('installs nothing and pins nothing when npm pack fails', async () => {
    const storage = await personalityStorage();
    const npm = fakeNpm(storage, { packFails: true });

    const err = await rejection(install(storage, npm, { personalityId: 'researcher' }));

    expect(err.message).toContain('404');
    expect(steps(npm)).toEqual(['pack']);
    expect(existsSync(npm.packDest())).toBe(false);
    expect(await storage.read(join(PLUGINS_DIR, 'package.json'))).toBeNull();
    expect(await storage.read(join(PERSONALITY_DIR, 'plugins.lock'))).toBeNull();
  });
});

/** InMemoryStorage whose first `writeAtomic` to `path` throws, as a full disk or a permission error would. */
class FailsOnce extends InMemoryStorage {
  private failed = false;

  constructor(private readonly path: string) {
    super();
  }

  override async writeAtomic(path: string, content: string): Promise<void> {
    if (!this.failed && path === this.path) {
      this.failed = true;
      throw new Error('EACCES: permission denied');
    }
    return super.writeAtomic(path, content);
  }
}

/** InMemoryStorage whose `write` to the personality's config.yaml throws once `failing` is set. */
class ConfigWriteFails extends InMemoryStorage {
  failing = false;

  override async write(path: string, content: string): Promise<void> {
    if (this.failing && path === join(PERSONALITY_DIR, 'config.yaml')) {
      throw new Error('EACCES: permission denied');
    }
    return super.write(path, content);
  }
}

/** A grant recorded for the earlier copy, before this attempt. */
const EARLIER_GRANT: PluginGrant = {
  ...draft,
  version: EARLIER,
  source: `npm:${PKG}@${EARLIER}`,
  grantedAt: '2026-01-01T00:00:00.000Z',
  consent: 'interactive',
};

/** Put PKG@EARLIER in the plugins folder with its grant, pinned in researcher's plugins.lock, as an earlier install would. */
async function installEarlierCopy(storage: InMemoryStorage, npm: FakeNpm): Promise<void> {
  const tgz = join(testDir, tarballName(EARLIER));
  writeFileSync(tgz, tarballFor(EARLIER));
  await npm.run(['install', '--prefix', PLUGINS_DIR, '--ignore-scripts', '--no-audit', tgz]);
  await recordGrant(storage, PLUGINS_DIR, EARLIER_GRANT);
  await writeLockfile(storage, PERSONALITY_DIR, {
    demo: {
      package: PKG,
      version: EARLIER,
      registry: 'https://registry.npmjs.org',
      integrity: sri(tarballFor(EARLIER)),
      integrityOf: 'tarball',
    },
  });
  npm.calls.length = 0;
}

async function installedVersion(storage: InMemoryStorage): Promise<string | null> {
  const src = await storage.read(join(PLUGINS_DIR, 'node_modules', PKG, 'package.json'));
  return src === null ? null : (JSON.parse(src) as { version: string }).version;
}

describe('ethos plugin install undoes a failure after the grant is recorded', () => {
  const uninstall = `npm uninstall --prefix ${PLUGINS_DIR} ${PKG}`;
  const retry = `Fix what the error reports, then retry: ethos plugin install ${PKG}@${VERSION}`;
  const grantRemoved =
    'The capability grant this attempt recorded for demo was removed; none was recorded before it.';
  const grantRestored =
    'The capability grant recorded for demo before this attempt was put back as it was.';

  it('(1) a failed npm pack puts back the grant recorded before the attempt, and says nothing was installed', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage, { packFails: true });
    await recordGrant(storage, PLUGINS_DIR, EARLIER_GRANT);

    const err = await rejection(install(storage, npm));

    expect(err.message).toBe(
      `Fetching the verified tarball of ${PKG}@${VERSION} failed (npm error 404 Not Found). Nothing was installed. ${grantRestored}`,
    );
    expect(err.action).toBe(retry);
    expect(steps(npm)).toEqual(['pack']);
    expect((await readGrants(storage, PLUGINS_DIR)).demo).toEqual(EARLIER_GRANT);
  });

  it('(1) a tarball that differs from the scanned copy deletes the grant this attempt recorded — not a revocation', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);

    const err = await rejection(install(storage, npm, { scannedIntegrity: sri('scanned bytes') }));

    expect(err.message).toBe(
      `The npm tarball of ${PKG}@${VERSION} does not match the copy the safety scan read (expected ${sri('scanned bytes')}, got ${sri(TARBALL)}). Nothing was installed. ${grantRemoved}`,
    );
    expect(await readGrants(storage, PLUGINS_DIR)).toEqual({});
  });

  it('(1) a failed npm install that left nothing on disk puts back the earlier grant', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage, { installFails: true });
    await recordGrant(storage, PLUGINS_DIR, EARLIER_GRANT);

    const err = await rejection(install(storage, npm));

    expect(err.message).toBe(
      `npm install of the verified tarball of ${PKG}@${VERSION} failed (npm error code EBADPLATFORM). Nothing was installed. ${grantRestored}`,
    );
    expect(steps(npm)).toEqual(['pack', 'install']);
    expect((await readGrants(storage, PLUGINS_DIR)).demo).toEqual(EARLIER_GRANT);
  });

  it('(2) a failed package-lock.json rewrite uninstalls what npm installed and removes its grant, rather than reporting a failed install over a loadable one', async () => {
    const storage = new FailsOnce(join(PLUGINS_DIR, 'package-lock.json'));
    const npm = fakeNpm(storage);

    const err = await rejection(install(storage, npm));

    expect(err.message).toBe(
      `npm installed the verified tarball of ${PKG}@${VERSION}, but rewriting ${PLUGINS_DIR}/package.json and package-lock.json to record it failed (EACCES: permission denied). The install was rolled back (${uninstall}): nothing from this attempt was left installed. ${grantRemoved}`,
    );
    expect(err.action).toBe(retry);
    expect(steps(npm)).toEqual(['pack', 'install', 'uninstall']);
    expect(await installedVersion(storage)).toBeNull();
    expect(await readGrants(storage, PLUGINS_DIR)).toEqual({});
  });

  it('(2) on an upgrade, the same failure reinstalls the earlier copy from its verified pin and puts its grant back', async () => {
    const storage = await personalityStorage(new FailsOnce(join(PLUGINS_DIR, 'package-lock.json')));
    const npm = fakeNpm(storage);
    await installEarlierCopy(storage, npm);

    const err = await rejection(install(storage, npm));

    expect(err.message).toBe(
      `npm installed the verified tarball of ${PKG}@${VERSION}, but rewriting ${PLUGINS_DIR}/package.json and package-lock.json to record it failed (EACCES: permission denied). The install was rolled back (${uninstall}), and the copy installed before this attempt, ${PKG}@${EARLIER}, which npm replaced during this attempt, was reinstalled from the tarball pinned in personality researcher's plugins.lock after its SRI matched the pin: ${PKG}@${EARLIER} is installed again, and nothing from this attempt was left installed. ${grantRestored}`,
    );
    expect(steps(npm)).toEqual(['pack', 'install', 'uninstall', 'pack', 'install']);
    expect(npm.calls[3]?.[1]).toBe(`${PKG}@${EARLIER}`);
    expect(await installedVersion(storage)).toBe(EARLIER);
    expect((await readGrants(storage, PLUGINS_DIR)).demo).toEqual(EARLIER_GRANT);
  });

  it('keeps the grant with the package when the rollback fails, and gives the command that removes it', async () => {
    const storage = new FailsOnce(join(PLUGINS_DIR, 'package-lock.json'));
    const npm = fakeNpm(storage, { uninstallFails: true });

    const err = await rejection(install(storage, npm));

    expect(err.message).toBe(
      `npm installed the verified tarball of ${PKG}@${VERSION}, but rewriting ${PLUGINS_DIR}/package.json and package-lock.json to record it failed (EACCES: permission denied). Rolling the install back failed (npm uninstall failed: npm error EACCES), so the package was left on disk and will load on the next start. The capability grant this attempt recorded for demo (${PKG}@${VERSION}) was kept, because that package is still on disk.`,
    );
    expect(err.action).toBe(`Remove it before ethos next starts, with: ${uninstall}`);
    expect(await installedVersion(storage)).toBe(VERSION);
    expect((await readGrants(storage, PLUGINS_DIR)).demo).toEqual(GRANT);
  });

  it('--personality: a pin that cannot be written undoes the install and the half-written plugins.lock entry, as the web install does', async () => {
    const storage = new ConfigWriteFails();
    await personalityStorage(storage);
    storage.failing = true;
    const npm = fakeNpm(storage);

    const err = await rejection(install(storage, npm, { personalityId: 'researcher' }));

    expect(err.message).toBe(
      `npm installed the verified tarball of ${PKG}@${VERSION}, but pinning it to personality researcher failed (EACCES: permission denied). The install was rolled back (${uninstall}): nothing from this attempt was left installed. ${grantRemoved} The demo entry this attempt wrote to personality researcher's plugins.lock was removed.`,
    );
    expect(err.action).toBe(`${retry} --personality researcher`);
    expect(steps(npm)).toEqual(['pack', 'install', 'uninstall']);
    expect(await installedVersion(storage)).toBeNull();
    expect(await readGrants(storage, PLUGINS_DIR)).toEqual({});
    expect(await readLockfile(storage, PERSONALITY_DIR)).toEqual({});
    expect(await storage.read(join(PERSONALITY_DIR, 'config.yaml'))).toBe('name: researcher\n');
  });
});

describe('the plugins folder after a verified install', () => {
  it('records the exact version rather than the deleted scratch tarball, and a later npm install keeps the plugin', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);
    await install(storage, npm);

    expect(existsSync(npm.packDest())).toBe(false);
    const manifestSrc = (await storage.read(join(PLUGINS_DIR, 'package.json'))) ?? '';
    const lockSrc = (await storage.read(join(PLUGINS_DIR, 'package-lock.json'))) ?? '';
    expect(manifestSrc).not.toContain('file:');
    expect(lockSrc).not.toContain('file:');
    expect(JSON.parse(manifestSrc).dependencies).toEqual({ [PKG]: VERSION });
    const lock = JSON.parse(lockSrc);
    expect(lock.packages[''].dependencies).toEqual({ [PKG]: VERSION });
    // No `resolved`: npm re-resolves the exact version from the registry and
    // checks the download against this integrity — the verified tarball's.
    expect(lock.packages[`node_modules/${PKG}`]).toEqual({
      version: VERSION,
      integrity: sri(TARBALL),
    });

    await npm.run(['install', '--prefix', PLUGINS_DIR, '--ignore-scripts', '--no-audit']);
    expect(
      JSON.parse((await storage.read(join(PLUGINS_DIR, 'package.json'))) ?? '').dependencies,
    ).toEqual({ [PKG]: VERSION });
  });

  it('the simulated npm fails that rebuild while the record still names a deleted scratch file', async () => {
    // Guards the simulation above: without the rewrite, the same bare install fails.
    const storage = new InMemoryStorage();
    await storage.mkdir(PLUGINS_DIR);
    await storage.write(
      join(PLUGINS_DIR, 'package.json'),
      JSON.stringify({
        dependencies: {
          [PKG]: `file:${relative(PLUGINS_DIR, join(tmpdir(), 'ethos-plugin-pack-gone', TARBALL_NAME))}`,
        },
      }),
    );
    await expect(
      fakeNpm(storage).run(['install', '--prefix', PLUGINS_DIR, '--ignore-scripts', '--no-audit']),
    ).rejects.toThrow('enoent');
  });
});

describe('readScannedIntegrity', () => {
  const INTEGRITY = sri(TARBALL);

  async function scannedPrefix(lockName: string, entry: unknown): Promise<string> {
    const pkgDir = join(testDir, 'node_modules', '@ethos-plugins', 'demo');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(testDir, lockName),
      JSON.stringify({ packages: { 'node_modules/@ethos-plugins/demo': entry } }),
    );
    return pkgDir;
  }

  it('reads the integrity npm recorded in the scan prefix package-lock.json', async () => {
    const pkgDir = await scannedPrefix('package-lock.json', {
      version: VERSION,
      integrity: INTEGRITY,
    });
    expect(await readScannedIntegrity(testDir, pkgDir, PKG)).toBe(INTEGRITY);
  });

  it('falls back to the hidden lockfile npm writes under package-lock=false', async () => {
    await mkdir(join(testDir, 'node_modules'), { recursive: true });
    const pkgDir = await scannedPrefix(join('node_modules', '.package-lock.json'), {
      version: VERSION,
      integrity: INTEGRITY,
    });
    expect(await readScannedIntegrity(testDir, pkgDir, PKG)).toBe(INTEGRITY);
  });

  it('fails closed when npm recorded no sha512 integrity (a git or local spec)', async () => {
    const pkgDir = await scannedPrefix('package-lock.json', {
      version: VERSION,
      resolved: 'git+ssh://git@github.com/example/demo.git#main',
    });
    await expect(readScannedIntegrity(testDir, pkgDir, 'github:example/demo')).rejects.toThrow(
      EthosError,
    );
  });
});
