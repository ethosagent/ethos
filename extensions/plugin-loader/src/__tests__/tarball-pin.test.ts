// FU-1 — `plugins.lock` pins the npm tarball, and installing from a pin checks
// it before any of the plugin's code lands on disk.
//
// npm is an injected runner: `pack` writes a tarball into the directory it was
// given, `install` only records its argv. No network, no real npm.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ContextInjector, Logger } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { recordGrant } from '../grants';
import { PluginLoader } from '../index';
import type { PluginLockEntry } from '../lockfile';
import {
  fetchTarballIntegrity,
  installPackedTarball,
  installPinnedTarball,
  legacyPinWarning,
  PluginIntegrityError,
} from '../tarball-pin';

const PLUGINS_DIR = '/data/plugins';
const TARBALL = Buffer.from('published tarball bytes for @ethos-plugins/demo@2.0.1');
const TARBALL_NAME = 'ethos-plugins-demo-2.0.1.tgz';

function sri(bytes: string | Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

const TARBALL_PIN: PluginLockEntry = {
  package: '@ethos-plugins/demo',
  version: '2.0.1',
  registry: 'https://registry.npmjs.org',
  integrity: sri(TARBALL),
  integrityOf: 'tarball',
};

/** A legacy entry: the digest of package.json, and no `integrityOf` marker. */
const LEGACY_PIN: PluginLockEntry = {
  package: '@ethos-plugins/demo',
  version: '2.0.1',
  registry: 'https://registry.npmjs.org',
  integrity: sri(JSON.stringify({ name: '@ethos-plugins/demo', version: '2.0.1' })),
};

interface FakeNpm {
  calls: string[][];
  /** The --pack-destination npm pack was given, once it has run. */
  packDest: () => string;
  run: (args: string[]) => Promise<void>;
}

/**
 * `install <tgz>` also records the tarball in the prefix the way npm 11.12.1
 * does — a `file:` spec in package.json, a `file:` `resolved` in the lock —
 * so the rewrite `installPackedTarball` makes afterwards has something to act on.
 */
function fakeNpm(storage: InMemoryStorage, opts: { packFails?: boolean } = {}): FakeNpm {
  const calls: string[][] = [];
  let dest = '';
  return {
    calls,
    packDest: () => dest,
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'install') {
        const prefix = args[args.indexOf('--prefix') + 1] ?? '';
        await storage.mkdir(prefix);
        const tgz = args.at(-1) ?? '';
        const manifestPath = join(prefix, 'package.json');
        const manifest = JSON.parse((await storage.read(manifestPath)) ?? '{"dependencies":{}}');
        const spec = `file:${relative(prefix, tgz)}`;
        manifest.dependencies['@ethos-plugins/demo'] = spec;
        await storage.write(manifestPath, JSON.stringify(manifest));
        await storage.write(
          join(prefix, 'package-lock.json'),
          JSON.stringify({
            packages: {
              '': { dependencies: manifest.dependencies },
              'node_modules/@ethos-plugins/demo': {
                version: '2.0.1',
                resolved: spec,
                integrity: sri(readFileSync(tgz)),
              },
            },
          }),
        );
        return;
      }
      dest = args[args.indexOf('--pack-destination') + 1] ?? '';
      if (opts.packFails) throw new Error('npm ERR! 404 Not Found');
      writeFileSync(join(dest, TARBALL_NAME), TARBALL);
    },
  };
}

function installCalls(npm: FakeNpm): string[][] {
  return npm.calls.filter((args) => args[0] === 'install');
}

