// `catalog.install` and `catalog.setSkillGrant` (plan §6.4, §6.5).
//
// The plugin half drives the REAL `PluginsService.installCatalogPin` through
// wiring's `installCatalogPlugin`, with npm replaced by a fake (and
// `node:child_process` mocked to throw, so nothing reaches a registry). The
// skill half injects the installer. Every status code of §6.4 is asserted as
// `statusFor(code)` of the thrown EthosError, the same table the error
// envelope uses.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { readGrants, readLockfile } from '@ethosagent/plugin-loader';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import { type CatalogEntry, EthosError } from '@ethosagent/types';
import { installCatalogPlugin } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusFor } from '../../middleware/error-envelope';
import { CatalogService } from '../../services/catalog.service';
import { PluginsService } from '../../services/plugins.service';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const offline = () => {
    throw new Error('test reached a real child process — npm must go through the injected runner');
  };
  return { ...actual, spawn: offline, execFile: offline };
});

const PKG = 'ethos-plugin-demo';
const TARBALL = Buffer.from('ethos-plugin-demo tarball');
const sri = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

let dataDir: string;
let npmCalls: string[][];
let packedBytes: Buffer;
/** The source of the plugin's index.ts the fake `npm install` writes. */
let pluginSource: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ethos-catalog-install-'));
  npmCalls = [];
  packedBytes = TARBALL;
  pluginSource = 'export async function activate() {}\n';
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function fakeNpm(args: string[]): Promise<string> {
  npmCalls.push(args);
  const step = args[0];
  if (step === 'pack') {
    const dest = args[args.indexOf('--pack-destination') + 1] ?? '';
    await writeFile(join(dest, `${PKG}-1.2.3.tgz`), packedBytes);
    return '';
  }
  if (step === 'install') {
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
        ethos: { type: 'plugin', pluginContractMajor: 4, permissions: {} },
      }),
    );
    await writeFile(join(pkgDir, 'index.ts'), pluginSource);
    return '';
  }
  if (step === 'uninstall') {
    const prefix = args[args.indexOf('--prefix') + 1] ?? '';
    await rm(join(prefix, 'node_modules', args[args.length - 1] ?? ''), {
      recursive: true,
      force: true,
    });
    return '';
  }
  throw new Error(`unexpected npm ${step}: catalog installs must not call npm view`);
}

function pluginEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'demo',
    kind: 'plugin',
    name: 'Demo',
    description: 'd',
    category: 'Utilities',
    publisher: 'acme',
    tier: 'verified',
    pin: { type: 'npm', package: PKG, version: '1.2.3', integrity: sri(TARBALL) },
    capabilities: { network: [], auth: 'none', env: [], filesystem: 'none', shell: false },
    license: 'MIT',
    reviewedAt: '2026-11-01',
    plugin: { pluginId: PKG },
    ...over,
  };
}

function skillEntry(): CatalogEntry {
  return {
    ...pluginEntry({ id: 'pdf', kind: 'skill', plugin: undefined }),
    pin: {
      type: 'git',
      repo: 'https://github.com/acme/skills',
      commit: 'a'.repeat(40),
      contentDigest: `sha256-${'A'.repeat(43)}=`,
    },
    skill: { skillName: 'pdf' },
  };
}

function mcpEntry(
  auth: 'none' | 'oauth',
  pin: CatalogEntry['pin'] = {
    type: 'remote',
    url: 'https://x.example/mcp',
    transport: 'streamable-http',
  },
): CatalogEntry {
  return {
    ...pluginEntry({ id: 'srv', kind: 'mcp', plugin: undefined }),
    pin,
    capabilities: { network: ['x.example'], auth, env: [], filesystem: 'none', shell: false },
  };
}

