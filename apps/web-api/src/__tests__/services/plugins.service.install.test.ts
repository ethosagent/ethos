// P-T14 — `PluginsService.install` leaves the same record behind as
// `ethos plugin install`: a consent grant, and (when given a `personalityId`) a
// lock pin. The workspace plugins page (`/p/:personalityId/plugins`) passes its
// route's `personalityId` and so pins; the global Library Plugins page and the
// create wizard pass none and record the grant only.
//
// The install is VERIFIED like the CLI's: `npm view` names the exact version and
// its registry `dist.integrity`, `npm pack` fetches that tarball, and a tarball
// whose SRI differs is refused before `npm install` runs. npm is replaced by a
// fake that answers `view`, `pack`, `install` and `uninstall`, and `node:child_process` is
// mocked to throw — so a call that bypassed the injected runner would fail here
// rather than reach the registry.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  type PluginGrant,
  PluginLoader,
  readGrants,
  readLockfile,
  recordGrant,
  revokeGrant,
  writeLockfile,
} from '@ethosagent/plugin-loader';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ContextInjector } from '@ethosagent/types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../routes';
import { rpcRoutes } from '../../routes/rpc';
import { NpmExitError, PluginsService } from '../../services/plugins.service';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const offline = () => {
    throw new Error('test reached a real child process — npm must go through the injected runner');
  };
  return { ...actual, spawn: offline, execFile: offline };
});

const PKG = 'ethos-plugin-demo';
const TARBALL = Buffer.from('ethos-plugin-demo tarball');

