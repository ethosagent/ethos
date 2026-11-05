import { CATALOG_ENTRIES } from '@ethosagent/catalog';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CatalogEntry } from '@ethosagent/types';
import { CatalogListOutputSchema } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { actionFor, CatalogService, catalogSkillInstalled } from '../../services/catalog.service';

function service(mcpNames: string[] = []) {
  return new CatalogService({
    listMcpNames: async () => mcpNames,
    listInstalledPlugins: async () => [],
    skillInstalled: async () => false,
  });
}

describe('CatalogService.list', () => {
  it('returns all 16 seeds with installed=false on an empty state', async () => {
    const out = await service().list();
    expect(out.version).toBe(1);
    expect(out.entries).toHaveLength(16);
    expect(out.entries).toHaveLength(CATALOG_ENTRIES.length);
    expect(out.entries.every((e) => e.installed === false)).toBe(true);
  });

  it('a registered mcp name sets installed', async () => {
    const out = await service(['linear', 'filesystem']).list();
    const installed = out.entries.filter((e) => e.installed).map((e) => e.id);
    expect(installed.sort()).toEqual(['filesystem', 'linear']);
  });

  it('kind filter', async () => {
    const mcp = await service().list({ kind: 'mcp' });
    expect(mcp.entries).toHaveLength(16);
    expect(mcp.entries.every((e) => e.kind === 'mcp')).toBe(true);
    expect((await service().list({ kind: 'plugin' })).entries).toEqual([]);
    expect((await service().list({ kind: 'skill' })).entries).toEqual([]);
  });

  it('local mcp entries get action cli with the pinned command', async () => {
    const out = await service().list();
    const fs = out.entries.find((e) => e.id === 'filesystem');
    expect(fs?.pin.type).toBe('npm');
    expect(fs?.action).toEqual({
      type: 'cli',
      command: 'ethos catalog install filesystem --arg ALLOWED_PATH=<allowed_path>',
    });
    const locals = out.entries.filter((e) => e.pin.type !== 'remote');
    expect(locals).toHaveLength(5);
    expect(locals.every((e) => e.action.type === 'cli')).toBe(true);
  });

  it('oauth entries get action oauth with name = id; auth none gets add', async () => {
    const out = await service().list();
    const linear = out.entries.find((e) => e.id === 'linear');
    expect(linear?.action).toEqual({
      type: 'oauth',
      url: 'https://mcp.linear.app/mcp',
      name: 'linear',
    });
    const oauth = out.entries.filter((e) => e.capabilities.auth === 'oauth');
    expect(oauth.length).toBeGreaterThan(0);
    for (const e of oauth) {
      expect(e.action).toMatchObject({ type: 'oauth', name: e.id });
    }
    const remoteNone = out.entries.filter(
      (e) => e.pin.type === 'remote' && e.capabilities.auth === 'none',
    );
    for (const e of remoteNone) {
      expect(e.action).toMatchObject({ type: 'add', name: e.id });
    }
  });

  it('output parses with CatalogListOutputSchema', async () => {
    const out = await service(['linear']).list();
    expect(CatalogListOutputSchema.safeParse(out).success).toBe(true);
  });
});

describe('catalogSkillInstalled', () => {
  it('checks <dataDir>/catalog-skills/<id> through Storage', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/data/catalog-skills/pdf-tools');
    const check = catalogSkillInstalled(storage, '/data');
    expect(await check('pdf-tools')).toBe(true);
    expect(await check('absent')).toBe(false);
  });
});

const remote = (auth: 'bearer' | 'env' | 'none'): CatalogEntry => ({
  id: 'synthetic',
  kind: 'mcp',
  name: 'Synthetic',
  description: 'd',
  category: 'c',
  publisher: 'p',
  tier: 'community',
  pin: { type: 'remote', url: 'https://x.example/mcp', transport: 'streamable-http' },
  capabilities: { network: ['x.example'], auth, env: [], filesystem: 'none', shell: false },
  license: null,
  reviewedAt: '2026-11-05',
});

describe('actionFor', () => {
  it('remote bearer/env entries get the cli --url form, never a one-click add', () => {
    for (const auth of ['bearer', 'env'] as const) {
      expect(actionFor(remote(auth))).toEqual({
        type: 'cli',
        command: 'ethos mcp add synthetic --url https://x.example/mcp',
      });
    }
    expect(actionFor(remote('none')).type).toBe('add');
  });
});

describe('plugin installed matching', () => {
  const pluginEntry: CatalogEntry = {
    ...remote('none'),
    id: 'cool',
    kind: 'plugin',
    pin: { type: 'npm', package: '@scope/cool', version: '1.0.0', integrity: 'sha512-x' },
    plugin: { pluginId: 'cool' },
  };

  async function installedWith(plugins: Array<{ id: string; name: string }>) {
    const svc = new CatalogService({
      listMcpNames: async () => [],
      listInstalledPlugins: async () => plugins,
      skillInstalled: async () => false,
      entries: [pluginEntry],
    });
    return (await svc.list({ kind: 'plugin' })).entries[0]?.installed;
  }

  it('matches the full scoped package name', async () => {
    expect(await installedWith([{ id: 'cool', name: '@scope/cool' }])).toBe(true);
  });

  it('an unscoped lookalike does not mark it installed', async () => {
    expect(await installedWith([{ id: 'cool', name: 'cool' }])).toBe(false);
  });
});