describe('installPinnedTarball', () => {
  it('refuses a tarball whose SRI does not match the pin before npm install is invoked', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);
    const warnings: string[] = [];
    const pinned = sri('the bytes that were pinned');

    const attempt = installPinnedTarball({
      pluginId: 'demo',
      entry: { ...TARBALL_PIN, integrity: pinned },
      personalityId: 'researcher',
      pluginsDir: PLUGINS_DIR,
      storage,
      runNpm: npm.run,
      warn: (m) => warnings.push(m),
    });

    await expect(attempt).rejects.toBeInstanceOf(PluginIntegrityError);
    await expect(attempt).rejects.toMatchObject({ expected: pinned, actual: sri(TARBALL) });
    expect(npm.calls.map((args) => args[0])).toEqual(['pack']);
    expect(installCalls(npm)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('installs a matching tarball from the verified file, with --ignore-scripts', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);

    const result = await installPinnedTarball({
      pluginId: 'demo',
      entry: TARBALL_PIN,
      personalityId: 'researcher',
      pluginsDir: PLUGINS_DIR,
      storage,
      runNpm: npm.run,
      warn: () => {},
    });

    expect(result).toEqual({ verified: true });
    expect(npm.calls).toEqual([
      [
        'pack',
        '@ethos-plugins/demo@2.0.1',
        '--pack-destination',
        npm.packDest(),
        '--ignore-scripts',
      ],
      [
        'install',
        '--prefix',
        PLUGINS_DIR,
        '--ignore-scripts',
        '--no-audit',
        join(npm.packDest(), TARBALL_NAME),
      ],
    ]);
  });

  it('warns about a legacy package.json-digest entry and installs it without throwing', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);
    const warnings: string[] = [];

    const result = await installPinnedTarball({
      pluginId: 'demo',
      entry: LEGACY_PIN,
      personalityId: 'researcher',
      pluginsDir: PLUGINS_DIR,
      storage,
      runNpm: npm.run,
      warn: (m) => warnings.push(m),
    });

    expect(result).toEqual({ verified: false });
    expect(warnings).toEqual([
      'plugins.lock entry "demo" (@ethos-plugins/demo@2.0.1) pins a package.json digest, written before plugin pins covered the package tarball; it cannot verify the plugin\'s code, so @ethos-plugins/demo@2.0.1 is being installed UNVERIFIED. Re-pin it with: ethos plugin install @ethos-plugins/demo@2.0.1 --personality researcher',
    ]);
    expect(warnings[0]).toBe(legacyPinWarning('demo', '@ethos-plugins/demo@2.0.1', 'researcher'));
    expect(installCalls(npm)).toHaveLength(1);
  });

  it('removes the scratch directory after a successful install', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);
    await installPinnedTarball({
      pluginId: 'demo',
      entry: TARBALL_PIN,
      personalityId: 'researcher',
      pluginsDir: PLUGINS_DIR,
      storage,
      runNpm: npm.run,
      warn: () => {},
    });
    expect(npm.packDest()).toContain('ethos-plugin-pack-');
    expect(existsSync(npm.packDest())).toBe(false);
  });

  it('removes the scratch directory after a refused mismatch', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);
    await expect(
      installPinnedTarball({
        pluginId: 'demo',
        entry: { ...TARBALL_PIN, integrity: sri('something else') },
        personalityId: 'researcher',
        pluginsDir: PLUGINS_DIR,
        storage,
        runNpm: npm.run,
        warn: () => {},
      }),
    ).rejects.toBeInstanceOf(PluginIntegrityError);
    expect(npm.packDest()).not.toBe('');
    expect(existsSync(npm.packDest())).toBe(false);
  });

  it('removes the scratch directory when npm pack itself fails', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage, { packFails: true });
    await expect(
      installPinnedTarball({
        pluginId: 'demo',
        entry: TARBALL_PIN,
        personalityId: 'researcher',
        pluginsDir: PLUGINS_DIR,
        storage,
        runNpm: npm.run,
        warn: () => {},
      }),
    ).rejects.toThrow('404');
    expect(npm.packDest()).not.toBe('');
    expect(existsSync(npm.packDest())).toBe(false);
    expect(installCalls(npm)).toEqual([]);
  });
});

describe('installPackedTarball', () => {
  it('leaves the prefix naming the exact version, not the deleted scratch tarball, and keeps other plugins', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(PLUGINS_DIR);
    await storage.write(
      join(PLUGINS_DIR, 'package.json'),
      JSON.stringify({ dependencies: { 'ethos-plugin-other': '1.0.0' } }),
    );
    const npm = fakeNpm(storage);

    const result = await installPackedTarball({
      package: '@ethos-plugins/demo',
      version: '2.0.1',
      pluginsDir: PLUGINS_DIR,
      storage,
      expected: { integrity: sri(TARBALL), from: 'expected by this test' },
      runNpm: npm.run,
    });

    expect(result).toEqual({ integrity: sri(TARBALL) });
    expect(existsSync(npm.packDest())).toBe(false);
    const manifest = JSON.parse((await storage.read(join(PLUGINS_DIR, 'package.json'))) ?? '');
    expect(manifest.dependencies).toEqual({
      'ethos-plugin-other': '1.0.0',
      '@ethos-plugins/demo': '2.0.1',
    });
    const lock = JSON.parse((await storage.read(join(PLUGINS_DIR, 'package-lock.json'))) ?? '');
    expect(lock.packages[''].dependencies['@ethos-plugins/demo']).toBe('2.0.1');
    expect(lock.packages['node_modules/@ethos-plugins/demo']).toEqual({
      version: '2.0.1',
      integrity: sri(TARBALL),
    });
  });

  it('names where the expected digest came from when it refuses', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);
    await expect(
      installPackedTarball({
        package: '@ethos-plugins/demo',
        version: '2.0.1',
        pluginsDir: PLUGINS_DIR,
        storage,
        expected: { integrity: sri('other bytes'), from: 'npm recorded for the scanned copy' },
        runNpm: npm.run,
      }),
    ).rejects.toThrow(`does not match the ${sri('other bytes')} npm recorded for the scanned copy`);
    expect(installCalls(npm)).toEqual([]);
    expect(await storage.read(join(PLUGINS_DIR, 'package.json'))).toBeNull();
  });
});