function sri(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

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
/** The bytes the fake `npm pack` writes. */
let packedBytes: Buffer;
/** The `dist.integrity` the fake `npm view` reports; undefined → omitted. */
let viewIntegrity: string | undefined;
/** npm command (`view`, `pack`, `install`, `uninstall`) → what the fake throws instead of answering. */
let failOn: Partial<Record<string, unknown>>;
/** When false, the fake `npm uninstall` exits 0 but leaves the package directory in place. */
let uninstallRemoves: boolean;
/** When true, a failing fake `npm install` writes the package first, then throws. */
let installLeavesFiles: boolean;
/** The version the installed package.json of the 1.2.3 tarball names (other versions name themselves). */
let installedVersion: string;
/** Tarball version → what the fake `npm install` of it throws after writing the package. */
let installFailsFor: Partial<Record<string, unknown>>;

beforeEach(async () => {
  dataDir = join(
    tmpdir(),
    `ethos-plugins-install-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dataDir, { recursive: true });
  npmCalls = [];
  packedBytes = TARBALL;
  viewIntegrity = sri(TARBALL);
  failOn = {};
  uninstallRemoves = true;
  installLeavesFiles = false;
  installedVersion = '1.2.3';
  installFailsFor = {};
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Stands in for `npm view … --json`, `npm pack … --pack-destination <dir>`, `npm install --prefix <dir> … <tgz>` and `npm uninstall --prefix <dir> <name>`. */
async function fakeNpm(args: string[]): Promise<string> {
  npmCalls.push(args);
  const step = args[0] ?? '';
  if (step in failOn && !(step === 'install' && installLeavesFiles)) throw failOn[step];
  if (step === 'uninstall') {
    const prefix = args[args.indexOf('--prefix') + 1] ?? '';
    if (uninstallRemoves) {
      await rm(join(prefix, 'node_modules', args[args.length - 1] ?? ''), {
        recursive: true,
        force: true,
      });
    }
    return '';
  }
  if (step === 'view') {
    return JSON.stringify({
      name: PKG,
      version: '1.2.3',
      ...(viewIntegrity ? { 'dist.integrity': viewIntegrity } : {}),
    });
  }
  if (args[0] === 'pack') {
    const dest = args[args.indexOf('--pack-destination') + 1] ?? '';
    const version = (args[1] ?? '').slice(`${PKG}@`.length);
    await writeFile(join(dest, `${PKG}-${version}.tgz`), tarballOf(version));
    return '';
  }
  const prefix = args[args.indexOf('--prefix') + 1] ?? '';
  const version = (args[args.length - 1] ?? '').match(/-(\d+\.\d+\.\d+)\.tgz$/)?.[1] ?? '';
  const pkgDir = join(prefix, 'node_modules', PKG);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(prefix, 'package.json'),
    JSON.stringify({ dependencies: { [PKG]: `^${version}` } }),
  );
  await writeFile(
    join(prefix, 'package-lock.json'),
    JSON.stringify({
      packages: {
        '': { dependencies: { [PKG]: `^${version}` } },
        [`node_modules/${PKG}`]: { version, resolved: `file:/tmp/${PKG}-${version}.tgz` },
      },
    }),
  );
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: PKG,
      version: version === '1.2.3' ? installedVersion : version,
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
  if ('install' in failOn) throw failOn.install;
  if (version in installFailsFor) throw installFailsFor[version];
  return '';
}

/** The bytes the fake `npm pack` writes for a version: `packedBytes` for 1.2.3, a fixed per-version buffer otherwise. */
function tarballOf(version: string): Buffer {
  return version === '1.2.3' ? packedBytes : Buffer.from(`${PKG}@${version} tarball`);
}

function makeService(storage = new FsStorage()): PluginsService {
  return new PluginsService({ storage, dataDir, runNpm: fakeNpm });
}

/** FsStorage whose first `writeAtomic` to a file named `failName` throws, as a full disk or a permission error would. */
class FailingWriteStorage extends FsStorage {
  private failed = false;

  constructor(private readonly failName: string) {
    super();
  }

  override async writeAtomic(...args: Parameters<FsStorage['writeAtomic']>): Promise<void> {
    const [path] = args;
    if (!this.failed && path.endsWith(`/${this.failName}`)) {
      this.failed = true;
      throw new Error(`EACCES: permission denied, open '${path}'`);
    }
    return super.writeAtomic(...args);
  }
}

const PREVIOUS = '1.0.0';

/**
 * Put ethos-plugin-demo@1.0.0 in the plugins folder, as an earlier install would,
 * and optionally pin it in personality `researcher`'s plugins.lock: `verified` is a
 * tarball pin of the bytes the fake packs, `wrong-sri` a tarball pin of other
 * bytes, `legacy` a package.json-digest pin with no `integrityOf`.
 */
async function installPreviousCopy(pin: 'verified' | 'wrong-sri' | 'legacy' | 'none') {
  await fakeNpm([
    'install',
    '--prefix',
    join(dataDir, 'plugins'),
    '--ignore-scripts',
    '--no-audit',
    `/tmp/${PKG}-${PREVIOUS}.tgz`,
  ]);
  npmCalls = [];
  const personalityDir = await makePersonality('researcher');
  if (pin === 'none') return;
  await writeLockfile(new FsStorage(), personalityDir, {
    [PKG]: {
      package: PKG,
      version: PREVIOUS,
      registry: 'https://registry.npmjs.org',
      integrity: sri(pin === 'wrong-sri' ? Buffer.from('other bytes') : tarballOf(PREVIOUS)),
      ...(pin === 'legacy' ? {} : { integrityOf: 'tarball' as const }),
    },
  });
}

async function installedPackageVersion(): Promise<string | null> {
  const src = await new FsStorage().read(
    join(dataDir, 'plugins', 'node_modules', PKG, 'package.json'),
  );
  return src === null ? null : (JSON.parse(src) as { version: string }).version;
}

async function loads(storage = new FsStorage()): Promise<boolean> {
  const loader = new PluginLoader(makeRegistries(), { storage, dataDir });
  await loader.loadFromNodeModules(join(dataDir, 'plugins', 'node_modules'));
  return loader.isLoaded(PKG);
}

async function makePersonality(id: string): Promise<string> {
  const personalityDir = join(dataDir, 'personalities', id);
  await mkdir(personalityDir, { recursive: true });
  await writeFile(join(personalityDir, 'config.yaml'), `name: ${id}\n`);
  return personalityDir;
}

describe('PluginsService.install records consent', () => {
  it('records an interactive grant carrying the declared ethos.permissions', async () => {
    await makeService().install(PKG);

    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack', 'install']);
    expect(npmCalls[0]).toEqual(['view', PKG, 'name', 'version', 'dist.integrity', '--json']);
    const install = npmCalls[2] ?? [];
    expect(install).toContain('--ignore-scripts');
    // The verified tarball is what gets installed, not the spec from the registry.
    expect(install[install.length - 1]).toMatch(/ethos-plugin-demo-1\.2\.3\.tgz$/);

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
    const personalityDir = await makePersonality('researcher');

    await makeService(storage).install(PKG, { personalityId: 'researcher' });

    const lockfile = await readLockfile(storage, personalityDir);
    // The entry `ethos plugin install --personality` writes since FU-1: registry
    // literal, and integrity = SRI of the verified tarball that was installed.
    expect(lockfile[PKG]).toEqual({
      package: PKG,
      version: '1.2.3',
      registry: 'https://registry.npmjs.org',
      integrity: sri(TARBALL),
      integrityOf: 'tarball',
    });
    expect(Object.keys(lockfile[PKG] ?? {})).toEqual([
      'package',
      'version',
      'registry',
      'integrity',
      'integrityOf',
    ]);
    // Pinned from the SRI the install verified — no second pack.
    expect(npmCalls.filter((args) => args[0] === 'pack')).toHaveLength(1);
    expect(await storage.read(join(personalityDir, 'config.yaml'))).toContain(`plugins: ${PKG}`);
  });

  it('refuses a tarball whose SRI differs from the registry dist.integrity, installing, granting and pinning nothing', async () => {
    const storage = new FsStorage();
    const personalityDir = await makePersonality('researcher');
    packedBytes = Buffer.from('not the published bytes');

    await expect(
      makeService(storage).install(PKG, { personalityId: 'researcher' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INTEGRITY_MISMATCH' });

    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack']);
    expect(existsSync(join(dataDir, 'plugins', 'node_modules', PKG))).toBe(false);
    expect(await readGrants(storage, join(dataDir, 'plugins'))).toEqual({});
    expect(await readLockfile(storage, personalityDir)).toEqual({});
  });

  it.each([
    'github:someone/ethos-plugin-demo',
    'someone/ethos-plugin-demo',
    'git+https://example.com/ethos-plugin-demo.git',
    'https://example.com/ethos-plugin-demo-1.2.3.tgz',
    './ethos-plugin-demo',
    '/tmp/ethos-plugin-demo',
    'ethos-plugin-demo@file:../ethos-plugin-demo',
    'ethos-plugin-demo@git+https://example.com/ethos-plugin-demo.git',
    'ethos-plugin-demo@npm:other-plugin@1.0.0',
  ])('refuses the non-registry spec %s before running npm', async (spec) => {
    await expect(makeService().install(spec)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(npmCalls).toHaveLength(0);
  });

  it('refuses a registry answer with no sha512 dist.integrity before packing or installing', async () => {
    viewIntegrity = undefined;
    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_SPEC_UNVERIFIABLE',
    });
    expect(npmCalls.map((args) => args[0])).toEqual(['view']);
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

// Each refusal has its own code and an honest status (`STATUS_BY_CODE` in
// middleware/error-envelope.ts, applied by the `/rpc` interceptor): 400 only when
// the caller's spec is the problem, 404 for a package the registry does not have,
// 502 when the registry failed or misbehaved, 503 when this server cannot run npm,
// 500 when npm's pack/install step failed for any other reason.
// The npm failure fixtures are npm 11.12.1's real output for each case, except
// where a comment says a fixture is hand-written.
describe('plugins.install over /rpc — a refused install', () => {
  const E404_PACKAGE = new NpmExitError(
    1,
    JSON.stringify({
      error: {
        code: 'E404',
        summary: `Not Found - GET https://registry.npmjs.org/${PKG} - Not found`,
        detail: `The requested resource '${PKG}@*' could not be found or you do not have permission to access it.`,
      },
    }),
    `npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${PKG} - Not found`,
  );
  const E404_VERSION = new NpmExitError(
    1,
    JSON.stringify({
      error: {
        code: 'E404',
        summary: 'No match found for version 99.0.0',
        detail: `The requested resource '${PKG}@99.0.0' could not be found or you do not have permission to access it.`,
      },
    }),
    'npm error code E404\nnpm error 404 No match found for version 99.0.0',
  );
  const ECONNREFUSED = new NpmExitError(
    1,
    JSON.stringify({
      error: {
        code: 'ECONNREFUSED',
        summary: `FetchError: request to http://127.0.0.1:9/${PKG} failed, reason: connect ECONNREFUSED 127.0.0.1:9`,
        detail:
          "If you are behind a proxy, please make sure that the 'proxy' config is set properly.",
      },
    }),
    'npm error code ECONNREFUSED\nnpm error syscall connect\nnpm error errno ECONNREFUSED',
  );
  // `npm pack <pkg>@<version> --registry http://127.0.0.1:9/` — plain stderr, no JSON (stack lines trimmed).
  const PACK_ECONNREFUSED = new NpmExitError(
    1,
    '',
    `npm error code ECONNREFUSED\nnpm error syscall connect\nnpm error errno ECONNREFUSED\nnpm error FetchError: request to http://127.0.0.1:9/${PKG} failed, reason: connect ECONNREFUSED 127.0.0.1:9\nnpm error\nnpm error If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'`,
  );
  // `npm install --prefix <dir> --ignore-scripts --no-audit <tgz>` for a tarball depending on a missing package.
  const INSTALL_E404_DEPENDENCY = new NpmExitError(
    1,
    '',
    "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/ethos-no-such-dep - Not found\nnpm error 404\nnpm error 404  The requested resource 'ethos-no-such-dep@1.0.0' could not be found or you do not have permission to access it.",
  );

  let storage: FsStorage;
  let personalityDir: string;

  beforeEach(async () => {
    storage = new FsStorage();
    personalityDir = await makePersonality('researcher');
  });

  async function installOverRpc(packageSpec: string): Promise<Response> {
    const app = new Hono();
    // Only `plugins` is read by this procedure; a full container would drag in every service.
    const services = { plugins: makeService(storage) } as unknown as ServiceContainer;
    app.route('/rpc', rpcRoutes({ services }));
    return app.request('/rpc/plugins/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { packageSpec, personalityId: 'researcher' } }),
    });
  }

  /** No grant, no plugins.lock pin, no `plugins:` line — and, unless stated, no package on disk. */
  async function expectNothingRecorded(opts: { installedOnDisk?: boolean } = {}): Promise<void> {
    expect(existsSync(join(dataDir, 'plugins', 'node_modules', PKG))).toBe(
      opts.installedOnDisk ?? false,
    );
    expect(await readGrants(storage, join(dataDir, 'plugins'))).toEqual({});
    expect(await readLockfile(storage, personalityDir)).toEqual({});
    expect(await storage.read(join(personalityDir, 'config.yaml'))).not.toContain('plugins:');
  }

  it('returns 400 PLUGIN_SPEC_UNVERIFIABLE when the registry names no sha512 dist.integrity', async () => {
    viewIntegrity = undefined;
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'PLUGIN_SPEC_UNVERIFIABLE',
        message: `npm view '${PKG}' returned no exact ${PKG} version with a sha512 dist.integrity, so the install cannot be verified`,
        data: { action: expect.stringContaining('Install a published npm package by name') },
      },
    });
    expect(npmCalls.map((args) => args[0])).toEqual(['view']);
    await expectNothingRecorded();
  });

  it('returns 400 PLUGIN_SPEC_UNVERIFIABLE when npm view reports E404 "No match found for version"', async () => {
    failOn.view = E404_VERSION;
    const res = await installOverRpc(`${PKG}@99.0.0`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'PLUGIN_SPEC_UNVERIFIABLE',
        message: `npm view '${PKG}@99.0.0' found no published ${PKG} version matching the spec (E404: No match found for version 99.0.0). Nothing was installed.`,
        data: {
          action: `Ask for a version ${PKG} has published — list them with: npm view ${PKG} versions`,
        },
      },
    });
    expect(npmCalls.map((args) => args[0])).toEqual(['view']);
    await expectNothingRecorded();
  });

  it('returns 404 PLUGIN_PACKAGE_NOT_FOUND when npm view reports E404 for the package', async () => {
    failOn.view = E404_PACKAGE;
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'PLUGIN_PACKAGE_NOT_FOUND',
        message: `The npm registry has no package named '${PKG}' that this server can read (E404: Not Found - GET https://registry.npmjs.org/${PKG} - Not found). Nothing was installed.`,
        data: { action: expect.stringContaining("Check the package name's spelling") },
      },
    });
    expect(npmCalls.map((args) => args[0])).toEqual(['view']);
    await expectNothingRecorded();
  });

  it('returns 404 from the stderr code line when npm printed no JSON error', async () => {
    failOn.view = new NpmExitError(1, '', E404_PACKAGE.stderr);
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ json: { code: 'PLUGIN_PACKAGE_NOT_FOUND' } });
    await expectNothingRecorded();
  });

  it('returns 502 PLUGIN_REGISTRY_FAILED when npm view cannot reach the registry', async () => {
    failOn.view = ECONNREFUSED;
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'PLUGIN_REGISTRY_FAILED',
        message: `npm view '${PKG}' could not reach the npm registry (ECONNREFUSED: FetchError: request to http://127.0.0.1:9/${PKG} failed, reason: connect ECONNREFUSED 127.0.0.1:9). Nothing was installed.`,
        data: { action: expect.stringContaining('network connection') },
      },
    });
    expect(npmCalls.map((args) => args[0])).toEqual(['view']);
    await expectNothingRecorded();
  });

  it('returns 503 NOT_CONFIGURED when npm cannot be spawned', async () => {
    failOn.view = Object.assign(new Error('spawn npm ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn npm',
    });
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'NOT_CONFIGURED',
        message: `This server cannot run npm (ENOENT spawning npm), so it cannot install '${PKG}'. Nothing was installed.`,
      },
    });
    await expectNothingRecorded();
  });

  it('returns 502 PLUGIN_INTEGRITY_MISMATCH when the tarball does not match the registry digest', async () => {
    packedBytes = Buffer.from('not the published bytes');
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'PLUGIN_INTEGRITY_MISMATCH',
        message: `The tarball npm downloaded for ${PKG}@1.2.3 does not match the registry's published digest (expected ${sri(TARBALL)}, got ${sri(packedBytes)}). Nothing was installed, granted or pinned.`,
        data: { action: expect.stringContaining('do not install this package') },
      },
    });
    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack']);
    await expectNothingRecorded();
  });

  it('returns 502 PLUGIN_REGISTRY_FAILED when npm pack cannot reach the registry', async () => {
    failOn.pack = PACK_ECONNREFUSED;
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'PLUGIN_REGISTRY_FAILED',
        message: `npm pack '${PKG}@1.2.3' could not reach the npm registry (ECONNREFUSED: FetchError: request to http://127.0.0.1:9/${PKG} failed, reason: connect ECONNREFUSED 127.0.0.1:9). Nothing was installed, granted or pinned.`,
        data: { action: expect.stringContaining('network connection') },
      },
    });
    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack']);
    await expectNothingRecorded();
  });

  it("returns 500 PLUGIN_INSTALL_FAILED with npm's code when npm install fails", async () => {
    failOn.install = INSTALL_E404_DEPENDENCY;
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'PLUGIN_INSTALL_FAILED',
        message: `npm install '${PKG}@1.2.3' failed (E404: 404 Not Found - GET https://registry.npmjs.org/ethos-no-such-dep - Not found). Nothing was installed, granted or pinned.`,
        data: { action: expect.stringContaining('Fix what npm reports') },
      },
    });
    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack', 'install']);
    await expectNothingRecorded();
  });

  it('returns 502 PLUGIN_REGISTRY_FAILED when npm install gets a registry 5xx', async () => {
    // Hand-written: npm-registry-fetch reports an HTTP error status as `E<status>`.
    failOn.install = new NpmExitError(
      1,
      '',
      'npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/some-dep',
    );
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ json: { code: 'PLUGIN_REGISTRY_FAILED' } });
    await expectNothingRecorded();
  });

  it('returns 502 PLUGIN_PACKAGE_MISMATCH and rolls the install back when the installed package.json names another version', async () => {
    installedVersion = '9.9.9';
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(502);
    const pluginsDir = join(dataDir, 'plugins');
    const pkgDir = join(pluginsDir, 'node_modules', PKG);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'PLUGIN_PACKAGE_MISMATCH',
        message: `npm installed the verified tarball of ${PKG}@1.2.3, but ${pkgDir}/package.json names ${PKG}@9.9.9. The install was rolled back (npm uninstall --prefix ${pluginsDir} ${PKG}): nothing was left installed, granted or pinned.`,
        data: { action: expect.stringContaining('Do not install this package') },
      },
    });
    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack', 'install', 'uninstall']);
    expect(npmCalls[3]).toEqual(['uninstall', '--prefix', pluginsDir, PKG]);
    await expectNothingRecorded();
    // Nothing refused is left for the loader, which would load an ungranted package.
    const loader = new PluginLoader(makeRegistries(), { storage, dataDir });
    await loader.loadFromNodeModules(join(pluginsDir, 'node_modules'));
    expect(loader.isLoaded(PKG)).toBe(false);
  });

  it('says the package was left on disk and will load when rolling a package mismatch back fails', async () => {
    installedVersion = '9.9.9';
    // Hand-written: the stderr shape npm prints for a filesystem error.
    failOn.uninstall = new NpmExitError(
      1,
      '',
      'npm error code EACCES\nnpm error syscall rename\nnpm error errno -13\nnpm error Error: EACCES: permission denied, rename',
    );
    const res = await installOverRpc(PKG);
    expect(res.status).toBe(502);
    const pluginsDir = join(dataDir, 'plugins');
    const pkgDir = join(pluginsDir, 'node_modules', PKG);
    expect(await res.json()).toMatchObject({
      json: {
        code: 'PLUGIN_PACKAGE_MISMATCH',
        message: `npm installed the verified tarball of ${PKG}@1.2.3, but ${pkgDir}/package.json names ${PKG}@9.9.9. This attempt recorded no capability grant or plugins.lock pin, but rolling the install back failed (npm uninstall failed: EACCES: Error: EACCES: permission denied, rename), so the package was left on disk and will load on the next start.`,
        data: {
          action: `Remove it before this server restarts, with: npm uninstall --prefix ${pluginsDir} ${PKG}`,
        },
      },
    });
    await expectNothingRecorded({ installedOnDisk: true });
    // The message is true: a missing grant does not stop the loader.
    const loader = new PluginLoader(makeRegistries(), { storage, dataDir });
    await loader.loadFromNodeModules(join(pluginsDir, 'node_modules'));
    expect(loader.isLoaded(PKG)).toBe(true);
  });
});

