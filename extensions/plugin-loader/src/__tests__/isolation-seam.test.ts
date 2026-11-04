import { spawnSync } from 'node:child_process';
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
import type { EthosPlugin, PluginRegistries } from '@ethosagent/plugin-sdk';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ContextInjector } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginActivationRequest, PluginActivator } from '../activator-types';
import { recordGrant, revokeGrant } from '../grants';
import { type PluginIsolationMeta, PluginLoader, type PluginLoaderOptions } from '../index';

// Plan plugin-process-isolation §5.4.2 / §5.9 (D8, D23): the loader decides
// import-vs-host at one seam, and every refusal runs before a spawn. The
// activator here is a fake; plugin-loader must not depend on plugin-host.

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

const IMPORT_COUNT_KEY = '__isolationSeamImports';

// Top-level code: counts imports in THIS process (globalThis) and drops a marker
// file under $HOME, which is the host's private HOME when run by `runInHost`.
const FIXTURE_ENTRY = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
globalThis.${IMPORT_COUNT_KEY} = (globalThis.${IMPORT_COUNT_KEY} ?? 0) + 1;
writeFileSync(join(process.env.HOME ?? '', 'seam-marker'), 'imported');
export async function activate(api) {
  api.registerTool({
    name: 'seam_tool',
    description: 'seam',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: 'x' }; },
  });
}
`.trim();

const RED_ENTRY = `
globalThis.${IMPORT_COUNT_KEY} = (globalThis.${IMPORT_COUNT_KEY} ?? 0) + 1;
export async function activate() { eval(String(1 + 1)); }
`.trim();

let root: string;
let pluginsDir: string;
let dataDir: string;
let hostHome: string;

beforeEach(async () => {
  root = join(
    tmpdir(),
    `ethos-isolation-seam-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  pluginsDir = join(root, 'plugins');
  dataDir = join(root, 'data');
  hostHome = join(root, 'host-home');
  await mkdir(pluginsDir, { recursive: true });
  await mkdir(hostHome, { recursive: true });
  (globalThis as Record<string, unknown>)[IMPORT_COUNT_KEY] = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePlugin(
  id: string,
  opts: { entry?: string; major?: number } = {},
): Promise<string> {
  const dir = join(pluginsDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      type: 'module',
      ethos: { type: 'plugin', pluginContractMajor: opts.major ?? 4 },
    }),
  );
  await writeFile(join(dir, 'index.js'), opts.entry ?? FIXTURE_ENTRY);
  return dir;
}

function parentImports(): number {
  return Number((globalThis as Record<string, unknown>)[IMPORT_COUNT_KEY] ?? 0);
}