function makeService(
  entries: CatalogEntry[],
  over: Partial<ConstructorParameters<typeof CatalogService>[0]> = {},
) {
  const storage = new FsStorage();
  const plugins = new PluginsService({ storage, dataDir, runNpm: fakeNpm });
  return new CatalogService({
    entries,
    listMcpNames: async () => [],
    listInstalledPlugins: async () => (await plugins.list()).plugins,
    skillInstalled: async () => false,
    installPlugin: (entry) =>
      installCatalogPlugin(entry, {
        installPinned: (pin, o) => plugins.installCatalogPin(pin, o),
      }),
    ...over,
  });
}

async function errorOf(p: Promise<unknown>): Promise<EthosError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EthosError);
  return err as EthosError;
}

describe('catalog.install: plugins', () => {
  it('installs, holds the tarball to the CATALOG integrity, and never calls npm view', async () => {
    const out = await makeService([pluginEntry()]).install({ id: 'demo' });
    expect(out).toMatchObject({ ok: true, kind: 'plugin', id: 'demo' });
    expect(out.grantHint).toBe('Attach it on the Plugins page');
    expect(npmCalls.map((a) => a[0])).toEqual(['pack', 'install']);
    expect(existsSync(join(dataDir, 'plugins', 'node_modules', PKG))).toBe(true);
  });

  it('refuses a registry that serves other bytes than the catalog pins: 502 PLUGIN_INTEGRITY_MISMATCH, nothing installed', async () => {
    packedBytes = Buffer.from('not what the catalog pinned');
    const err = await errorOf(makeService([pluginEntry()]).install({ id: 'demo' }));
    expect(err.code).toBe('PLUGIN_INTEGRITY_MISMATCH');
    expect(statusFor(err.code)).toBe(502);
    expect(err.cause).toContain("catalog's pinned digest");
    expect(npmCalls.map((a) => a[0])).toEqual(['pack']);
    expect(existsSync(join(dataDir, 'plugins', 'node_modules', PKG))).toBe(false);
    expect(await readGrants(new FsStorage(), join(dataDir, 'plugins'))).toEqual({});
  });

  it('red findings: 400 CATALOG_SCAN_BLOCKED, and the install is undone', async () => {
    pluginSource = "export async function activate() { eval('1'); }\n";
    const err = await errorOf(makeService([pluginEntry()]).install({ id: 'demo' }));
    expect(err.code).toBe('CATALOG_SCAN_BLOCKED');
    expect(statusFor(err.code)).toBe(400);
    expect(npmCalls.map((a) => a[0])).toContain('uninstall');
    expect(existsSync(join(dataDir, 'plugins', 'node_modules', PKG))).toBe(false);
    expect(await readGrants(new FsStorage(), join(dataDir, 'plugins'))).toEqual({});
  });

  it('writes the grant with the catalog tier, and no personality pin or plugins: line', async () => {
    const pdir = join(dataDir, 'personalities', 'researcher');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'config.yaml'), 'name: researcher\n');
    await makeService([pluginEntry({ tier: 'verified' })]).install({ id: 'demo' });
    const grants = await readGrants(new FsStorage(), join(dataDir, 'plugins'));
    expect(Object.values(grants).map((g) => g.catalogTier)).toEqual(['verified']);
    expect(await readLockfile(new FsStorage(), pdir)).toEqual({});
    expect(await new FsStorage().read(join(pdir, 'config.yaml'))).toBe('name: researcher\n');
  });

  it('an already-installed plugin is 409 CATALOG_ALREADY_INSTALLED and runs no npm', async () => {
    const svc = makeService([pluginEntry()], {
      listInstalledPlugins: async () => [{ id: 'demo', name: PKG }],
    });
    const err = await errorOf(svc.install({ id: 'demo' }));
    expect(err.code).toBe('CATALOG_ALREADY_INSTALLED');
    expect(statusFor(err.code)).toBe(409);
    expect(npmCalls).toEqual([]);
  });
});