describe('PluginsService.install never claims a clean state it did not check', () => {
  it('reports a package mismatch as left on disk when npm uninstall exits 0 but the package is still there', async () => {
    installedVersion = '9.9.9';
    uninstallRemoves = false;
    const pkgDir = join(dataDir, 'plugins', 'node_modules', PKG);
    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_PACKAGE_MISMATCH',
      cause: expect.stringContaining(
        `rolling the install back failed (npm uninstall exited successfully but ${pkgDir} is still there), so the package was left on disk and will load on the next start.`,
      ),
    });
    expect(existsSync(pkgDir)).toBe(true);
  });

  it('reports a failed npm install as left on disk when rolling it back leaves the package there', async () => {
    failOn.install = new NpmExitError(
      1,
      '',
      'npm error code EBADPLATFORM\nnpm error notsup Unsupported platform',
    );
    installLeavesFiles = true;
    uninstallRemoves = false;
    const pluginsDir = join(dataDir, 'plugins');
    const pkgDir = join(pluginsDir, 'node_modules', PKG);
    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `npm install '${PKG}@1.2.3' failed (EBADPLATFORM: notsup Unsupported platform). This attempt recorded no capability grant or plugins.lock pin, but rolling the install back failed (npm uninstall exited successfully but ${pkgDir} is still there), so the package was left on disk and will load on the next start.`,
      action: `Remove it before this server restarts, with: npm uninstall --prefix ${pluginsDir} ${PKG}`,
    });
    expect(await readGrants(new FsStorage(), pluginsDir)).toEqual({});
  });
});

