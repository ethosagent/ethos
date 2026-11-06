// `ethos catalog install|grant` dispatch (plan §6.3 item 4, §6.5). Every
// installer is a fake: nothing here touches ~/.ethos or the network.

import { CATALOG_ENTRIES } from '@ethosagent/catalog';
import { type CatalogEntry, EthosError } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type CatalogInstallDeps,
  execCatalogGrant,
  execCatalogInstall,
} from '../commands/catalog-install';
import { catalogIntegrityBlock } from '../commands/plugin';

function fakeDeps(over: Partial<CatalogInstallDeps> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const deps: CatalogInstallDeps = {
    addNoAuthRemote: async (...a) => void calls.push(['addNoAuthRemote', ...a]),
    runMcp: async (...a) => void calls.push(['runMcp', ...a]),
    installPlugin: async (...a) => void calls.push(['installPlugin', ...a]),
    installSkill: async (e) => {
      calls.push(['installSkill', e.id]);
      return { installedAs: e.id };
    },
    grantSkill: async (pid, e) => {
      calls.push(['grantSkill', pid, e.id]);
      return { allow: [`catalog/${e.id}`] };
    },
    ...over,
  };
  return { deps, calls };
}

const base: CatalogEntry = {
  id: 'x',
  kind: 'plugin',
  name: 'X',
  description: 'd',
  category: 'Utilities',
  publisher: 'p',
  tier: 'verified',
  pin: { type: 'npm', package: 'ethos-plugin-x', version: '1.2.3', integrity: 'sha512-ABC' },
  capabilities: { network: [], auth: 'none', env: [], filesystem: 'none', shell: false },
  license: 'MIT',
  reviewedAt: '2026-11-01',
  plugin: { pluginId: 'x-plugin' },
};

/** `execCatalogInstall` reads the shipped index, so synthetic kinds are spliced in for the test. */
function withEntry(entry: CatalogEntry, run: () => Promise<void>): Promise<void> {
  const list = CATALOG_ENTRIES as CatalogEntry[];
  list.push(entry);
  return run().finally(() => {
    list.splice(list.indexOf(entry), 1);
  });
}

describe('ethos catalog install: dispatch per kind', () => {
  it('mcp remote, auth none -> the no-auth upsert, and no mcp subcommand', async () => {
    const { deps, calls } = fakeDeps();
    const r = await execCatalogInstall(['deepwiki'], deps);
    expect(r.code).toBe(0);
    expect(calls).toEqual([['addNoAuthRemote', 'deepwiki', 'https://mcp.deepwiki.com/mcp']]);
  });

  it('mcp remote, oauth -> `mcp add <id> --url <url>`', async () => {
    const { deps, calls } = fakeDeps();
    await execCatalogInstall(['linear'], deps);
    expect(calls).toEqual([['runMcp', ['add', 'linear', '--url', 'https://mcp.linear.app/mcp']]]);
  });

  it('mcp local -> `mcp add <id> --preset <id>` carrying --arg and --env in order', async () => {
    const { deps, calls } = fakeDeps();
    const r = await execCatalogInstall(['filesystem', '--arg', 'ALLOWED_PATH=/tmp/x'], deps);
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      ['runMcp', ['add', 'filesystem', '--preset', 'filesystem', '--arg', 'ALLOWED_PATH=/tmp/x']],
    ]);
  });

  it('an unknown --arg or --env key is refused before anything runs', async () => {
    const { deps, calls } = fakeDeps();
    const r = await execCatalogInstall(['filesystem', '--arg', 'NOPE=1'], deps);
    expect(r.code).toBe(1);
    expect(r.stderr[0]).toContain('Unknown --arg NOPE');
    expect(calls).toEqual([]);
  });

  it('--arg on a non-local entry is refused', async () => {
    const { deps, calls } = fakeDeps();
    const r = await execCatalogInstall(['linear', '--arg', 'A=1'], deps);
    expect(r.code).toBe(1);
    expect(calls).toEqual([]);
  });

  it('plugin -> the exact pkg@version, the catalog sha512, the tier, and -y', async () => {
    await withEntry(base, async () => {
      const { deps, calls } = fakeDeps();
      const r = await execCatalogInstall(['x', '-y'], deps);
      expect(r.code).toBe(0);
      expect(calls).toEqual([
        [
          'installPlugin',
          'ethos-plugin-x@1.2.3',
          { yes: true, integrity: 'sha512-ABC', tier: 'verified', json: false },
        ],
      ]);
    });
  });

  it('skill -> installCatalogSkill', async () => {
    const skill: CatalogEntry = {
      ...base,
      id: 'pdf',
      kind: 'skill',
      pin: {
        type: 'git',
        repo: 'https://github.com/a/b',
        commit: 'a'.repeat(40),
        contentDigest: `sha256-${'A'.repeat(43)}=`,
      },
      plugin: undefined,
      skill: { skillName: 'pdf' },
    };
    await withEntry(skill, async () => {
      const { deps, calls } = fakeDeps();
      const r = await execCatalogInstall(['pdf'], deps);
      expect(calls).toEqual([['installSkill', 'pdf']]);
      expect(r.stdout[0]).toBe("Installed skill 'pdf' as pdf");
    });
  });

  it('an unknown id is NOT_FOUND with suggestions; usage errors carry exit 1', async () => {
    const { deps, calls } = fakeDeps();
    const r = await execCatalogInstall(['linea', '--json'], deps);
    expect(r.code).toBe(1);
    expect(r.jsonError?.code).toBe('NOT_FOUND');
    expect(r.stderr[1]).toContain('linear');
    expect((await execCatalogInstall([], deps)).stderr[0]).toMatch(/^Usage: ethos catalog install/);
    expect(calls).toEqual([]);
  });

  it('an installer failure is exit 1 with the EthosError cause and action', async () => {
    const { deps } = fakeDeps({
      installPlugin: vi.fn(async () => {
        throw new EthosError({ code: 'PLUGIN_INSTALL_FAILED', cause: 'boom', action: 'retry it' });
      }),
    });
    await withEntry(base, async () => {
      const r = await execCatalogInstall(['x'], deps);
      expect(r.code).toBe(1);
      expect(r.stderr).toEqual(['boom', '→ retry it']);
      expect(r.stdout).toEqual([]);
    });
  });
});