describe('catalog.install: skills and refusals', () => {
  it('a skill entry goes to the injected skill installer', async () => {
    const installSkill = vi.fn(async () => ({ installedAs: 'pdf' }));
    const out = await makeService([skillEntry()], { installSkill }).install({ id: 'pdf' });
    expect(installSkill).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ ok: true, kind: 'skill', id: 'pdf', installedAs: 'pdf' });
    expect(out.grantHint).toContain('ethos catalog grant pdf');
  });

  it('an already-installed skill is 409', async () => {
    const svc = makeService([skillEntry()], {
      skillInstalled: async () => true,
      installSkill: async () => ({ installedAs: 'pdf' }),
    });
    expect((await errorOf(svc.install({ id: 'pdf' }))).code).toBe('CATALOG_ALREADY_INSTALLED');
  });

  it('an unknown id is 404 CATALOG_ENTRY_NOT_FOUND', async () => {
    const err = await errorOf(makeService([]).install({ id: 'nope' }));
    expect(err.code).toBe('CATALOG_ENTRY_NOT_FOUND');
    expect(statusFor(err.code)).toBe(404);
  });

  it('an mcp entry is 400 CATALOG_INSTALL_UNSUPPORTED, with the action naming the right path', async () => {
    const add = await errorOf(makeService([mcpEntry('none')]).install({ id: 'srv' }));
    expect(add.code).toBe('CATALOG_INSTALL_UNSUPPORTED');
    expect(statusFor(add.code)).toBe(400);
    expect(add.action).toContain('mcp.addServer');
    const oauth = await errorOf(makeService([mcpEntry('oauth')]).install({ id: 'srv' }));
    expect(oauth.action).toContain('mcp.start');
    const local = await errorOf(
      makeService([
        mcpEntry('none', {
          type: 'npm',
          package: 'x-mcp',
          version: '1.0.0',
          integrity: 'sha512-AA',
        }),
      ]).install({ id: 'srv' }),
    );
    expect(local.action).toContain('ethos catalog install srv');
  });

  it('a skill whose git pin fails verification surfaces CATALOG_PIN_MISMATCH as 502', async () => {
    const svc = makeService([skillEntry()], {
      installSkill: async () => {
        throw new EthosError({ code: 'CATALOG_PIN_MISMATCH', cause: 'x', action: 'y' });
      },
    });
    const err = await errorOf(svc.install({ id: 'pdf' }));
    expect(statusFor(err.code)).toBe(502);
  });

  it('no installer configured is NOT_CONFIGURED', async () => {
    const svc = makeService([skillEntry()]);
    expect((await errorOf(svc.install({ id: 'pdf' }))).code).toBe('NOT_CONFIGURED');
  });

  it('every new code has a status', () => {
    expect(statusFor('CATALOG_ENTRY_NOT_FOUND')).toBe(404);
    expect(statusFor('CATALOG_INSTALL_UNSUPPORTED')).toBe(400);
    expect(statusFor('CATALOG_ALREADY_INSTALLED')).toBe(409);
    expect(statusFor('CATALOG_SCAN_BLOCKED')).toBe(400);
    expect(statusFor('CATALOG_PIN_MISMATCH')).toBe(502);
  });
});