// A failure after a successful `npm install` leaves the server no worse off than
// before the attempt: the install is undone (an ungranted package would still load,
// because the loader refuses only a revoked grant), and a copy that `npm install`
// replaced is reinstalled from a verified plugins.lock pin — or reported removed,
// with the command that reinstalls it.
describe('PluginsService.install undoes an install a later step refused or failed after', () => {
  const pluginsDir = () => join(dataDir, 'plugins');
  const pkgDir = () => join(pluginsDir(), 'node_modules', PKG);
  const uninstall = () => `npm uninstall --prefix ${pluginsDir()} ${PKG}`;
  const mismatch = () =>
    `npm installed the verified tarball of ${PKG}@1.2.3, but ${pkgDir()}/package.json names ${PKG}@9.9.9.`;
  const restored = () =>
    `The install was rolled back (${uninstall()}), and the copy installed before this attempt, ${PKG}@${PREVIOUS}, which npm replaced during this attempt, was reinstalled from the tarball pinned in personality researcher's plugins.lock after its SRI matched the pin: ${PKG}@${PREVIOUS} is installed again, and nothing from this attempt was left installed, granted or pinned.`;
  const reinstallAction = `To reinstall ${PKG}@${PREVIOUS}, run: ethos plugin install ${PKG}@${PREVIOUS}`;

  it('reinstalls the previous copy from its verified pin when an upgrade is refused for a package mismatch', async () => {
    await installPreviousCopy('verified');
    installedVersion = '9.9.9';

    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_PACKAGE_MISMATCH',
      cause: `${mismatch()} ${restored()}`,
    });

    expect(npmCalls.map((args) => args[0])).toEqual([
      'view',
      'pack',
      'install',
      'uninstall',
      'pack',
      'install',
    ]);
    // The pinned version is packed, checked against the pin, and that file installed without scripts.
    expect(npmCalls[4]?.[1]).toBe(`${PKG}@${PREVIOUS}`);
    const reinstall = npmCalls[5] ?? [];
    expect(reinstall).toContain('--ignore-scripts');
    expect(reinstall[reinstall.length - 1]).toMatch(/ethos-plugin-demo-1\.0\.0\.tgz$/);
    expect(await installedPackageVersion()).toBe(PREVIOUS);
    const prefix = await new FsStorage().read(join(pluginsDir(), 'package.json'));
    expect(JSON.parse(prefix ?? '{}').dependencies[PKG]).toBe(PREVIOUS);
    expect(await loads()).toBe(true);
  });

  it('removes the previous copy and says how to reinstall it when no verified pin exists', async () => {
    // A legacy package.json-digest pin verifies none of the code: it must not be used to restore.
    await installPreviousCopy('legacy');
    installedVersion = '9.9.9';

    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_PACKAGE_MISMATCH',
      cause: `${mismatch()} The install was rolled back (${uninstall()}), which also removed the copy installed before this attempt, ${PKG}@${PREVIOUS}: npm replaced it during this attempt, and no readable plugins.lock entry pins its tarball, so it was not reinstalled unverified. No copy of ${PKG} is installed now, and nothing from this attempt was left granted or pinned.`,
      action: expect.stringMatching(
        new RegExp(`Do not install this package: .* ${reinstallAction}$`),
      ),
    });

    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack', 'install', 'uninstall']);
    expect(existsSync(pkgDir())).toBe(false);
    expect(await loads()).toBe(false);
  });

  it('rolls back when recording the grant fails, leaving nothing ungranted to load', async () => {
    const storage = new FailingWriteStorage('grants.json');
    const grants = join(pluginsDir(), 'grants.json');

    await expect(makeService(storage).install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `npm installed the verified tarball of ${PKG}@1.2.3, but recording its capability grant in ${grants} failed (EACCES: permission denied, open '${grants}'). The install was rolled back (${uninstall()}): nothing was left installed, granted or pinned.`,
      action: 'Fix what the error reports, then retry the install.',
    });

    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack', 'install', 'uninstall']);
    expect(existsSync(pkgDir())).toBe(false);
    expect(await readGrants(storage, pluginsDir())).toEqual({});
    expect(await loads(storage)).toBe(false);
  });

  it('rolls back when rewriting the plugins lockfile fails, leaving nothing ungranted to load', async () => {
    const storage = new FailingWriteStorage('package-lock.json');

    await expect(makeService(storage).install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `npm installed the verified tarball of ${PKG}@1.2.3, but rewriting ${join(pluginsDir(), 'package.json')} and package-lock.json to record it failed (EACCES: permission denied, open '${join(pluginsDir(), 'package-lock.json')}'). The install was rolled back (${uninstall()}): nothing was left installed, granted or pinned.`,
    });

    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack', 'install', 'uninstall']);
    expect(existsSync(pkgDir())).toBe(false);
    expect(await readGrants(storage, pluginsDir())).toEqual({});
    expect(await loads(storage)).toBe(false);
  });

  it('restores the previous copy from its verified pin when recording the upgrade grant fails', async () => {
    await installPreviousCopy('verified');
    const storage = new FailingWriteStorage('grants.json');
    const grants = join(pluginsDir(), 'grants.json');

    await expect(makeService(storage).install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `npm installed the verified tarball of ${PKG}@1.2.3, but recording its capability grant in ${grants} failed (EACCES: permission denied, open '${grants}'). ${restored()}`,
    });

    expect(await installedPackageVersion()).toBe(PREVIOUS);
    expect(await loads(storage)).toBe(true);
  });

  it('says the previous copy was removed when its pinned tarball does not match the pin', async () => {
    await installPreviousCopy('wrong-sri');
    installedVersion = '9.9.9';

    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_PACKAGE_MISMATCH',
      cause: `${mismatch()} The install was rolled back (${uninstall()}), which also removed the copy installed before this attempt, ${PKG}@${PREVIOUS}: npm replaced it during this attempt, and reinstalling it from the tarball pinned in personality researcher's plugins.lock failed (the tarball's SRI ${sri(tarballOf(PREVIOUS))} does not match the pinned ${sri(Buffer.from('other bytes'))}). No copy of ${PKG} is installed now, and nothing from this attempt was left granted or pinned.`,
      action: expect.stringContaining(reinstallAction),
    });

    // Refused before `npm install` ran: the unverified bytes never reached the plugins folder.
    expect(npmCalls.map((args) => args[0])).toEqual([
      'view',
      'pack',
      'install',
      'uninstall',
      'pack',
    ]);
    expect(existsSync(pkgDir())).toBe(false);
    expect(await loads()).toBe(false);
  });

  it('removes what a failed restore reinstall left, so nothing is loadable', async () => {
    await installPreviousCopy('verified');
    installedVersion = '9.9.9';
    installFailsFor[PREVIOUS] = new NpmExitError(
      1,
      '',
      'npm error code ENOSPC\nnpm error nospc no space left on device',
    );

    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_PACKAGE_MISMATCH',
      cause: `${mismatch()} The install was rolled back (${uninstall()}), which also removed the copy installed before this attempt, ${PKG}@${PREVIOUS}: npm replaced it during this attempt, and reinstalling it from the tarball pinned in personality researcher's plugins.lock failed (ENOSPC: nospc no space left on device). No copy of ${PKG} is installed now, and nothing from this attempt was left granted or pinned.`,
    });

    expect(npmCalls.map((args) => args[0])).toEqual([
      'view',
      'pack',
      'install',
      'uninstall',
      'pack',
      'install',
      'uninstall',
    ]);
    expect(existsSync(pkgDir())).toBe(false);
    expect(await loads()).toBe(false);
  });

  /** FsStorage whose `write` to a personality's config.yaml throws — the last write a pin makes, after plugins.lock. */
  class ConfigWriteFails extends FsStorage {
    override async write(...args: Parameters<FsStorage['write']>): Promise<void> {
      const [path] = args;
      if (path.endsWith('/config.yaml')) {
        throw new Error(`EACCES: permission denied, open '${path}'`);
      }
      return super.write(...args);
    }
  }

  const pinFailed = () => {
    const config = join(dataDir, 'personalities', 'researcher', 'config.yaml');
    return `npm installed the verified tarball of ${PKG}@1.2.3, but pinning it to personality researcher failed (EACCES: permission denied, open '${config}').`;
  };

  it('rolls back the package, the grant and the half-written plugins.lock entry when pinning to the personality fails', async () => {
    const storage = new ConfigWriteFails();
    const personalityDir = await makePersonality('researcher');

    await expect(
      makeService(storage).install(PKG, { personalityId: 'researcher' }),
    ).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `${pinFailed()} The install was rolled back (${uninstall()}): nothing from this attempt was left installed. The capability grant this attempt recorded for ${PKG} was removed; none was recorded before it. The ${PKG} entry this attempt wrote to personality researcher's plugins.lock was removed.`,
      action: 'Fix what the error reports, then retry the install.',
    });

    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack', 'install', 'uninstall']);
    expect(existsSync(pkgDir())).toBe(false);
    expect(await readGrants(storage, pluginsDir())).toEqual({});
    expect(await readLockfile(storage, personalityDir)).toEqual({});
    expect(await storage.read(join(personalityDir, 'config.yaml'))).toBe('name: researcher\n');
    expect(await loads(storage)).toBe(false);
  });

  it('on an upgrade, a failed pin restores the previous copy, its grant and its pin exactly', async () => {
    await installPreviousCopy('verified');
    const personalityDir = join(dataDir, 'personalities', 'researcher');
    const earlierGrant: PluginGrant = {
      id: PKG,
      package: PKG,
      version: PREVIOUS,
      source: `npm:${PKG}@${PREVIOUS}`,
      capabilities: { shell: true, network: ['api.example.com'] },
      scan: { tier: 'community', findings: [], hasRed: false, hasYellow: false },
      grantedAt: '2026-01-01T00:00:00.000Z',
      consent: 'flag',
    };
    await recordGrant(new FsStorage(), pluginsDir(), earlierGrant);
    const earlierPin = (await readLockfile(new FsStorage(), personalityDir))[PKG];
    const storage = new ConfigWriteFails();

    await expect(
      makeService(storage).install(PKG, { personalityId: 'researcher' }),
    ).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `${pinFailed()} The install was rolled back (${uninstall()}), and the copy installed before this attempt, ${PKG}@${PREVIOUS}, which npm replaced during this attempt, was reinstalled from the tarball pinned in personality researcher's plugins.lock after its SRI matched the pin: ${PKG}@${PREVIOUS} is installed again, and nothing from this attempt was left installed. The capability grant recorded for ${PKG} before this attempt was put back as it was. The ${PKG} entry in personality researcher's plugins.lock was put back as it was.`,
    });

    expect(await installedPackageVersion()).toBe(PREVIOUS);
    expect((await readGrants(storage, pluginsDir()))[PKG]).toEqual(earlierGrant);
    expect(await readLockfile(storage, personalityDir)).toEqual({ [PKG]: earlierPin });
    expect(await loads(storage)).toBe(true);
  });

  // A failed `npm install` can leave files behind (npm's reify rollback is not a
  // guarantee), and an ungranted package loads on the next start. It goes through
  // the same undo as a failure after a successful install.
  const EBADPLATFORM = () =>
    new NpmExitError(1, '', 'npm error code EBADPLATFORM\nnpm error notsup Unsupported platform');
  const installFailed = `npm install '${PKG}@1.2.3' failed (EBADPLATFORM: notsup Unsupported platform).`;

  it('uninstalls what a failed npm install left on disk', async () => {
    installFailsFor['1.2.3'] = EBADPLATFORM();

    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `${installFailed} The install was rolled back (${uninstall()}): nothing was left installed, granted or pinned.`,
    });

    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack', 'install', 'uninstall']);
    expect(existsSync(pkgDir())).toBe(false);
    expect(await loads()).toBe(false);
  });

  it('reinstalls the previous copy from its verified pin when a failed npm install left files over it', async () => {
    await installPreviousCopy('verified');
    installFailsFor['1.2.3'] = EBADPLATFORM();

    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `${installFailed} ${restored()}`,
    });

    expect(npmCalls.map((args) => args[0])).toEqual([
      'view',
      'pack',
      'install',
      'uninstall',
      'pack',
      'install',
    ]);
    expect(await installedPackageVersion()).toBe(PREVIOUS);
    expect(await loads()).toBe(true);
  });

  it('leaves the previous copy alone when npm rolled a failed install back over it', async () => {
    await installPreviousCopy('verified');
    failOn.install = EBADPLATFORM();

    await expect(makeService().install(PKG)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `${installFailed} ${pkgDir()} still names ${PKG}@${PREVIOUS}, installed before this attempt. Nothing was granted or pinned.`,
    });

    expect(npmCalls.map((args) => args[0])).toEqual(['view', 'pack', 'install']);
    expect(await installedPackageVersion()).toBe(PREVIOUS);
  });
});