/** A stand-in for the plugin host: imports the entry in a CHILD process with a private HOME. */
function runInHost(req: PluginActivationRequest): void {
  const res = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(`file://${req.entry}`)})`],
    { env: { PATH: process.env.PATH ?? '', HOME: hostHome }, encoding: 'utf-8' },
  );
  if (res.status !== 0) throw new Error(`host child failed: ${res.stderr}`);
}

function fakeActivator(): PluginActivator & { activate: ReturnType<typeof vi.fn> } {
  const activate = vi.fn(async (req: PluginActivationRequest): Promise<EthosPlugin> => {
    runInHost(req);
    return {
      activate(api) {
        api.registerTool({
          name: 'seam_tool',
          description: 'hosted',
          capabilities: {},
          schema: { type: 'object', properties: {} },
          async execute() {
            return { ok: true, value: 'hosted' };
          },
        });
      },
      deactivate: vi.fn(),
    };
  });
  return { activate };
}

function loaderWith(
  registries: PluginRegistries,
  extra: Partial<PluginLoaderOptions> = {},
): PluginLoader {
  return new PluginLoader(registries, { storage: new FsStorage(), dataDir, ...extra });
}

const hostAlways = (): 'host' => 'host';

async function markerExists(dir: string): Promise<boolean> {
  return new FsStorage().exists(join(dir, 'seam-marker'));
}

describe('loader isolation seam', () => {
  it('host mode never imports the entry in the parent', async () => {
    const registries = makeRegistries();
    const activator = fakeActivator();
    const dir = await writePlugin('seam-ok');
    const loader = loaderWith(registries, { isolationFor: hostAlways, activator });

    await loader.loadFromPluginDir(dir, 'seam-ok');

    expect(activator.activate).toHaveBeenCalledTimes(1);
    const req = activator.activate.mock.calls[0]?.[0] as PluginActivationRequest;
    expect(req).toMatchObject({ id: 'seam-ok', dir });
    expect(req.entry.endsWith('index.js')).toBe(true);
    expect(parentImports()).toBe(0);
    expect(await markerExists(hostHome)).toBe(true);
    expect(registries.tools.get('seam_tool')).toBeDefined();
    expect(loader.getFailures()).toEqual([]);
  });

  it('imports in the parent when isolation resolves to in-process', async () => {
    const registries = makeRegistries();
    const activator = fakeActivator();
    const dir = await writePlugin('seam-local', {
      entry: FIXTURE_ENTRY.replace(/writeFileSync\([^\n]*\n/, ''),
    });
    const loader = loaderWith(registries, { isolationFor: () => 'in-process', activator });

    await loader.loadFromPluginDir(dir, 'seam-local');

    expect(activator.activate).not.toHaveBeenCalled();
    expect(parentImports()).toBe(1);
  });

  it('hands isolationFor the facts the policy needs, including the grant catalogTier', async () => {
    const dir = await writePlugin('seam-meta');
    await recordGrant(new FsStorage(), join(dataDir, 'plugins'), {
      id: 'seam-meta',
      package: 'seam-meta',
      version: '1.0.0',
      source: 'catalog',
      capabilities: { shell: false, network: null },
      scan: { tier: 'untrusted', findings: [], hasRed: false, hasYellow: false },
      grantedAt: '2026-01-01T00:00:00.000Z',
      consent: 'flag',
      catalogTier: 'community',
    });
    const seen: PluginIsolationMeta[] = [];
    const loader = loaderWith(makeRegistries(), {
      isolationFor: (meta) => {
        seen.push(meta);
        return 'in-process';
      },
    });

    await loader.loadFromPluginDir(dir, 'seam-meta');

    expect(seen).toEqual([
      {
        pluginId: 'seam-meta',
        packageName: 'seam-meta',
        installLocation: 'plugins-dir',
        catalogTier: 'community',
      },
    ]);
  });

  it('logs the policy notice', async () => {
    const dir = await writePlugin('seam-notice');
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const loader = loaderWith(makeRegistries(), {
      logger: logger as unknown as PluginLoaderOptions['logger'],
      isolationFor: () => ({ mode: 'in-process', notice: 'policy says hello' }),
    });

    await loader.loadFromPluginDir(dir, 'seam-notice');

    expect(warn.mock.calls.some((c) => String(c[0]).includes('policy says hello'))).toBe(true);
  });

  it('a red scan finding refuses before any spawn', async () => {
    const activator = fakeActivator();
    const dir = await writePlugin('seam-red', { entry: RED_ENTRY });
    const loader = loaderWith(makeRegistries(), { isolationFor: hostAlways, activator });

    await loader.loadFromPluginDir(dir, 'seam-red');

    expect(activator.activate).not.toHaveBeenCalled();
    expect(parentImports()).toBe(0);
    expect(loader.getFailures().map((f) => f.id)).toEqual(['seam-red']);
  });

  it('a revoked grant refuses before any spawn', async () => {
    const activator = fakeActivator();
    const dir = await writePlugin('seam-revoked');
    const storage = new FsStorage();
    await recordGrant(storage, join(dataDir, 'plugins'), {
      id: 'seam-revoked',
      package: 'seam-revoked',
      version: '1.0.0',
      source: 'npm:seam-revoked@1.0.0',
      capabilities: { shell: false, network: null },
      scan: { tier: 'untrusted', findings: [], hasRed: false, hasYellow: false },
      grantedAt: '2026-01-01T00:00:00.000Z',
      consent: 'flag',
    });
    await revokeGrant(storage, join(dataDir, 'plugins'), 'seam-revoked');
    const loader = loaderWith(makeRegistries(), { isolationFor: hostAlways, activator });

    await loader.loadFromPluginDir(dir, 'seam-revoked');

    expect(activator.activate).not.toHaveBeenCalled();
    expect(await markerExists(hostHome)).toBe(false);
    expect(loader.getFailures().map((f) => f.id)).toEqual(['seam-revoked']);
  });

  it('a contract-major mismatch refuses before any spawn', async () => {
    const activator = fakeActivator();
    const dir = await writePlugin('seam-major', { major: 99 });
    const loader = loaderWith(makeRegistries(), { isolationFor: hostAlways, activator });

    await loader.loadFromPluginDir(dir, 'seam-major');

    expect(activator.activate).not.toHaveBeenCalled();
    expect(await markerExists(hostHome)).toBe(false);
    expect(loader.getFailures().map((f) => f.id)).toEqual(['seam-major']);
  });

  it('no activator wired + host configured fails closed and is not imported in-process', async () => {
    const registries = makeRegistries();
    const dir = await writePlugin('seam-closed');
    const loader = loaderWith(registries, { isolationFor: hostAlways });

    await loader.loadFromPluginDir(dir, 'seam-closed');

    expect(parentImports()).toBe(0);
    expect(registries.tools.get('seam_tool')).toBeUndefined();
    const failures = loader.getFailures();
    expect(failures.map((f) => f.id)).toEqual(['seam-closed']);
    expect(failures[0]?.error).toContain('plugin host');
  });

  it('an activator that rejects records the plugin as failed and does not import it', async () => {
    const dir = await writePlugin('seam-reject');
    const activator: PluginActivator = {
      activate: async () => {
        throw new Error('host did not become ready');
      },
    };
    const loader = loaderWith(makeRegistries(), { isolationFor: hostAlways, activator });

    await loader.loadFromPluginDir(dir, 'seam-reject');

    expect(parentImports()).toBe(0);
    expect(loader.getFailures()[0]?.error).toContain('host did not become ready');
  });

  it('releases the lease of a hosted plugin the loader then refuses (missing dependency)', async () => {
    const dir = await writePlugin('seam-dep');
    const pkgPath = join(dir, 'package.json');
    await writeFile(
      pkgPath,
      JSON.stringify({
        name: 'seam-dep',
        version: '1.0.0',
        type: 'module',
        ethos: { type: 'plugin', pluginContractMajor: 4, dependencies: ['not-loaded'] },
      }),
    );
    const deactivate = vi.fn();
    const activator: PluginActivator = {
      activate: async () => ({ activate() {}, deactivate }),
    };
    const loader = loaderWith(makeRegistries(), { isolationFor: hostAlways, activator });

    await loader.loadFromPluginDir(dir, 'seam-dep');

    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(loader.getFailures()[0]?.error).toContain('Missing dependency');
  });
  it('routes the node_modules import site through the same seam', async () => {
    const nm = join(root, 'node_modules');
    const pkgDir = join(nm, 'ethos-plugin-seam-nm');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'ethos-plugin-seam-nm',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        ethos: { type: 'plugin', pluginContractMajor: 4 },
      }),
    );
    await writeFile(join(pkgDir, 'index.js'), FIXTURE_ENTRY);
    const seen: PluginIsolationMeta[] = [];
    const activator = fakeActivator();
    const registries = makeRegistries();
    const loader = loaderWith(registries, {
      isolationFor: (meta) => {
        seen.push(meta);
        return 'host';
      },
      activator,
    });

    await loader.loadFromNodeModules(nm);

    expect(seen[0]).toMatchObject({
      packageName: 'ethos-plugin-seam-nm',
      installLocation: 'node_modules',
    });
    expect(activator.activate).toHaveBeenCalledTimes(1);
    expect(parentImports()).toBe(0);
    expect(registries.tools.get('seam_tool')).toBeDefined();
  });
});