describe('catalog.setSkillGrant', () => {
  const DATA = '/data';

  async function setup(initialAllow?: string) {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage, DATA);
    await registry.create({
      id: 'sage',
      name: 'Sage',
      toolset: ['read_file'],
      soulMd: 'I am sage.',
    });
    await registry.create({
      id: 'other',
      name: 'Other',
      toolset: ['read_file'],
      soulMd: 'I am other.',
    });
    if (initialAllow) {
      await registry.update('sage', { skills: { global_ingest: { allow: [initialAllow] } } });
    }
    registry.define({ id: 'builtin', name: 'Built-in' });
    const svc = makeService([skillEntry(), pluginEntry()], {
      skillInstalled: async () => true,
      personalities: {
        get: (id) => {
          const d = registry.describe(id);
          return d
            ? { builtin: d.builtin, allow: d.config.skills?.global_ingest?.allow ?? [] }
            : undefined;
        },
        setAllow: async (id, allow) => {
          await registry.update(id, { skills: { global_ingest: { allow } } });
        },
      },
    });
    const cfg = async (id: string) =>
      (await storage.read(join(DATA, 'personalities', id, 'config.yaml'))) ?? '';
    return { svc, registry, cfg };
  }

  it('grants and revokes catalog/<id> in that personality only', async () => {
    const { svc, registry, cfg } = await setup('ethos/keep-me');
    const otherBefore = await cfg('other');
    const sageBefore = await cfg('sage');

    const on = await svc.setSkillGrant({ personalityId: 'sage', id: 'pdf', granted: true });
    expect(on).toEqual({ ok: true, allow: ['ethos/keep-me', 'catalog/pdf'] });
    expect(registry.describe('sage')?.config.skills?.global_ingest?.allow).toEqual([
      'ethos/keep-me',
      'catalog/pdf',
    ]);
    expect(await cfg('other')).toBe(otherBefore);
    // Only the allow line differs from before; every other line is untouched.
    const diff = (await cfg('sage')).split('\n').filter((l) => !sageBefore.split('\n').includes(l));
    expect(diff.every((l) => l.includes('allow'))).toBe(true);

    // Granting twice does not duplicate.
    const again = await svc.setSkillGrant({ personalityId: 'sage', id: 'pdf', granted: true });
    expect(again.allow).toEqual(['ethos/keep-me', 'catalog/pdf']);

    const off = await svc.setSkillGrant({ personalityId: 'sage', id: 'pdf', granted: false });
    expect(off).toEqual({ ok: true, allow: ['ethos/keep-me'] });
  });

  it('a built-in personality is 403 PERSONALITY_READ_ONLY', async () => {
    const { svc } = await setup();
    const err = await errorOf(
      svc.setSkillGrant({ personalityId: 'builtin', id: 'pdf', granted: true }),
    );
    expect(err.code).toBe('PERSONALITY_READ_ONLY');
    expect(statusFor(err.code)).toBe(403);
  });

  it('an unknown personality is 404 PERSONALITY_NOT_FOUND', async () => {
    const { svc } = await setup();
    const err = await errorOf(
      svc.setSkillGrant({ personalityId: 'ghost', id: 'pdf', granted: true }),
    );
    expect(err.code).toBe('PERSONALITY_NOT_FOUND');
    expect(statusFor(err.code)).toBe(404);
  });

  it('an unknown entry is 404; a non-skill entry is 400 INVALID_INPUT', async () => {
    const { svc } = await setup();
    expect(
      (await errorOf(svc.setSkillGrant({ personalityId: 'sage', id: 'x', granted: true }))).code,
    ).toBe('CATALOG_ENTRY_NOT_FOUND');
    const err = await errorOf(
      svc.setSkillGrant({ personalityId: 'sage', id: 'demo', granted: true }),
    );
    expect(err.code).toBe('INVALID_INPUT');
    expect(statusFor(err.code)).toBe(400);
  });

  it('granting a skill that is not installed is 400 INVALID_INPUT; revoking one is allowed', async () => {
    const { svc } = await setup();
    const notInstalled = makeService([skillEntry()], {
      skillInstalled: async () => false,
      personalities: {
        get: () => ({ builtin: false, allow: ['catalog/pdf'] }),
        setAllow: async () => undefined,
      },
    });
    const err = await errorOf(
      notInstalled.setSkillGrant({ personalityId: 'sage', id: 'pdf', granted: true }),
    );
    expect(err.code).toBe('INVALID_INPUT');
    expect(
      await notInstalled.setSkillGrant({ personalityId: 'sage', id: 'pdf', granted: false }),
    ).toEqual({ ok: true, allow: [] });
    expect(svc).toBeDefined();
  });
});