describe('fetchTarballIntegrity', () => {
  it('returns the sha512 SRI of the packed tarball', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);
    expect(
      await fetchTarballIntegrity({
        package: '@ethos-plugins/demo',
        version: '2.0.1',
        runNpm: npm.run,
      }),
    ).toBe(sri(TARBALL));
    expect(existsSync(npm.packDest())).toBe(false);
  });

  it('refuses a version that is not exact without invoking npm', async () => {
    const storage = new InMemoryStorage();
    const npm = fakeNpm(storage);
    await expect(
      fetchTarballIntegrity({
        package: '@ethos-plugins/demo',
        version: 'unknown',
        runNpm: npm.run,
      }),
    ).rejects.toThrow('not a registry package name with an exact version');
    expect(npm.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The production caller: PluginLoader auto-install from plugins.lock
// ---------------------------------------------------------------------------

function makeRegistries(): PluginRegistries {
  const injectors: ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    injectorPluginIds: new Map<ContextInjector, string>(),
    personalities: new DefaultPersonalityRegistry(),
    llmProviders: new DefaultLLMProviderRegistry(),
    memoryProviders: new DefaultMemoryProviderRegistry(),
  };
}

async function autoInstall(entry: PluginLockEntry) {
  const storage = new InMemoryStorage();
  const personalityDir = '/data/personalities/researcher';
  await storage.mkdir(personalityDir);
  await storage.mkdir(join(PLUGINS_DIR, 'node_modules'));
  await storage.write(join(personalityDir, 'plugins.lock'), JSON.stringify({ demo: entry }));
  await recordGrant(storage, PLUGINS_DIR, {
    id: 'demo',
    package: entry.package,
    version: entry.version,
    source: `npm:${entry.package}@${entry.version}`,
    capabilities: { shell: false, network: null },
    scan: { tier: 'community', findings: [], hasRed: false, hasYellow: false },
    grantedAt: '2026-09-13T10:00:00.000Z',
    consent: 'interactive',
  });

  const warnings: string[] = [];
  const errors: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: (msg: string) => errors.push(msg),
  } as unknown as Logger;
  const npm = fakeNpm(storage);
  const loader = new PluginLoader(makeRegistries(), {
    storage,
    dataDir: '/data',
    logger,
    runNpm: npm.run,
  });
  await loader.resolveFromLockfile(personalityDir, ['demo']);
  return { npm, warnings, errors };
}

describe('PluginLoader.resolveFromLockfile verifies the tarball pin', () => {
  it('logs the refusal and never runs npm install on a mismatch', async () => {
    const { npm, errors } = await autoInstall({ ...TARBALL_PIN, integrity: sri('tampered') });
    expect(errors.join('\n')).toContain('Refusing to install @ethos-plugins/demo@2.0.1');
    expect(installCalls(npm)).toEqual([]);
  });

  it('installs the verified tarball on a match', async () => {
    const { npm, errors } = await autoInstall(TARBALL_PIN);
    expect(errors).toEqual([]);
    expect(installCalls(npm)).toEqual([
      [
        'install',
        '--prefix',
        PLUGINS_DIR,
        '--ignore-scripts',
        '--no-audit',
        join(npm.packDest(), TARBALL_NAME),
      ],
    ]);
  });

  it('warns about a legacy entry and does not throw', async () => {
    const { warnings, errors } = await autoInstall(LEGACY_PIN);
    expect(errors).toEqual([]);
    expect(warnings).toContain(
      `[plugin-loader] ${legacyPinWarning('demo', '@ethos-plugins/demo@2.0.1', 'researcher')}`,
    );
  });
});