describe('ethos catalog install: the grant hint matches the kind and nothing is granted', () => {
  it('mcp', async () => {
    const { deps, calls } = fakeDeps();
    const r = await execCatalogInstall(['deepwiki'], deps);
    expect(r.stdout.join('\n')).toContain(
      'ethos personality mcp <personality-id> --attach deepwiki',
    );
    expect(calls.map((c) => c[0])).not.toContain('grantSkill');
  });

  it('plugin names the plugin id, skill names catalog grant', async () => {
    await withEntry(base, async () => {
      const r = await execCatalogInstall(['x'], fakeDeps().deps);
      expect(r.stdout.join('\n')).toContain(
        'ethos personality plugins <personality-id> --attach x-plugin',
      );
    });
    const skill: CatalogEntry = { ...base, id: 'pdf', kind: 'skill', plugin: undefined };
    await withEntry(skill, async () => {
      const { deps, calls } = fakeDeps();
      const r = await execCatalogInstall(['pdf'], deps);
      expect(r.stdout.join('\n')).toContain(
        'ethos catalog grant pdf --personality <personality-id>',
      );
      expect(calls.map((c) => c[0])).toEqual(['installSkill']);
    });
  });

  it('--json carries the grant commands', async () => {
    const r = await execCatalogInstall(['deepwiki', '--json'], fakeDeps().deps);
    expect(r.json).toEqual({
      ok: true,
      id: 'deepwiki',
      kind: 'mcp',
      grant: ['ethos personality mcp <personality-id> --attach deepwiki'],
    });
  });
});

describe('ethos catalog grant', () => {
  const skill: CatalogEntry = { ...base, id: 'pdf', kind: 'skill', plugin: undefined };

  it('grants a skill to one personality', async () => {
    await withEntry(skill, async () => {
      const { deps, calls } = fakeDeps();
      const r = await execCatalogGrant(['pdf', '--personality', 'sage'], deps);
      expect(r.code).toBe(0);
      expect(calls).toEqual([['grantSkill', 'sage', 'pdf']]);
      expect(r.stdout[0]).toContain('catalog/pdf');
    });
  });

  it('is skill-only, and needs --personality', async () => {
    const { deps, calls } = fakeDeps();
    const mcp = await execCatalogGrant(['linear', '--personality', 'sage'], deps);
    expect(mcp.code).toBe(1);
    expect(mcp.stderr.join('\n')).toContain('ethos personality mcp');
    await withEntry(skill, async () => {
      const r = await execCatalogGrant(['pdf'], deps);
      expect(r.code).toBe(1);
      expect(r.stderr[0]).toMatch(/^Usage: ethos catalog grant/);
    });
    expect(calls).toEqual([]);
  });

  it('a refusal from the registry (built-in) is exit 1 with its cause', async () => {
    await withEntry(skill, async () => {
      const { deps } = fakeDeps({
        grantSkill: async () => {
          throw new EthosError({
            code: 'PERSONALITY_READ_ONLY',
            cause: 'built-in',
            action: 'duplicate it',
          });
        },
      });
      const r = await execCatalogGrant(['pdf', '--personality', 'researcher'], deps);
      expect(r.code).toBe(1);
      expect(r.stderr).toEqual(['built-in', '→ duplicate it']);
    });
  });
});

describe('catalog plugin integrity', () => {
  it('blocks a scanned tarball whose sha512 differs from the catalog pin, and passes an equal one', () => {
    expect(catalogIntegrityBlock('sha512-AAA', 'sha512-AAA')).toBeNull();
    expect(catalogIntegrityBlock('sha512-BBB', 'sha512-AAA')).toContain(
      'PLUGIN_INTEGRITY_MISMATCH',
    );
  });
});
