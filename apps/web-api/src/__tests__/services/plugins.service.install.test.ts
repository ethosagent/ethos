// P-T14 — `PluginsService.install` leaves the same record behind as
// `ethos plugin install`: a consent grant, and (when given a `personalityId`) a
// lock pin. No current web caller passes a `personalityId`, so every install
// from the web UI today records the grant only.
// npm is replaced by a fake that lays down what `npm install --prefix` would.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import {
  computeIntegrity,
  PluginLoader,
  readGrants,
  readLockfile,
  revokeGrant,
} from '@ethosagent/plugin-loader';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ContextInjector } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginsService } from '../../services/plugins.service';

const PKG = 'ethos-plugin-demo';

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

let dataDir: string;
let npmCalls: string[][];

beforeEach(async () => {
  dataDir = join(
    tmpdir(),
    `ethos-plugins-install-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dataDir, { recursive: true });
  npmCalls = [];
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Stands in for `npm install --prefix <dir> ... <spec>`. */
async function fakeNpm(args: string[]): Promise<void> {
  npmCalls.push(args);
  const prefix = args[args.indexOf('--prefix') + 1] ?? '';
  const pkgDir = join(prefix, 'node_modules', PKG);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(prefix, 'package.json'),
    JSON.stringify({ dependencies: { [PKG]: '^1.2.3' } }),
  );
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: PKG,
      version: '1.2.3',
      type: 'module',
      main: 'index.ts',
      ethos: {
        type: 'plugin',
        pluginContractMajor: 4,
        permissions: { shell: true, network: ['api.example.com'] },
      },
    }),
  );
  await writeFile(
    join(pkgDir, 'index.ts'),
    `export async function activate(api) {
  api.registerTool({
    name: 'demo_tool',
    description: 'Test tool',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: 'ran' }; },
  });
}`,
  );
}

function makeService(storage = new FsStorage()): PluginsService {
  return new PluginsService({ storage, dataDir, runNpm: fakeNpm });
}

describe('PluginsService.install records consent', () => {
  it('records an interactive grant carrying the declared ethos.permissions', async () => {
    await makeService().install(PKG);

    expect(npmCalls).toHaveLength(1);
    expect(npmCalls[0]).toContain('--ignore-scripts');

    const grants = await readGrants(new FsStorage(), join(dataDir, 'plugins'));
    expect(grants[PKG]).toMatchObject({
      id: PKG,
      package: PKG,
      version: '1.2.3',
      source: `npm:${PKG}@1.2.3`,
      consent: 'interactive',
      capabilities: { shell: true, network: ['api.example.com'] },
      scan: { tier: 'community', hasRed: false },
    });
    expect(grants[PKG]?.revokedAt).toBeUndefined();
  });

  it('writes a plugins.lock entry identical in shape to a CLI install', async () => {
    const storage = new FsStorage();
    const personalityDir = join(dataDir, 'personalities', 'researcher');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(join(personalityDir, 'config.yaml'), 'name: researcher\n');

    await makeService(storage).install(PKG, { personalityId: 'researcher' });

    const lockfile = await readLockfile(storage, personalityDir);
    // Exactly the entry `installPlugin` built before the helper was extracted:
    // registry literal, and integrity = digest of the installed package.json (FU-1).
    expect(lockfile[PKG]).toEqual({
      package: PKG,
      version: '1.2.3',
      registry: 'https://registry.npmjs.org',
      integrity: await computeIntegrity(
        join(dataDir, 'plugins', 'node_modules', PKG, 'package.json'),
      ),
    });
    expect(Object.keys(lockfile[PKG] ?? {})).toEqual([
      'package',
      'version',
      'registry',
      'integrity',
    ]);
    expect(await storage.read(join(personalityDir, 'config.yaml'))).toContain(`plugins: ${PKG}`);
  });

  it('revoking the web-recorded grant stops the plugin loading on the next load', async () => {
    const storage = new FsStorage();
    await makeService(storage).install(PKG);
    const nmDir = join(dataDir, 'plugins', 'node_modules');

    const first = new PluginLoader(makeRegistries(), { storage, dataDir });
    await first.loadFromNodeModules(nmDir);
    expect(first.isLoaded(PKG)).toBe(true);

    expect(await revokeGrant(storage, join(dataDir, 'plugins'), PKG)).toBe(true);

    const registries = makeRegistries();
    const next = new PluginLoader(registries, { storage, dataDir });
    await next.loadFromNodeModules(nmDir);
    expect(next.isLoaded(PKG)).toBe(false);
    expect(registries.tools.get('demo_tool')).toBeUndefined();
    expect(next.getFailures().find((m) => m.id === PKG)?.error).toContain(
      'revoked capability grant',
    );
  });

  it('refuses a personality id that is not a plain identifier before running npm', async () => {
    await expect(makeService().install(PKG, { personalityId: '../escape' })).rejects.toThrow(
      'Invalid personality id',
    );
    expect(npmCalls).toHaveLength(0);
  });
});
